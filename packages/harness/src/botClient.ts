import { keccak256, toHex, type Hex, type TypedDataDefinition } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  AUTH_PREFIX,
  Action,
  applyDelta,
  legalActions,
  MatchPhase,
  commitMove,
  commitTypedData,
  grantTypedData,
  revealTypedData,
  withRound,
  type ActionValue,
  type ClientMessage,
  type PublicMatchState,
  type SealedMove,
  type ServerMessage,
  type SessionGrant,
  type SignedGrant,
} from '@lms/protocol';
import type { Link } from './link.js';

/**
 * A headless player that speaks the real wire protocol.
 *
 * It does what the browser client does and nothing more: logs in by signing
 * the server's nonce, opens a practice room, commits a salted move each
 * round, reveals it, and plays the next game when one ends. On a dropped
 * connection it reconnects with jittered backoff, logs in again, asks to be
 * re-attached to its match, and still reveals the move it committed before
 * the drop — the same recovery path a player on a flaky phone takes.
 *
 * Everything with timing is injectable (`schedule`, `now`, `random`), so the
 * chaos test can run thousands of these on virtual time and replay a failure
 * from its seed.
 */

export type BotEvent =
  | { type: 'connected' }
  | { type: 'authed'; ms: number }
  | { type: 'committed'; round: number }
  | { type: 'revealed'; round: number }
  /** A round resolved. `ms` is from this bot's reveal (or commit) to the broadcast, when it acted. */
  | { type: 'round'; round: number; ms: number | null }
  | { type: 'finished'; won: boolean }
  | { type: 'error'; message: string }
  | { type: 'closed'; code: number };

export interface BotClientOptions {
  privateKey: Hex;
  /** Opens a new link to the server. Called again on every reconnect. */
  connect: () => Link;
  /** House bots per practice room. */
  opponents?: number;
  /** Games to play before stopping. Infinity plays until `stop`. */
  games?: number;
  /** False logs in and then sits idle, for connection-soak runs. */
  play?: boolean;
  /**
   * Makes every signature: the wallet's grant, and the session key's login
   * and moves. Defaults to the real keys; the deterministic simulation
   * substitutes stand-ins its server accepts.
   */
  signer?: BotSigner;
  /** A staked table this bot is already seated at: it watches that match instead of opening a practice room. */
  table?: `0x${string}`;
  /** Ask the server to hold the move and reveal it if this bot drops. */
  hold?: boolean;
  /** Milliseconds to wait before committing, like a human thinking. */
  thinkMs?: () => number;
  /** Reconnect after a drop. False leaves the bot disconnected. */
  reconnect?: { baseMs: number; maxMs: number } | false;
  schedule?: (fn: () => void, ms: number) => void;
  now?: () => number;
  /** Uniform in [0, 1). Drives moves and backoff jitter. */
  random?: () => number;
  onEvent?: (event: BotEvent) => void;
}

/** Everything a bot signs, by the key that signs it. */
export interface BotSigner {
  message(key: PrivateKeyAccount, message: string): Promise<Hex>;
  typed(key: PrivateKeyAccount, data: TypedDataDefinition): Promise<Hex>;
}

const realSigner: BotSigner = {
  message: (key, message) => key.signMessage({ message }),
  typed: (key, data) => key.signTypedData(data),
};

/** How long a bot's grant runs. A soak run outlasting it logs in afresh. */
const GRANT_SECONDS = 24 * 60 * 60;

interface Pending {
  matchId: `0x${string}`;
  round: number;
  seat: number;
  move: SealedMove;
  committed: boolean;
  revealed: boolean;
  actedAt: number;
}

export class BotClient {
  readonly account: PrivateKeyAccount;
  /**
   * The key the wallet grants, which signs logins and moves as the browser's
   * does. Derived from the wallet key, so a seeded run is reproducible.
   */
  readonly sessionKey: PrivateKeyAccount;
  private grant: SignedGrant | null = null;
  /** The hub chain, from `hello`: the grant and every move are signed for it. */
  private chainId = 0;
  private link: Link | null = null;
  /** Whether the current link has logged in. Moves wait for it: the server refuses them before. */
  private authed = false;
  /** Matches already counted, so a `finished` frame and a finished `state` never count twice. */
  private readonly counted = new Set<string>();
  private readonly signer: BotSigner;
  private stopped = false;
  private connectedAt = 0;
  private backoff: number;
  private gamesPlayed = 0;
  /** The match this bot is seated in, until it finishes. */
  private matchId: `0x${string}` | null = null;
  private pending: Pending | null = null;
  /** The match as the last `state`, every `delta` and every `round` since have it. */
  private state: PublicMatchState | null = null;
  private you: number | null = null;
  /** Round a commit is already scheduled for, so repeated `state` frames do not stack timers. */
  private thinkingFor: string | null = null;
  private readonly options: Required<Omit<BotClientOptions, 'onEvent' | 'reconnect' | 'table' | 'signer'>> &
    Pick<BotClientOptions, 'onEvent' | 'reconnect'>;

