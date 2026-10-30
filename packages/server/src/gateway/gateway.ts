import { randomBytes } from 'node:crypto';
import { verifyMessage, verifyTypedData, type TypedDataDefinition } from 'viem';
import {
  AUTH_PREFIX,
  MAX_CLIENT_FRAME_BYTES,
  addressKey,
  commitTypedData,
  grantProblem,
  grantTypedData,
  revealTypedData,
  type SignedGrant,
  type AvatarCollectionInfo,
  type ClientMessage,
  type CommitReceipt,
  type LobbyInfo,
  type MatchSummary,
  type MoveAim,
  type ServerMessage,
  type SpokeInfo,
  type StakingInfo,
  type ZapInfo,
} from '@lms/protocol';
import type { Lobby } from '../lobby/lobby.js';
import type { ArchivedMatch, MatchArchive } from '../lobby/store.js';
import { RequestError } from '../errors.js';
import { FrameError, errorFrame, parseClientMessage } from './frames.js';
import { CloseCode, DEFAULT_GATEWAY_LIMITS, KeyedLimiter, TokenBucket, type GatewayLimits } from './limits.js';
import type { Client } from '../match/room.js';
import { AnalystError, classify, type MatchAnalyst } from '../analyst/analyst.js';

/**
 * Checks a login signature against an address.
 *
 * Injected rather than fixed, because the two cases need different machinery.
 * A plain EOA is verified with `ecrecover` and no network at all, which is what
 * practice-only mode runs on. An account that has delegated under EIP-7702
 * signs its logins with a *session key*, so the signature does not recover to
 * the account address and only the account itself can say whether it is valid —
 * an ERC-1271 `isValidSignature` call, which needs an RPC.
 */
export type SignatureVerifier = (args: {
  address: `0x${string}`;
  message: string;
  signature: `0x${string}`;
}) => Promise<boolean>;

/** `SignatureVerifier` for EIP-712 typed data. */
export type TypedSignatureVerifier = (
  args: TypedDataDefinition & { address: `0x${string}`; signature: `0x${string}` },
) => Promise<boolean>;

/**
 * The slice of `ws` the gateway actually uses, so tests can supply a fake.
 *
 * Two named methods rather than an overloaded `on`: an overload set is not
 * structurally satisfiable by a simple fake, so every implementation — the
 * real `ws` in `main.ts` and the `FakeSocket` in the tests — had to be cast
 * into place. `ws` satisfies this shape directly.
 */
export interface Socket {
  readyState: number;
  send(data: string): void;
  onMessage(listener: (data: unknown) => void): void;
  onClose(listener: () => void): void;
  /** Closes the connection. Optional so a test fake can leave it out. */
  close?(code: number, reason: string): void;
  /** Bytes queued but not yet written. Optional for the same reason. */
  readonly bufferedAmount?: number;
}

/** Who is on the other end, as far as the HTTP upgrade can tell. */
export interface Peer {
  /** Remote IP, or the forwarded client IP behind a trusted proxy. */
  ip?: string;
  /** The handshake's `Origin` header, if any. */
  origin?: string;
}

const OPEN = 1;

/** Matches per `history` page. */
export const HISTORY_PAGE = 20;

interface Session extends Client {
  readonly nonce: string;
  readonly socket: Socket;
  readonly ip: string;
  readonly connectedAt: number;
  /** General messages. */
  readonly messages: TokenBucket;
  /** Commits and reveals, kept apart so other traffic cannot starve them. */
  readonly moves: TokenBucket;
  /** Misbehaviour; empty closes the socket. */
  readonly strikes: TokenBucket;
  loginFailures: number;
  /** The grant this socket logged in with. Null for a login without one, which may watch but not play. */
  grant: SignedGrant | null;
  closed: boolean;
  /** The analysis being written for this socket, if any; aborted if it closes. */
  analysis: AbortController | null;
}

