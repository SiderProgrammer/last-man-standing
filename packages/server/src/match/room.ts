import {
  MatchPhase,
  addressKey,
  type AvatarEntry,
  type MatchResult,
  type RoundRecord,
  type SealedMove,
  type ServerMessage,
} from '@lms/protocol';
import { Match, describeRound, type MatchSetup } from '@lms/engine';
import { BotDriver } from '../bots/bots.js';

/** Anything the room can push a message to. The gateway supplies a WebSocket. */
export interface Client {
  address: `0x${string}` | null;
  send(message: ServerMessage): void;
}

/** Called once a match reaches a signable result. */
export type MatchFinished = (result: MatchResult, history: readonly RoundRecord[]) => void;

export interface RoomOptions {
  commitMs: number;
  revealMs: number;
  /** Seats played by the server's bots. Empty for a fully human lobby. */
  botSeats: readonly number[];
  /**
   * Pause after a round resolves, before the next commit clock starts, so the
   * client can replay the round without eating into anyone's decision time.
   * Zero (the default) opens the next window immediately.
   */
  replayMs?: number;
  onFinished?: MatchFinished;
}

/**
 * One authoritative match.
 *
 * The room owns the clock but never reads it: `tick(now)` is driven from the
 * outside, so tests can run a whole match in a loop and the production server
 * can drive it from an interval. Nothing here touches the network directly —
 * clients are opaque sinks, which keeps the state machine testable.
 */
export class Room {
  readonly match: Match;

  private readonly options: RoomOptions;
  private readonly bots: BotDriver;
  private readonly clients = new Set<Client>();
  private readonly seatByAddress = new Map<string, number>();
  /** Cosmetic only, and resolved off the match's critical path. */
  private avatars: AvatarEntry[] = [];
  private deadlineAt: number;
  /**
   * End of the replay hold after the last round. Commits are accepted during
   * it, but the reveal cannot open early until it has passed — otherwise a
   * table where the bots commit at resolve time would skip the pause the
   * moment the human locked in.
   */
  private replayUntil = 0;
  private settled = false;

  constructor(setup: MatchSetup, options: RoomOptions, now: number = Date.now()) {
    this.match = new Match(setup);
    this.options = options;
    this.bots = new BotDriver(options.botSeats);

    for (const seat of setup.seats) {
      this.seatByAddress.set(addressKey(seat.address), seat.index);
    }

    this.deadlineAt = now + options.commitMs;
    this.bots.commit(this.match);
  }

  get matchId(): `0x${string}` {
    return this.match.matchId;
  }

  get finished(): boolean {
    return this.match.finished;
  }

  get deadline(): number {
    return this.deadlineAt;
  }

  seatOf(address: `0x${string}`): number | null {
    return this.seatByAddress.get(addressKey(address)) ?? null;
  }

  attach(client: Client): void {
    this.clients.add(client);
    this.pushState(client);
    if (this.avatars.length > 0) this.pushAvatars(client);
  }

  /**
   * Publishes the avatars the seats are wearing.
   *
   * Called once the registry has answered, which is after the match is already
   * playable: resolving an NFT means a chain read and an IPFS fetch, and no
   * round waits for either. A client that connects later gets them on attach.
   */
  setAvatars(entries: readonly AvatarEntry[]): void {
    this.avatars = [...entries];
    if (this.avatars.length === 0) return;
    for (const client of this.clients) this.pushAvatars(client);
  }

  detach(client: Client): void {
    this.clients.delete(client);
  }

  submitCommit(address: `0x${string}`, commitment: `0x${string}`, now: number = Date.now()): void {
    const seat = this.requireSeat(address);
    this.match.submitCommit(seat, commitment);
    // During the hold the commit is kept but the fast path waits: `tick` opens
    // the reveal once the replay has finished.
    if (this.match.allCommitted() && now >= this.replayUntil) this.openReveal(now);
    else this.broadcastState();
  }

  submitReveal(address: `0x${string}`, move: SealedMove, now: number = Date.now()): void {
    const seat = this.requireSeat(address);
    this.match.submitReveal(seat, move);
    if (this.match.allRevealed()) this.resolveRound(now);
    else this.broadcastState();
  }

  /** Advances the phase clock. Safe to call at any frequency. */
  tick(now: number = Date.now()): void {
    if (this.match.finished) return;
    // A table that finished committing during the replay hold was waiting only
    // on the hold, not on the clock.
    if (
      this.match.phase === MatchPhase.Commit &&
      now >= this.replayUntil &&
      now < this.deadlineAt &&
      this.match.allCommitted()
    ) {
      this.openReveal(now);
      return;
    }
    if (now < this.deadlineAt) return;
    if (this.match.phase === MatchPhase.Commit) this.openReveal(now);
    else if (this.match.phase === MatchPhase.Reveal) this.resolveRound(now);
  }

  private requireSeat(address: `0x${string}`): number {
    const seat = this.seatOf(address);
    if (seat === null) throw new Error('you are not seated in this match');
    if (this.bots.has(seat)) throw new Error('seat is played by the house bot');
    return seat;
  }

  private openReveal(now: number): void {
    if (this.match.phase !== MatchPhase.Commit) return;
    this.match.openRevealPhase();
    this.bots.reveal(this.match);

    if (this.match.allRevealed()) {
      this.resolveRound(now);
      return;
    }
    this.deadlineAt = now + this.options.revealMs;
    this.broadcastState();
  }

  private resolveRound(now: number): void {
    if (this.match.phase !== MatchPhase.Reveal) return;

    const record = this.match.resolve();
    const replayMs = this.options.replayMs ?? 0;

    for (const client of this.clients) {
      client.send({
        type: 'round',
        record,
        lines: describeRound(record),
        replayMs,
      });
    }

    // Settlement is never held for a cosmetic: the client defers showing the
    // result until its replay ends, the server does not defer producing it.
    if (this.match.finished) {
      this.finish();
      return;
    }

    // No replay means no hold at all, not a zero-length one: the gate compares
    // against caller-supplied timestamps, and a hold ending "now" would still
    // reject a commit stamped a moment earlier.
    this.replayUntil = replayMs > 0 ? now + replayMs : 0;
    this.deadlineAt = now + replayMs + this.options.commitMs;
    this.bots.commit(this.match);
    this.broadcastState();
  }

  private finish(): void {
    if (this.settled) return;
    this.settled = true;

    const result = this.match.result();
    const ranking = this.match.ranking();
    for (const client of this.clients) client.send({ type: 'finished', result, ranking });
    this.options.onFinished?.(result, this.match.history);
  }

  private broadcastState(): void {
    for (const client of this.clients) this.pushState(client);
  }

  private pushAvatars(client: Client): void {
    client.send({ type: 'avatars', matchId: this.matchId, entries: this.avatars });
  }

  private pushState(client: Client): void {
    client.send({
      type: 'state',
      state: this.match.publicState(),
      you: client.address ? this.seatOf(client.address) : null,
      deadline: this.deadlineAt,
    });
  }
}