  constructor(options: BotClientOptions) {
    this.options = {
      opponents: 3,
      games: 1,
      play: true,
      hold: false,
      thinkMs: () => 0,
      schedule: (fn, ms) => void setTimeout(fn, ms),
      now: Date.now,
      random: Math.random,
      reconnect: { baseMs: 250, maxMs: 5_000 },
      ...options,
    };
    this.account = privateKeyToAccount(options.privateKey);
    this.sessionKey = privateKeyToAccount(keccak256(toHex(`session:${options.privateKey}`)));
    this.matchId = options.table ?? null;
    this.signer = options.signer ?? realSigner;
    this.backoff = this.options.reconnect ? this.options.reconnect.baseMs : 0;
  }

  get address(): `0x${string}` {
    return this.account.address;
  }

  get done(): boolean {
    return this.stopped || this.gamesPlayed >= this.options.games;
  }

  get played(): number {
    return this.gamesPlayed;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.link?.close();
    this.link = null;
  }

  private open(): void {
    const link = this.options.connect();
    this.link = link;
    this.authed = false;
    this.connectedAt = this.options.now();
    link.onOpen(() => this.emit({ type: 'connected' }));
    link.onMessage((data) => {
      if (this.link !== link) return;
      let message: ServerMessage;
      try {
        message = JSON.parse(data) as ServerMessage;
      } catch {
        return;
      }
      void this.handle(message);
    });
    link.onClose((code) => {
      if (this.link !== link) return;
      this.link = null;
      this.thinkingFor = null;
      this.emit({ type: 'closed', code });
      if (this.done || !this.options.reconnect) return;
      const { maxMs } = this.options.reconnect;
      const delay = this.backoff * (0.5 + this.options.random() / 2);
      this.backoff = Math.min(this.backoff * 2, maxMs);
      this.options.schedule(() => {
        if (!this.done) this.open();
      }, delay);
    });
  }

  private send(message: ClientMessage): void {
    this.link?.send(JSON.stringify(message));
  }

  private async handle(message: ServerMessage): Promise<void> {
    switch (message.type) {
      case 'hello': {
        this.chainId = message.chainId;
        const grant = await this.ensureGrant();
        const signature = await this.signer.message(this.sessionKey, `${AUTH_PREFIX}${message.nonce}`);
        this.send({ type: 'auth', address: this.address, signature, grant });
        return;
      }
      case 'authed': {
        this.authed = true;
        if (this.options.reconnect) this.backoff = this.options.reconnect.baseMs;
        this.emit({ type: 'authed', ms: this.options.now() - this.connectedAt });
        // Back into the match in progress, or into a new one.
        if (this.matchId) this.send({ type: 'watch', matchId: this.matchId });
        else this.nextGame();
        return;
      }
      case 'state':
        this.state = message.state;
        this.you = message.you;
        this.onState(message.state, message.you);
        return;
      case 'delta': {
        // Folded into the last full state; one for another match is stale.
        if (!this.state || this.state.matchId !== message.delta.matchId) return;
        this.state = applyDelta(this.state, message.delta);
        this.onState(this.state, this.you);
        return;
      }
      case 'round': {
        if (this.state) this.state = withRound(this.state, message.record);
        const pending = this.pending;
        const acted = pending && pending.round === message.record.round ? pending : null;
        this.emit({
          type: 'round',
          round: message.record.round,
          ms: acted ? this.options.now() - acted.actedAt : null,
        });
        return;
      }
      case 'finished':
        this.finish(message.result.matchId, message.result.ranking[0]);
        return;
      case 'error':
        this.emit({ type: 'error', message: message.message });
        // A match lost to a server restart can never be re-joined: move on.
        if (/unknown match|cancelled after a server restart/.test(message.message)) {
          this.matchId = null;
          this.pending = null;
          this.nextGame();
        }
        return;
      default:
        return;
    }
  }

  private nextGame(): void {
    if (this.done || !this.options.play) return;
    this.send({ type: 'practice', bots: this.options.opponents });
  }

  /**
   * Counts a finished match once and moves on. Reached from the `finished`
   * frame, or — when the bot was offline as the match ended and re-attached
   * afterwards — from the finished `state` it is sent on attach, since the
   * `finished` frame itself went to a socket that no longer existed.
   */
  private finish(matchId: `0x${string}`, winner: `0x${string}` | undefined): void {
    const key = matchId.toLowerCase();
    if (this.counted.has(key)) return;
    this.counted.add(key);
    this.gamesPlayed += 1;
    if (this.matchId?.toLowerCase() === key) {
      this.matchId = null;
      this.pending = null;
    }
    this.emit({ type: 'finished', won: winner?.toLowerCase() === this.address.toLowerCase() });
    if (this.done) this.stop();
    else this.nextGame();
  }