export interface GatewayOptions {
  lobby: Lobby;
  chainId: number;
  /** Hub escrow, so the client knows where to stake. Null in practice-only mode. */
  escrow?: `0x${string}` | null;
  /** Avatar collections, so the client knows where to mint on its own chain. */
  avatarCollections?: AvatarCollectionInfo[];
  /** 7702 delegate the client may grant a session key against. */
  sessionDelegate?: `0x${string}` | null;
  /** Token payment through `ZapJoin`. Null or omitted offers ETH only. */
  zap?: ZapInfo | null;
  /** Spoke chains a player may stake from. Omitted or empty is hub-only. */
  spokes?: SpokeInfo[];
  /** The hub `LayerZeroMessenger`, for proposals that register a spoke. */
  hubMessenger?: `0x${string}` | null;
  /** Staking vault and governor. Null or omitted hides the staking panel. */
  staking?: StakingInfo | null;
  /** Finished matches, for `history` and `review`. Omitted, both answer that there is no archive. */
  archive?: MatchArchive;
  /** Writes post-match analyses. Omitted, `analyze` answers "unavailable". */
  analyst?: MatchAnalyst;
  /** Lobby directory from the chain bridge. Empty when running without an RPC. */
  directory: () => { open: LobbyInfo[]; live: LobbyInfo[] };
  /**
   * How login signatures are checked. Defaults to offline `ecrecover`, which
   * accepts EOAs only; supply an RPC-backed verifier to also accept session
   * keys from 7702-delegated accounts.
   */
  verify?: SignatureVerifier;
  /**
   * How a wallet's signature over a session grant is checked. Defaults to
   * offline recovery; supply one that falls back to ERC-1271 over RPC to
   * accept grants from contract wallets.
   */
  verifyGrant?: TypedSignatureVerifier;
  /**
   * How a session key's signatures are checked: its login, and every move.
   * Session keys are plain keys, so this never needs an RPC. Defaults to
   * recovery on the event loop; `main.ts` hands it the worker pool.
   */
  verifyKey?: { message: SignatureVerifier; typed: TypedSignatureVerifier };
  /**
   * Signs commit receipts. Omitted, commits are taken without one, and the
   * client cannot later prove the server had its move.
   */
  receipts?: ReceiptSigner;
  /** Overrides for `DEFAULT_GATEWAY_LIMITS`. */
  limits?: Partial<GatewayLimits>;
  /** Wall clock, injectable for tests. */
  now?: () => number;
}

/** The server key that signs commit receipts, and its address for the client to check them against. */
export interface ReceiptSigner {
  address: `0x${string}`;
  sign(receipt: CommitReceipt): Promise<`0x${string}`>;
}

/** Stands in for the IP of a socket the transport could not identify. */
const UNKNOWN_IP = 'unknown';

/**
 * Translates socket frames into room calls.
 *
 * Login is a signed nonce rather than a session cookie: the wallet is the
 * identity. With a session grant, the wallet's signature over the grant proves
 * control of the address that staked, and the granted key's signature over the
 * nonce proves this socket holds the key; that key then signs every move.
 * Nothing here trusts a client-supplied address on its own.
 *
 * Every limit is enforced here rather than in `main.ts`, so the tests exercise
 * the same code the server runs. The transport supplies only what it alone
 * knows — the peer's IP and origin — and a `close` to call.
 */
export class Gateway {
  private readonly sessions = new Map<Socket, Session>();
  private readonly limits: GatewayLimits;
  private readonly perIp = new Map<string, number>();
  private readonly connectsByIp: KeyedLimiter;
  private readonly loginsByIp: KeyedLimiter;
  /**
   * A room sends the same message object to every client at its table, so it
   * is serialised once, not once per socket. Weak, so a message is forgotten
   * as soon as the room is done with it.
   */
  private readonly encoded = new WeakMap<ServerMessage, string>();

  constructor(private readonly options: GatewayOptions) {
    this.limits = { ...DEFAULT_GATEWAY_LIMITS, ...options.limits };
    const l = this.limits;
    this.connectsByIp = new KeyedLimiter(l.connectRatePerIp, l.connectBurstPerIp);
    this.loginsByIp = new KeyedLimiter(l.loginRatePerIp, l.loginBurstPerIp);
  }

