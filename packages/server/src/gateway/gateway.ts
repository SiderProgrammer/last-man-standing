import { randomBytes } from 'node:crypto';
import { verifyMessage } from 'viem';
import {
  AUTH_PREFIX,
  MAX_CLIENT_FRAME_BYTES,
  addressKey,
  type AvatarCollectionInfo,
  type ClientMessage,
  type LobbyInfo,
  type MoveAim,
  type ServerMessage,
  type StakingInfo,
  type ZapInfo,
} from '@lms/protocol';
import type { Lobby } from '../lobby/lobby.js';
import type { SessionRelayer } from '../chain/relayer.js';
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

/** One `collect` per connection per window: each one can cost the relayer gas. */
const COLLECT_COOLDOWN_MS = 30_000;

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
  lastCollectAt: number;
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
  /** Staking vault and governor. Null or omitted hides the staking panel. */
  staking?: StakingInfo | null;
  /** Submits session-authorised calls on players' behalf. */
  relayer?: SessionRelayer;
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
  /** Overrides for `DEFAULT_GATEWAY_LIMITS`. */
  limits?: Partial<GatewayLimits>;
  /** Wall clock, injectable for tests. */
  now?: () => number;
}

/** Stands in for the IP of a socket the transport could not identify. */
const UNKNOWN_IP = 'unknown';

/**
 * Translates socket frames into room calls.
 *
 * Login is a plain signed nonce rather than a session cookie: the wallet is
 * the identity, and the signature proves control of the address that staked
 * on-chain. Nothing here trusts a client-supplied address on its own.
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
  private readonly relaysByWallet: KeyedLimiter;
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
    this.relaysByWallet = new KeyedLimiter(l.relayRatePerWallet, l.relayBurstPerWallet);
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
      lastCollectAt: Number.NEGATIVE_INFINITY,
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
      collect: this.options.relayer?.canCollect ?? false,
      staking: this.options.staking ?? null,
      analyst: this.options.analyst !== undefined,
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
    this.relaysByWallet.sweep(now);
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
      this.reject(session, new Error('slow down: too many messages'));
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
    if (!address) throw new Error('authenticate before acting');

    switch (message.type) {
      case 'lobbies': {
        const directory = this.options.directory?.() ?? { open: [], live: [] };
        session.send({ type: 'lobbies', open: directory.open, live: directory.live });
        return;
      }
      case 'practice': {
        const room = this.options.lobby.createPractice(address, message.bots ?? 3, now);
        room.attach(session);
        return;
      }
      case 'watch': {
        this.options.lobby.attach(message.matchId, session);
        return;
      }
      case 'relay': {
        const relayer = this.options.relayer;
        if (!relayer?.enabled) throw new Error('session relaying is not enabled on this server');
        // Per wallet, not per socket: opening more sockets buys no more gas.
        if (!this.relaysByWallet.take(addressKey(address), now)) {
          throw new Error('too many relayed calls from this account; try again shortly');
        }

        // Submitted for the authenticated address and no other: the signature
        // proves the session key spoke, but only this socket's login proves
        // which account is asking, and the two must be the same account.
        const hash = await relayer.submit({
          account: address,
          target: message.target,
          value: BigInt(message.value),
          data: message.data,
          nonce: BigInt(message.nonce),
          signature: message.signature,
        });
        session.send({ type: 'relayed', hash });
        return;
      }
      case 'collect': {
        const relayer = this.options.relayer;
        if (!relayer?.canCollect) throw new Error('this server does not push payouts');
        if (now - session.lastCollectAt < COLLECT_COOLDOWN_MS) {
          throw new Error('a payout was just requested; give it a moment');
        }
        session.lastCollectAt = now;
        // Always the authenticated account: `withdrawFor` pays the account
        // itself, so there is nothing else a client could ask for here.
        const hash = await relayer.collect(address);
        session.send({ type: 'relayed', hash });
        return;
      }
      case 'analyze': {
        await this.analyze(session, address, message.matchId);
        return;
      }
      case 'analysis.ask': {
        await this.ask(session, address, message.matchId, message.question);
        return;
      }
      case 'commit': {
        this.requireRoom(address).submitCommit(address, message.commitment, now, message.hold, aimOf(message));
        return;
      }
      case 'reveal': {
        this.requireRoom(address).submitReveal(
          address,
          { action: message.action, target: message.target, salt: message.salt },
          now,
          aimOf(message),
        );
        return;
      }
    }
  }

  private async login(session: Session, message: Extract<ClientMessage, { type: 'auth' }>): Promise<void> {
    // Before the verifier, because a session-key login costs an RPC call.
    if (!this.loginsByIp.take(session.ip, this.now())) {
      throw new Error('too many login attempts; try again shortly');
    }
    const verify = this.options.verify ?? offlineVerify;
    const valid = await verify({
      address: message.address,
      message: `${AUTH_PREFIX}${session.nonce}`,
      signature: message.signature,
    });
    if (!valid) {
      session.loginFailures += 1;
      if (session.loginFailures >= this.limits.maxLoginFailures) {
        this.drop(session, CloseCode.PolicyViolation, 'too many failed logins');
      }
      throw new Error('login signature does not match the nonce');
    }
    session.address = message.address;
    session.send({ type: 'authed', address: message.address });
  }

  /**
   * Streams an analysis to one socket. Failures go out as `analysis.error`,
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
        onDelta: (text) => session.send({ type: 'analysis.delta', matchId, text }),
        onStep: (step) => session.send({ type: 'analysis.step', matchId, step }),
      });
      session.send({ type: 'analysis.done', analysis, cached });
    } catch (error) {
      if (!session.closed) fail(classify(error));
    } finally {
      session.analysis = null;
    }
  }

  /** A follow-up question, answered in `analysis.reply.*` frames. Shares the one-at-a-time slot with `analyze`. */
  private async ask(session: Session, address: `0x${string}`, matchId: `0x${string}`, question: string): Promise<void> {
    const fail = (error: AnalystError) =>
      session.send({ type: 'analysis.error', matchId, code: error.code, message: error.message, stage: 'ask' });

    const analyst = this.options.analyst;
    if (!analyst) {
      fail(new AnalystError('unavailable', 'match analysis is not available on this server'));
      return;
    }
    if (session.analysis) {
      fail(new AnalystError('busy', 'the analyst is still answering you'));
      return;
    }

    const controller = new AbortController();
    session.analysis = controller;
    try {
      const reply = await analyst.ask({
        matchId,
        requester: address,
        question,
        signal: controller.signal,
        onDelta: (text) => session.send({ type: 'analysis.reply.delta', matchId, text }),
        onStep: (step) => session.send({ type: 'analysis.step', matchId, step }),
      });
      session.send({ type: 'analysis.reply', matchId, question: reply.question, answer: reply.answer, model: reply.model });
    } catch (error) {
      if (!session.closed) fail(classify(error));
    } finally {
      session.analysis = null;
    }
  }

  private requireRoom(address: `0x${string}`) {
    const room = this.options.lobby.roomFor(address);
    if (!room) throw new Error('you are not in a live match');
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
  const aim: MoveAim = {};
  if (message.matchId !== undefined) aim.matchId = message.matchId;
  if (message.round !== undefined) aim.round = message.round;
  return aim;
}

/** `ecrecover` only: no network, and therefore no ERC-1271. */
const offlineVerify: SignatureVerifier = (args) => verifyMessage(args);