  private onState(state: PublicMatchState, you: number | null): void {
    if (you === null) {
      // Attached to the match it was playing, but not seated in it: that match
      // is not the one it left. Give up on it rather than spectate forever.
      if (this.matchId?.toLowerCase() === state.matchId.toLowerCase()) {
        this.emit({ type: 'error', message: `not seated in ${state.matchId} after re-attaching` });
        this.matchId = null;
        this.pending = null;
        this.nextGame();
      }
      return;
    }
    if (state.phase === MatchPhase.Finished || state.phase === MatchPhase.Aborted) {
      if (this.matchId?.toLowerCase() === state.matchId.toLowerCase()) this.finish(state.matchId, undefined);
      return;
    }
    this.matchId = state.matchId;
    const me = state.players.find((player) => player.index === you);
    if (!me?.alive) return;

    const key = `${state.matchId}:${state.round}`;
    let pending = this.pending;
    if (!pending || pending.matchId !== state.matchId || pending.round !== state.round) {
      pending = {
        matchId: state.matchId,
        round: state.round,
        seat: you,
        move: this.chooseMove(state, you),
        committed: false,
        revealed: false,
        actedAt: 0,
      };
      this.pending = pending;
    }
    // The server is the authority on what it has received: after a reconnect
    // it may hold a commit this bot sent just before the drop.
    if (state.committed.includes(you)) pending.committed = true;
    if (state.revealed.includes(you)) pending.revealed = true;

    if (state.phase === MatchPhase.Commit && !pending.committed && this.thinkingFor !== key) {
      this.thinkingFor = key;
      const target = pending;
      this.options.schedule(() => {
        // Not before this link has logged in: the server would refuse the commit
        // and the move would be lost. The `state` that follows the re-attach
        // schedules it again.
        if (this.pending !== target || target.committed || !this.link || !this.authed) {
          if (this.thinkingFor === key) this.thinkingFor = null;
          return;
        }
        target.committed = true;
        target.actedAt = this.options.now();
        void this.sendCommit(target);
      }, this.options.thinkMs());
    }

    if (state.phase === MatchPhase.Reveal && pending.committed && !pending.revealed && this.authed) {
      pending.revealed = true;
      pending.actedAt = this.options.now();
      void this.sendReveal(pending);
    }
  }

  /** The grant this bot logs in with, signed afresh once the old one is near its end. */
  private async ensureGrant(): Promise<SignedGrant> {
    const now = Math.floor(this.options.now() / 1000);
    const current = this.grant;
    if (current && current.grant.chainId === this.chainId && current.grant.expiresAt - 60 > now) return current;
    const grant: SessionGrant = {
      wallet: this.address,
      sessionKey: this.sessionKey.address,
      domain: 'harness.local',
      uri: 'http://harness.local',
      chainId: this.chainId,
      issuedAt: now,
      expiresAt: now + GRANT_SECONDS,
      nonce: keccak256(toHex(`grant:${this.options.privateKey}:${now}`)),
    };
    this.grant = { grant, signature: await this.signer.typed(this.account, grantTypedData(grant)) };
    return this.grant;
  }

  private async sendCommit(target: Pending): Promise<void> {
    const commitment = commitMove(target.matchId, target.round, target.seat, target.move);
    const signature = await this.signer.typed(this.sessionKey, commitTypedData(this.chainId, target, commitment));
    const aim = { matchId: target.matchId, round: target.round };
    if (this.options.hold) {
      const held = await this.signer.typed(this.sessionKey, revealTypedData(this.chainId, target, target.move));
      this.send({ type: 'commit', commitment, signature, hold: { ...target.move, signature: held }, ...aim });
    } else {
      this.send({ type: 'commit', commitment, signature, ...aim });
    }
    this.emit({ type: 'committed', round: target.round });
  }

  private async sendReveal(pending: Pending): Promise<void> {
    const signature = await this.signer.typed(this.sessionKey, revealTypedData(this.chainId, pending, pending.move));
    this.send({
      type: 'reveal',
      action: pending.move.action,
      target: pending.move.target,
      salt: pending.move.salt,
      matchId: pending.matchId,
      round: pending.round,
      signature,
    });
    this.emit({ type: 'revealed', round: pending.round });
  }

  private chooseMove(state: PublicMatchState, you: number): SealedMove {
    const opponents = state.players.filter((player) => player.alive && player.index !== you);
    const me = state.players.find((player) => player.index === you);
    // Only what the cooldowns allow: a repeated Guard or Charge would be
    // rejected at reveal and the bot would lose its turn.
    const actions: ActionValue[] = me ? legalActions(me) : [Action.Strike];
    let action = actions[Math.floor(this.options.random() * actions.length)] ?? Action.Strike;
    if (action === Action.Strike && opponents.length === 0) action = actions.find((a) => a !== Action.Strike) ?? Action.Strike;
    const target =
      action === Action.Strike ? (opponents[Math.floor(this.options.random() * opponents.length)]?.index ?? 0) : 0;
    // Derived rather than random, so a bot that reconnects after losing its
    // memory would still open its own commitment — and so a seeded run is
    // reproducible down to the salts.
    const salt = keccak256(toHex(`salt:${this.options.privateKey}:${state.matchId}:${state.round}`));
    return { action, target, salt };
  }

  private emit(event: BotEvent): void {
    this.options.onEvent?.(event);
  }
}
