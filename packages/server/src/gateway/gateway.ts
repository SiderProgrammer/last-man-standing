import { randomBytes } from 'node:crypto';
import type { TypedDataDefinition } from 'viem';
import {
  addressKey,
  commitTypedData,
  grantProblem,
  grantTypedData,
  revealTypedData,
  type SignedGrant,
  type CommitReceipt,
} from '@lms/consensus';
import {
  AUTH_PREFIX,
  MAX_CLIENT_FRAME_BYTES,
  type AvatarCollectionInfo,
  type ClientMessage,
  type LobbyInfo,
  type MatchSummary,
  type MoveAim,
  type RelayKind,
  type ServerMessage,
  type SpokeInfo,
  type StakingInfo,
  type ZapInfo,
} from '@lms/api';
import type { Lobby } from '../lobby/lobby.js';
import { seatIn, type ArchivedMatch, type MatchArchive } from '../lobby/store.js';
import { RequestError } from '../errors.js';
import { FrameError, errorFrame, parseClientMessage } from './frames.js';
import { CloseCode, DEFAULT_GATEWAY_LIMITS, KeyedLimiter, TokenBucket, type GatewayLimits } from './limits.js';
import { offlineVerify, offlineVerifyTyped } from './verifyPool.js';
import type { Client } from '../match/room.js';
import { AnalystError, classify, type MatchAnalyst } from '../analyst/analyst.js';
import type { ChainWithdrawals } from '../chain/chainWithdrawals.js';
import type { SessionRelay } from '../chain/sessionRelay.js';
import type { Matchmaker } from '../lobby/matchmaker.js';

/**
 * Checks a login signature against an address.
 *
 * Injected rather than fixed, because the two cases need different machinery.
 * A plain EOA is verified with `ecrecover` and no network at all, which is what
 * practice-only mode runs on. A contract wallet's signature does not recover
 * to its address, and only the wallet itself can say whether it is valid — an
 * ERC-1271 `isValidSignature` call, which needs an RPC. A 7702-delegated
 * account answers that for its own key only, never for a session key.
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
  /** This socket put its wallet in the matchmaking queue; it leaves if the last such socket closes. */
  queued: boolean;
}