  get connections(): number {
    return this.sessions.size;
  }

  /**
   * Admits a new socket, or closes it at once.
   *
   * @returns Whether the socket was admitted.
   */
  accept(socket: Socket, peer: Peer = {}): boolean {
    const now = this.now();
    const ip = peer.ip ?? UNKNOWN_IP;
    const refusal = this.admission(ip, peer.origin, now);
    if (refusal) {
      socket.close?.(refusal.code, refusal.reason);
      return false;
    }

    const l = this.limits;
    const session: Session = {
      socket,
      ip,
      connectedAt: now,
      address: null,
      nonce: randomBytes(16).toString('hex'),
      send: (message) => this.write(session, message),
      messages: new TokenBucket(l.messageRate, l.messageBurst, now),
      moves: new TokenBucket(l.moveRate, l.moveBurst, now),
      strikes: new TokenBucket(l.strikeRate, l.strikeBurst, now),
      loginFailures: 0,
      grant: null,
      closed: false,
      analysis: null,
    };
    this.sessions.set(socket, session);
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);

    session.send({
      type: 'hello',
      nonce: session.nonce,
      chainId: this.options.chainId,
      escrow: this.options.escrow ?? null,
      avatarCollections: this.options.avatarCollections ?? [],
      sessionDelegate: this.options.sessionDelegate ?? null,
      zap: this.options.zap ?? null,
      staking: this.options.staking ?? null,
      analyst: this.options.analyst !== undefined,
      spokes: this.options.spokes ?? [],
      receiptSigner: this.options.receipts?.address ?? null,
      hubMessenger: this.options.hubMessenger ?? null,
    });

