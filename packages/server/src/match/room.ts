import {
  MatchPhase,
  addressKey,
  commitMove,
  type AvatarEntry,
  type MatchResult,
  type PlayStyle,
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

/**
 * Everything that changed a room, in order, with the time it happened.
 *
 * The bots are not in here and need not be: their moves derive from the match
 * seed and the public history, so replaying the human inputs and the clock
 * ticks that moved the phase reproduces the room exactly.
 */
export type RoomEvent =
  | { kind: 'commit'; address: `0x${string}`; commitment: `0x${string}`; at: number; hold?: SealedMove }
  | { kind: 'reveal'; address: `0x${string}`; move: SealedMove; at: number }
  /** A `tick` that advanced the phase. Ticks that changed nothing are not recorded. */
  | { kind: 'tick'; at: number };

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
  /** Receives every `RoomEvent` as it happens, for persistence. */
  journal?: (event: RoomEvent) => void;
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
  /** Earlier play styles of the seated wallets, for the reads panel. */
  private dossier: Array<{ address: `0x${string}`; style: PlayStyle }> = [];
  private deadlineAt: number;
  /**
   * End of the replay hold after the last round. Commits are accepted during
   * it, but the reveal cannot open early until it has passed — otherwise a
   * table where the bots commit at resolve time would skip the pause the
   * moment the human locked in.
   */
  private replayUntil = 0;
  private settled = false;
  /** Moves players asked the server to reveal for them this round, by seat. */
  private readonly held = new Map<number, SealedMove>();
  private journal: ((event: RoomEvent) => void) | undefined;

  constructor(setup: MatchSetup, options: RoomOptions, now: number = Date.now()) {
    this.match = new Match(setup);
    this.options = options;
    this.bots = new BotDriver(options.botSeats);

    for (const seat of setup.seats) {
      this.seatByAddress.set(addressKey(seat.address), seat.index);
    }

    this.journal = options.journal;
    this.deadlineAt = now + options.commitMs;
    this.bots.commit(this.match);
  }

  /**
   * Rebuilds a room from its journal after a restart.
   *
   * The events are applied through the same methods that produced them, so the
   * rebuilt room is the room that was running, not an approximation of it. The
   * journal is attached only afterwards, so the replay does not record itself.
   */
  static restore(
    setup: MatchSetup,
    options: RoomOptions,
    openedAt: number,
    events: readonly RoomEvent[],
    now: number,
  ): Room {
    const { journal, ...quiet } = options;
    const room = new Room(setup, quiet, openedAt);
    for (const event of events) {
      if (event.kind === 'commit') room.submitCommit(event.address, event.commitment, event.at, event.hold);
      else if (event.kind === 'reveal') room.submitReveal(event.address, event.move, event.at);
      else room.tick(event.at);
    }
    room.journal = journal;
    room.resumeAfterRestart(now);
    return room;
  }

  /**
   * Gives the open window its full length again after downtime.
   *
   * Without this a restart that outlasted a reveal window would resolve the
   * round on the first tick, scoring every player who could not reconnect in
   * time as a no-show for the server's outage rather than their own.
   */
  private resumeAfterRestart(now: number): void {
    if (this.match.finished) return;
    const window = this.match.phase === MatchPhase.Reveal ? this.options.revealMs : this.options.commitMs;
    this.deadlineAt = Math.max(this.deadlineAt, now + window);
    this.replayUntil = 0;
  }

  /** Tells everyone watching how the match settled on-chain. */
  announceSettled(tx: `0x${string}` | null): void {
    for (const client of this.clients) client.send({ type: 'settled', matchId: this.matchId, tx });
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
    if (this.dossier.length > 0) this.pushDossier(client);
  }

  /** Publishes the seated wallets' records from earlier settled matches. */
  setDossier(entries: ReadonlyArray<{ address: `0x${string}`; style: PlayStyle }>): void {
    this.dossier = [...entries];
    if (this.dossier.length === 0) return;
    for (const client of this.clients) this.pushDossier(client);
  }

  private pushDossier(client: Client): void {
    client.send({ type: 'dossier', matchId: this.matchId, entries: this.dossier });
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

  /**
   * @param hold The move behind `commitment`, if the player wants the server to
   *        reveal it for them. Checked against the commitment up front, so a
   *        held move can never be one the player could not have revealed.
   */
  submitCommit(
    address: `0x${string}`,
    commitment: `0x${string}`,
    now: number = Date.now(),
    hold?: SealedMove,
  ): void {
    const seat = this.requireSeat(address);
    if (hold) {
      const opened = commitMove(this.matchId, this.match.round, seat, hold);
      if (opened.toLowerCase() !== commitment.toLowerCase()) {
        throw new Error('the held move does not open the commitment');
      }
    }
    this.match.submitCommit(seat, commitment);
    if (hold) this.held.set(seat, hold);
    this.journal?.({ kind: 'commit', address, commitment, at: now, ...(hold ? { hold } : {}) });
    // During the hold the commit is kept but the fast path waits: `tick` opens
    // the reveal once the replay has finished.
    if (this.match.allCommitted() && now >= this.replayUntil) this.openReveal(now);
    else this.broadcastState();
  }

  submitReveal(address: `0x${string}`, move: SealedMove, now: number = Date.now()): void {
    const seat = this.requireSeat(address);
    this.match.submitReveal(seat, move);
    this.journal?.({ kind: 'reveal', address, move, at: now });
    if (this.match.allRevealed()) this.resolveRound(now);
    else this.broadcastState();
  }

  /** Advances the phase clock. Safe to call at any frequency. */
  tick(now: number = Date.now()): void {
    if (this.match.finished) return;
    const before = `${this.match.round}:${this.match.phase}`;
    this.advance(now);
    if (`${this.match.round}:${this.match.phase}` !== before) this.journal?.({ kind: 'tick', at: now });
  }

  private advance(now: number): void {
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
    // Held moves open at once, whether or not their players are still here.
    for (const [seat, move] of this.held) this.match.submitReveal(seat, move);
    this.held.clear();

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
    // The final snapshot first: it carries the last round, which is what a
    // client needs to replay the whole match and check `result` for itself.
    this.broadcastState();
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