export interface GatewayOptions {
  lobby: Lobby;
  chainId: number;
  /** Hub escrow, so the client knows where to stake. Null in practice-only mode. */
  escrow?: `0x${string}` | null;
  /** Avatar collections, so the client knows where to mint on its own chain. */
  avatarCollections?: AvatarCollectionInfo[];
  /**
   * Submits calls players' session keys signed. Omitted, the server offers no
   * one-click play, and `hello` names no delegate.
   */
  relay?: SessionRelay;
  /**
   * Submits withdrawals to a spoke that players signed. Omitted, `hello`
   * says the server offers none, and `balance` and `withdrawToChain` are
   * refused.
   */
  withdrawals?: ChainWithdrawals;
  /**
   * The matchmaking queue. Omitted, `hello` lists no tiers, `queue` is
   * refused, and every lobby is one a player opened.
   */
  matchmaker?: Matchmaker;
  /** Token payment through `ZapJoin`. Null or omitted offers ETH only. */
  zap?: ZapInfo | null;
  /** Spoke chains a player may stake from. Omitted or empty is hub-only. */
  spokes?: SpokeInfo[];
  /** Staking vault and governor. Null or omitted hides the staking panel. */
  staking?: StakingInfo | null;
  /** Finished matches, for `history` and `review`. Omitted, both answer that there is no archive. */
  archive?: MatchArchive;
  /**
   * Staked results read from the chain: they fill in "Your matches" for any
   * the archive no longer holds, as an in-memory one after a restart.
   */
  results?: { forPlayer(address: `0x${string}`, limit: number, before?: number): MatchSummary[] };
  /** Resolves the avatar a wallet wears on a chain, for `avatar`. Omitted, every wallet wears none. */
  avatars?: { resolve(subjects: ReadonlyArray<{ index: number; address: `0x${string}`; chainId: number }>): Promise<Array<{ tokenId: string; image: string | null }>> };
  /** Writes post-match analyses. Omitted, `analyze` answers "unavailable". */
  analyst?: MatchAnalyst;
  /** Lobby directory from the chain bridge. Empty when running without an RPC. */
  directory: () => { open: LobbyInfo[]; live: LobbyInfo[] };
  /**
   * How login signatures are checked. Defaults to offline `ecrecover`, which
   * accepts EOAs only; supply an RPC-backed verifier to also accept contract
   * wallets through ERC-1271.
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
   * Signs staked rooms' commit receipts: the attestor. Omitted, those commits
   * are taken without one, and the client cannot later prove the server had
   * its move.
   */
  receipts?: ReceiptSigner;
  /** Signs practice rooms' commit receipts. Never the attestor: see `hello.practiceReceiptSigner`. */
  practiceReceipts?: ReceiptSigner;
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
  /** The directory `publishLobbies` last pushed, serialised: unchanged, nothing is sent. */
  private publishedDirectory = '';

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
      queued: false,
    };
    this.sessions.set(socket, session);
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);

    session.send({
      type: 'hello',
      nonce: session.nonce,
      chainId: this.options.chainId,
      escrow: this.options.escrow ?? null,
      avatarCollections: this.options.avatarCollections ?? [],
      sessionDelegate: this.options.relay?.delegate ?? null,
      relayQuota: this.options.relay?.quotaPerDay ?? 0,
      zap: this.options.zap ?? null,
      staking: this.options.staking ?? null,
      analyst: this.options.analyst !== undefined,
      spokes: this.options.spokes ?? [],
      receiptSigner: this.options.receipts?.address ?? null,
      practiceReceiptSigner: this.options.practiceReceipts?.address ?? null,
      matchmaking: [...(this.options.matchmaker?.tiers ?? [])],
      withdrawToChain: this.options.withdrawals !== undefined,
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
    for (const session of this.sessionsOf(address)) session.send(message);
  }

  /**
   * Pushes the lobby directory to every logged-in socket, if it changed since
   * the last push. Driven from the server's ticker, so a lobby someone else
   * opened — the matchmaker's above all, whose players are told to stake into
   * it — shows up without anyone pressing Refresh.
   */
  publishLobbies(): void {
    const directory = this.options.directory();
    const key = JSON.stringify(directory);
    if (key === this.publishedDirectory) return;
    this.publishedDirectory = key;
    // One object for every socket, so it is serialised once.
    const message: ServerMessage = { type: 'lobbies', open: directory.open, live: directory.live };
    for (const session of this.sessions.values()) {
      if (session.address !== null) session.send(message);
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
        this.options.lobby.attach(room.matchId, session, now);
        return;
      }
      case 'watch': {
        this.options.lobby.attach(message.matchId, session, now);
        return;
      }
      case 'analyze': {
        await this.analyze(session, address, message.matchId);
        return;
      }
      case 'history': {
        await this.history(session, address, message.before);
        return;
      }
      case 'review': {
        await this.review(session, address, message.matchId);
        return;
      }
      case 'relay': {
        const relay = this.options.relay;
        await this.answerRelayed(session, message.id, relay ? () => relay.relay(address, message.call) : null, 'this server relays no session calls');
        return;
      }
      case 'balance': {
        await this.balance(session, address);
        return;
      }
      case 'avatar': {
        const [found] = (await this.options.avatars?.resolve([{ index: 0, address, chainId: message.chainId }])) ?? [];
        session.send({
          type: 'avatar',
          chainId: message.chainId,
          avatar: found ? { tokenId: found.tokenId, image: found.image } : null,
        });
        return;
      }
      case 'withdrawToChain': {
        const withdrawals = this.options.withdrawals;
        const submit = withdrawals
          ? async () => ({ ...(await withdrawals.submit(address, message)), kind: 'withdrawToChain' as const })
          : null;
        await this.answerRelayed(session, message.id, submit, 'this server bridges no withdrawals');
        return;
      }
      case 'queue': {
        const matchmaker = this.options.matchmaker;
        if (!matchmaker) throw new RequestError('UNAVAILABLE', 'this server runs no matchmaking');
        // `queued` goes to every socket of the wallet, this one included.
        matchmaker.join(address, message.stake, message.seats);
        session.queued = true;
        return;
      }
      case 'dequeue': {
        this.options.matchmaker?.leave(address);
        session.queued = false;
        session.send({ type: 'dequeued' });
        return;
      }
      case 'commit': {
        await this.commit(session, address, message);
        return;
      }
      case 'reveal': {
        await this.reveal(session, address, message);
        return;
      }
    }
  }

  /**
   * Takes a commitment, and with it a held move, once the session key is
   * shown to have signed both; then answers with the server's receipt.
   */
  private async commit(
    session: Session,
    address: `0x${string}`,
    message: Extract<ClientMessage, { type: 'commit' }>,
  ): Promise<void> {
    const { grant, room, place } = this.movePlace(session, address, message);
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
    const signer = room.staked ? this.options.receipts : this.options.practiceReceipts;
    // Not before the commit is in the room's journal: a receipt for a
    // commit a restart could lose would be a promise the server cannot keep.
    await this.options.lobby.persisted(room.matchId);
    if (signer) session.send({ type: 'receipt', receipt, signature: await signer.sign(receipt) });
  }

  /** Takes a reveal, once the session key is shown to have signed it. */
  private async reveal(
    session: Session,
    address: `0x${string}`,
    message: Extract<ClientMessage, { type: 'reveal' }>,
  ): Promise<void> {
    const { grant, room, place } = this.movePlace(session, address, message);
    const move = { action: message.action, target: message.target, salt: message.salt };
    await this.requireKeySigned(grant, revealTypedData(this.options.chainId, place, move), message.signature);
    room.submitReveal(address, move, this.now(), aimOf(message), { grant, signature: message.signature });
  }

  /** The grant a move is signed under, the room it is for, and the match, round and seat it names. */
  private movePlace(session: Session, address: `0x${string}`, aim: MoveAim) {
    const grant = this.requireGrant(session);
    const room = this.requireRoom(address, aim.matchId);
    return { grant, room, place: { ...aimOf(aim), seat: room.seatOf(address) ?? -1 } };
  }

  /** A page of the wallet's own finished matches: there is no field to ask for anyone else's. */
  private async history(session: Session, address: `0x${string}`, before: number | undefined): Promise<void> {
    const results = this.options.results;
    if (!this.options.archive && !results) this.requireArchive();
    const archived = this.options.archive
      ? (await this.options.archive.forPlayer(address, HISTORY_PAGE + 1, before)).map((match) => summarise(match, address))
      : [];
    const matches = mergeHistory(archived, results?.forPlayer(address, HISTORY_PAGE + 1, before) ?? []);
    session.send({
      type: 'history',
      matches: matches.slice(0, HISTORY_PAGE),
      before: before ?? null,
      more: matches.length > HISTORY_PAGE,
    });
  }

  /** The wallet's hub balance, and what a withdrawal of it to a spoke must carry. */
  private async balance(session: Session, address: `0x${string}`): Promise<void> {
    const withdrawals = this.options.withdrawals;
    if (!withdrawals) throw new RequestError('UNAVAILABLE', 'this server bridges no withdrawals');
    const balance = await withdrawals.balance(address);
    session.send({
      type: 'balance',
      amount: balance.amount.toString(),
      receiver: balance.receiver,
      withdrawalNonce: balance.nonce.toString(),
      minimum: balance.minimum.toString(),
      chainTime: balance.chainTime,
    });
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
   * Sends one transaction for the socket's own wallet — a session call, or a
   * signed withdrawal to a spoke — with the server paying the gas. Answered on
   * `relayed` or `relay.error` frames, by `id`, because it takes a block to
   * land and the client may have more than one in flight.
   *
   * @param send Null when the server offers no such transaction; refused with `unavailable`.
   */
  private async answerRelayed(
    session: Session,
    id: string,
    send: (() => Promise<{ kind: RelayKind; tx: `0x${string}`; left: number }>) | null,
    unavailable: string,
  ): Promise<void> {
    if (!send) {
      session.send({ type: 'relay.error', id, code: 'UNAVAILABLE', message: unavailable });
      return;
    }
    try {
      const { kind, tx, left } = await send();
      session.send({ type: 'relayed', id, kind, tx, left });
    } catch (error) {
      const { code, message } = errorFrame(error);
      session.send({ type: 'relay.error', id, code, message });
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
    if (seatIn(match, address) === null && !match.staked) throw new RequestError('FORBIDDEN', 'only the players who sat in this match can open it');
    session.send({
      type: 'review',
      match: {
        result: match.result,
        history: [...match.history],
        seats: [...match.seats],
        rules: match.rules,
        seed: match.seed,
        staked: match.staked,
        settledTx: match.settledTx,
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

  /** The room a move names, by the match it is aimed at, if the wallet has a seat there. */
  private requireRoom(address: `0x${string}`, matchId: `0x${string}`) {
    const room = this.options.lobby.get(matchId);
    if (!room || room.seatOf(address) === null) throw new RequestError('NOT_SEATED', 'you are not in a live match');
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
    this.options.lobby.detach(session);
    this.sessions.delete(session.socket);
    // Nobody left to tell when its table is ready: out of the queue.
    if (session.queued && session.address && !this.connected(session.address)) {
      this.options.matchmaker?.leave(session.address);
    }
    const count = (this.perIp.get(session.ip) ?? 1) - 1;
    if (count > 0) this.perIp.set(session.ip, count);
    else this.perIp.delete(session.ip);
  }

  /** Whether any open socket is logged in as `address`. */
  private connected(address: `0x${string}`): boolean {
    return !this.sessionsOf(address).next().done;
  }

  /** Every open socket logged in as `address`. */
  private *sessionsOf(address: `0x${string}`): Generator<Session> {
    const key = addressKey(address);
    for (const session of this.sessions.values()) {
      if (session.address !== null && addressKey(session.address) === key) yield session;
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function aimOf(message: MoveAim): MoveAim {
  return { matchId: message.matchId, round: message.round };
}

/**
 * The archive's matches, plus the chain's for any staked match the archive
 * does not hold, newest first. The archive's row wins: it can be replayed.
 */
export function mergeHistory(archived: readonly MatchSummary[], fromChain: readonly MatchSummary[]): MatchSummary[] {
  const known = new Set(archived.map((match) => match.matchId.toLowerCase()));
  return [...archived, ...fromChain.filter((match) => !known.has(match.matchId.toLowerCase()))].sort(
    (a, b) => b.finishedAt - a.finishedAt,
  );
}

/** One archived match as its player sees it in their history. */
export function summarise(match: ArchivedMatch, player: `0x${string}`): MatchSummary {
  const key = addressKey(player);
  const place = match.result.ranking.findIndex((address) => addressKey(address) === key);
  return {
    matchId: match.result.matchId,
    finishedAt: match.finishedAt,
    rounds: match.result.rounds,
    players: match.result.ranking.length,
    seat: seatIn(match, player),
    place: place + 1,
    staked: match.staked,
    settledTx: match.settledTx,
  };
}