    socket.onMessage((data: unknown) => this.receive(session, String(data)));
    socket.onClose(() => this.forget(session));
    return true;
  }

  /**
   * Housekeeping, driven from the server's ticker: closes sockets that never
   * logged in, and forgets rate-limit state that has refilled. Safe to call at
   * any frequency.
   */
  sweep(now: number = this.now()): void {
    for (const session of this.sessions.values()) {
      if (session.address === null && now - session.connectedAt >= this.limits.loginTimeoutMs) {
        this.drop(session, CloseCode.PolicyViolation, 'login timed out');
      }
    }
    this.connectsByIp.sweep(now);
    this.loginsByIp.sweep(now);
  }

  /**
   * Sends a message to every socket logged in as `address`, and to nobody
   * else. For news that belongs to one wallet, such as how its cross-chain
   * join landed; a player who is not connected simply misses it.
   */
  notify(address: `0x${string}`, message: ServerMessage): void {
    const key = addressKey(address);
    for (const session of this.sessions.values()) {
      if (session.address !== null && addressKey(session.address) === key) session.send(message);
    }
  }

  /** Why a new socket is refused, or null to admit it. Checked cheapest first. */
  private admission(ip: string, origin: string | undefined, now: number): { code: number; reason: string } | null {
    const l = this.limits;
    if (l.allowedOrigins.length > 0 && !(origin && l.allowedOrigins.includes(origin))) {
      return { code: CloseCode.PolicyViolation, reason: 'origin not allowed' };
    }
    if (this.sessions.size >= l.maxConnections) {
      return { code: CloseCode.TryAgainLater, reason: 'server is full' };
    }
    if ((this.perIp.get(ip) ?? 0) >= l.maxConnectionsPerIp) {
      return { code: CloseCode.TryAgainLater, reason: 'too many connections from this address' };
    }
    if (!this.connectsByIp.take(ip, now)) {
      return { code: CloseCode.TryAgainLater, reason: 'connecting too fast' };
    }
    return null;
  }

  private receive(session: Session, raw: string): void {
    if (session.closed) return;
    if (raw.length > MAX_CLIENT_FRAME_BYTES) {
      this.reject(session, new FrameError('message too large'));
      return;
    }

    let message: ClientMessage;
    try {
      message = parseClientMessage(raw);
    } catch (error) {
      this.reject(session, error);
      return;
    }

    const now = this.now();
    const bucket = message.type === 'commit' || message.type === 'reveal' ? session.moves : session.messages;
    if (!bucket.take(now)) {
      this.reject(session, new RequestError('RATE_LIMITED', 'slow down: too many messages'));
      return;
    }

    void this.dispatch(session, message, now).catch((error: unknown) => {
      session.send(errorFrame(error));
    });
  }

  /** Answers a frame the gateway refused, and counts it against the socket. */
  private reject(session: Session, error: unknown): void {
    session.send(errorFrame(error));
    if (!session.strikes.take(this.now())) {
      this.drop(session, CloseCode.PolicyViolation, 'too many rejected messages');
    }
  }

  private async dispatch(session: Session, message: ClientMessage, now: number): Promise<void> {
    if (message.type === 'auth') {
      await this.login(session, message);
      return;
    }

    const address = session.address;
    if (!address) throw new RequestError('NOT_AUTHENTICATED', 'authenticate before acting');

    switch (message.type) {
      case 'lobbies': {
        const directory = this.options.directory?.() ?? { open: [], live: [] };
        session.send({ type: 'lobbies', open: directory.open, live: directory.live });
        return;
      }
      case 'practice': {
        const room = this.options.lobby.createPractice(address, message.bots ?? 3, now, message.difficulty);
        room.attach(session);
        return;
      }
      case 'watch': {
        this.options.lobby.attach(message.matchId, session);
        return;
      }
      case 'analyze': {
        await this.analyze(session, address, message.matchId);
        return;
      }
      case 'history': {
        // Always the authenticated wallet's own: there is no field to ask for anyone else's.
        const archive = this.requireArchive();
        const found = await archive.forPlayer(address, HISTORY_PAGE + 1, message.before);
        session.send({
          type: 'history',
          matches: found.slice(0, HISTORY_PAGE).map((match) => summarise(match, address)),
          before: message.before ?? null,
          more: found.length > HISTORY_PAGE,
        });
        return;
      }
      case 'review': {
        await this.review(session, address, message.matchId);
        return;
      }
      case 'commit': {
        const grant = this.requireGrant(session);
        const room = this.requireRoom(address);
        const place = { ...aimOf(message), seat: room.seatOf(address) ?? -1 };
        await this.requireKeySigned(grant, commitTypedData(this.options.chainId, place, message.commitment), message.signature);
        const hold = message.hold;
        if (hold) await this.requireKeySigned(grant, revealTypedData(this.options.chainId, place, hold), hold.signature);
        // The clock is read again: the signature checks took time, and the
        // room compares against its own deadlines.
        const receipt = room.submitCommit(
          address,
          message.commitment,
          this.now(),
          hold ? { action: hold.action, target: hold.target, salt: hold.salt } : undefined,
          aimOf(message),
          { grant, signature: message.signature, ...(hold ? { holdSignature: hold.signature } : {}) },
        );
        const signer = this.options.receipts;
        if (signer) session.send({ type: 'receipt', receipt, signature: await signer.sign(receipt) });
        return;
      }
      case 'reveal': {
        const grant = this.requireGrant(session);
        const room = this.requireRoom(address);
        const move = { action: message.action, target: message.target, salt: message.salt };
        const place = { ...aimOf(message), seat: room.seatOf(address) ?? -1 };
        await this.requireKeySigned(grant, revealTypedData(this.options.chainId, place, move), message.signature);
        room.submitReveal(address, move, this.now(), aimOf(message), { grant, signature: message.signature });
        return;
      }
    }
  }

  private async login(session: Session, message: Extract<ClientMessage, { type: 'auth' }>): Promise<void> {
    // Before the verifier, because a session-key login costs an RPC call.
    if (!this.loginsByIp.take(session.ip, this.now())) {
      throw new RequestError('RATE_LIMITED', 'too many login attempts; try again shortly');
    }
    const text = `${AUTH_PREFIX}${session.nonce}`;
    const grant = message.grant ?? null;
    if (grant) {
      await this.checkGrant(session, message.address, grant);
      // The key, not the wallet, signs the nonce: that is what proves this
      // socket holds the key, so a grant copied off the wire is useless alone.
      const verify = this.options.verifyKey?.message ?? offlineVerify;
      const valid = await verify({ address: grant.grant.sessionKey, message: text, signature: message.signature });
      if (!valid) this.failLogin(session, new RequestError('BAD_SIGNATURE', 'login signature is not from the granted key'));
    } else {
      const verify = this.options.verify ?? offlineVerify;
      const valid = await verify({ address: message.address, message: text, signature: message.signature });
      if (!valid) this.failLogin(session, new RequestError('BAD_SIGNATURE', 'login signature does not match the nonce'));
    }
    session.address = message.address;
    session.grant = grant;
    session.send({ type: 'authed', address: message.address });
  }

  /** Throws unless `signed` is a usable grant from `wallet`. */
  private async checkGrant(session: Session, wallet: `0x${string}`, signed: SignedGrant): Promise<void> {
    if (addressKey(signed.grant.wallet) !== addressKey(wallet)) {
      this.failLogin(session, new RequestError('BAD_GRANT', 'the grant is for another wallet'));
    }
    const problem = grantProblem(signed.grant, {
      chainId: this.options.chainId,
      now: Math.floor(this.now() / 1000),
      origins: this.limits.allowedOrigins,
    });
    if (problem) this.failLogin(session, new RequestError('BAD_GRANT', problem));
    const verify = this.options.verifyGrant ?? offlineVerifyTyped;
    const valid = await verify({ address: wallet, ...grantTypedData(signed.grant), signature: signed.signature });
    if (!valid) this.failLogin(session, new RequestError('BAD_GRANT', 'the grant is not signed by its wallet'));
  }

  /** Counts a failed login against the socket, and throws `error`. */
  private failLogin(session: Session, error: RequestError): never {
    session.loginFailures += 1;
    if (session.loginFailures >= this.limits.maxLoginFailures) {
      this.drop(session, CloseCode.PolicyViolation, 'too many failed logins');
    }
    throw error;
  }

  /** Throws unless the grant's session key signed `data`. */
  private async requireKeySigned(
    signed: SignedGrant,
    data: TypedDataDefinition,
    signature: `0x${string}`,
  ): Promise<void> {
    const verify = this.options.verifyKey?.typed ?? offlineVerifyTyped;
    const valid = await verify({ ...data, address: signed.grant.sessionKey, signature });
    if (!valid) throw new RequestError('BAD_SIGNATURE', 'the move is not signed by your session key');
  }

  /**
   * Writes an analysis for one socket. Failures go out as `analysis.error`,
   * not `error`, so the client can tell them apart from a refused move.
   */
  private async analyze(session: Session, address: `0x${string}`, matchId: `0x${string}`): Promise<void> {
    const fail = (error: AnalystError) =>
      session.send({ type: 'analysis.error', matchId, code: error.code, message: error.message });

    const analyst = this.options.analyst;
    if (!analyst) {
      fail(new AnalystError('unavailable', 'match analysis is not available on this server'));
      return;
    }
    // One at a time per socket: each costs real money, and the panel shows one.
    if (session.analysis) {
      fail(new AnalystError('busy', 'an analysis is already being written for you'));
      return;
    }

    const controller = new AbortController();
    session.analysis = controller;
    try {
      const { analysis, cached } = await analyst.analyze({
        matchId,
        requester: address,
        signal: controller.signal,
        onStep: (step) => session.send({ type: 'analysis.step', matchId, step }),
      });
      session.send({ type: 'analysis.done', analysis, cached });
    } catch (error) {
      if (!session.closed) fail(classify(error));
    } finally {
      session.analysis = null;
    }
  }

  /**
   * Sends a finished match back to someone allowed to see it: anyone for a
   * staked match, which was public while it ran; only its players for a
   * practice match. The same rule the analyst applies.
   */
  private async review(session: Session, address: `0x${string}`, matchId: `0x${string}`): Promise<void> {
    const match = await this.requireArchive().load(matchId);
    if (!match) throw new RequestError('NOT_FOUND', 'no finished match with that id');
    const seated = match.seats.some((seat) => addressKey(seat.address) === addressKey(address));
    if (!seated && !match.staked) throw new RequestError('FORBIDDEN', 'only the players who sat in this match can open it');
    session.send({
      type: 'review',
      match: {
        result: match.result,
        history: [...match.history],
        seats: [...match.seats],
        rules: match.rules,
        seed: match.seed,
        staked: match.staked,
        settledTx: (match.settledTx as `0x${string}` | null) ?? null,
        finishedAt: match.finishedAt,
      },
    });
  }

  /**
   * The grant a socket plays under. A grant can expire mid-connection; a move
   * signed after that is refused, and the client logs in again with a new one.
   */
  private requireGrant(session: Session): SignedGrant {
    const grant = session.grant;
    if (!grant) throw new RequestError('NO_GRANT', 'log in with a session grant to play');
    if (grant.grant.expiresAt * 1000 <= this.now()) throw new RequestError('BAD_GRANT', 'the session grant has expired');
    return grant;
  }

  private requireArchive(): MatchArchive {
    const archive = this.options.archive;
    if (!archive) throw new RequestError('UNAVAILABLE', 'match history is not kept on this server');
    return archive;
  }

  private requireRoom(address: `0x${string}`) {
    const room = this.options.lobby.roomFor(address);
    if (!room) throw new RequestError('NOT_SEATED', 'you are not in a live match');
    return room;
  }

  private write(session: Session, message: ServerMessage): void {
    const socket = session.socket;
    if (session.closed || socket.readyState !== OPEN) return;
    // A client that stops reading would otherwise have its backlog held in
    // server memory indefinitely.
    if ((socket.bufferedAmount ?? 0) > this.limits.maxBufferedBytes) {
      this.drop(session, CloseCode.PolicyViolation, 'not reading fast enough');
      return;
    }
    let data = this.encoded.get(message);
    if (data === undefined) {
      data = JSON.stringify(message);
      this.encoded.set(message, data);
    }
    socket.send(data);
  }

  /** Closes a socket from this side. Cleans up even if the socket never reports the close. */
  private drop(session: Session, code: number, reason: string): void {
    if (session.closed) return;
    session.socket.close?.(code, reason);
    this.forget(session);
  }

  private forget(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    // Nobody is left to read it; stop paying for it.
    session.analysis?.abort();
    for (const room of this.options.lobby.list()) room.detach(session);
    this.sessions.delete(session.socket);
    const count = (this.perIp.get(session.ip) ?? 1) - 1;
    if (count > 0) this.perIp.set(session.ip, count);
    else this.perIp.delete(session.ip);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function aimOf(message: MoveAim): MoveAim {
  return { matchId: message.matchId, round: message.round };
}

/** `ecrecover` only: no network, and therefore no ERC-1271. */
const offlineVerify: SignatureVerifier = (args) => verifyMessage(args);

const offlineVerifyTyped: TypedSignatureVerifier = (args) => verifyTypedData(args).catch(() => false);

/** One archived match as its player sees it in their history. */
export function summarise(match: ArchivedMatch, player: `0x${string}`): MatchSummary {
  const key = addressKey(player);
  const place = match.result.ranking.findIndex((address) => addressKey(address) === key);
  return {
    matchId: match.result.matchId,
    finishedAt: match.finishedAt,
    rounds: match.result.rounds,
    players: match.result.ranking.length,
    seat: match.seats.find((seat) => addressKey(seat.address) === key)?.index ?? null,
    place: place + 1,
    staked: match.staked,
    settledTx: (match.settledTx as `0x${string}` | null) ?? null,
  };
}
