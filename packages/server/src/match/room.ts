import {
  MatchPhase,
  addressKey,
  matchDelta,
  commitMove,
  errorMessage,
  type AvatarEntry,
  type BotDifficulty,
  type CommitReceipt,
  type MatchResult,
  type PlayStyle,
  type MoveAim,
  type PublicMatchState,
  type RoundRecord,
  type SealedMove,
  type SeatProof,
  type ServerMessage,
  type SignedGrant,
  type Transcript,
  TRANSCRIPT_VERSION,
} from '@lms/protocol';
import { Match, describeRound, type MatchSetup } from '@lms/engine';
import { BotDriver } from '../bots/bots.js';
import { RequestError } from '../errors.js';
import type { JournalEntry } from './journal.js';

/** Anything the room can push a message to. The gateway supplies a WebSocket. */
export interface Client {
  address: `0x${string}` | null;
  send(message: ServerMessage): void;
}

/**
 * The signatures behind a move from a player, already checked by the gateway
 * against the grant's session key.
 */
export interface MoveProof {
  grant: SignedGrant;
  signature: `0x${string}`;
  /** With a held commit: the signature over the reveal it stands in for. */
  holdSignature?: `0x${string}`;
}

/** Called once a match reaches a signable result, with everything needed to check it. */
export type MatchFinished = (transcript: Transcript) => void;

export interface RoomOptions {
  commitMs: number;
  revealMs: number;
  /** Seats played by the server's bots. Empty for a fully human lobby. */
  botSeats: readonly number[];
  /** How well those bots play. Defaults to normal. */
  botDifficulty?: BotDifficulty;
  /**
   * Pause after a round resolves, before the next commit clock starts, so the
   * client can replay the round without eating into anyone's decision time.
   * Zero (the default) opens the next window immediately.
   */
  replayMs?: number;
  /** The hub chain, which every move and receipt is signed for. Recorded in the transcript. */
  chainId?: number;
  /** The key that signs commit receipts, recorded in the transcript. */
  receiptSigner?: `0x${string}` | null;
  /** Whether the room holds escrowed stakes. Defaults to false: a practice room. */
  staked?: boolean;
  /**
   * The ready phase: round 1's clock starts once every player's seat has a
   * client attached, or this long after the room opens, whichever is first.
   * Zero (the default) starts it at once.
   */
  readyMs?: number;
  /**
   * Told everything that moves the room on, as it happens, for
   * `Room.replay` to rebuild it from after a restart. Synchronous: the
   * caller queues the write.
   */
  journal?: (entry: JournalEntry) => void;
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
  /** Round 1's clock is running: everyone arrived, or the ready phase ran out. */
  private started: boolean;
  /** When the ready phase runs out. */
  private readyUntil: number;
  /** Where entries go; off while a journal is being replayed. */
  private journal: ((entry: JournalEntry) => void) | undefined;
  /** The latest time the room was driven at, which `msRemaining` is counted from. */
  private clock: number;
  /** Moves players asked the server to reveal for them this round, by seat. */
  private readonly held = new Map<number, SealedMove>();
  /** The reveal signature that came with each held move, by seat. */
  private readonly heldSignatures = new Map<number, `0x${string}`>();
  /** This round's commit and reveal signatures, by seat. House bots sign nothing. */
  private readonly commitSignatures = new Map<number, `0x${string}`>();
  private readonly revealSignatures = new Map<number, `0x${string}`>();
  /** When each player's commit was taken this round: the time its receipt carries. */
  private readonly receivedAt = new Map<number, number>();
  /** Every round's signatures, in round order, alongside `match.history`. */
  private readonly proofLog: SeatProof[][] = [];
  /** Every grant a seat played under, by session key. A player may reconnect with a new one mid-match. */
  private readonly grantLog = new Map<string, SignedGrant>();

  constructor(setup: MatchSetup, options: RoomOptions, now: number = Date.now()) {
    this.match = new Match(setup);
    this.options = options;
    this.bots = new BotDriver(options.botSeats, options.botDifficulty);

    for (const seat of setup.seats) {
      this.seatByAddress.set(addressKey(seat.address), seat.index);
    }

    this.clock = now;
    this.readyUntil = now + (options.readyMs ?? 0);
    this.started = this.readyUntil <= now || this.absent().length === 0;
    this.deadlineAt = (this.started ? now : this.readyUntil) + options.commitMs;
    this.bots.commit(this.match);
    this.journal = options.journal;
    this.journal?.({ kind: 'open', at: now });
  }

  /**
   * Rebuilds a room from its journal: the same setup and options, and every
   * entry applied in order with its own timestamp, which brings it to the
   * state it was in when the last entry was written. Throws on a journal
   * that does not replay.
   */
  static replay(setup: MatchSetup, options: RoomOptions, entries: readonly JournalEntry[]): Room {
    const [first, ...rest] = entries;
    if (first?.kind !== 'open') throw new Error('the journal does not begin with the room opening');
    const quiet: RoomOptions = { ...options };
    delete quiet.journal;
    const room = new Room(setup, quiet, first.at);
    for (const entry of rest) room.apply(entry);
    room.journal = options.journal;
    return room;
  }

  private apply(entry: JournalEntry): void {
    const address = (seat: number) => {
      const found = this.match.seats[seat]?.address;
      if (!found) throw new Error(`the journal names seat ${seat}, which this match does not have`);
      return found;
    };
    switch (entry.kind) {
      case 'open':
        throw new Error('the journal opens the room twice');
      case 'commit':
        this.submitCommit(address(entry.seat), entry.commitment, entry.at, entry.hold, entry.aim, entry.proof);
        return;
      case 'reveal':
        this.submitReveal(address(entry.seat), entry.move, entry.at, entry.aim, entry.proof);
        return;
      case 'tick':
        this.tick(entry.at);
        return;
      case 'start':
        this.start(entry.at);
        return;
      case 'rebase':
        this.rebase(entry.at);
        return;
    }
  }

  /**
   * Gives the players their clock back after a restart: a fresh ready phase
   * for them to reconnect in, then the window the room was in, in full. The
   * round, its commitments and its reveals are as they were.
   */
  rebase(now: number): void {
    if (this.match.finished) return;
    this.started = false;
    this.readyUntil = now + (this.options.readyMs ?? 0);
    this.replayUntil = 0;
    const window = this.match.phase === MatchPhase.Reveal ? this.options.revealMs : this.options.commitMs;
    this.deadlineAt = this.readyUntil + window;
    this.journal?.({ kind: 'rebase', at: now });
  }

  /** Seats whose player has no client attached yet: the ready phase waits on these. Empty once round 1 has started. */
  absent(): number[] {
    if (this.started) return [];
    const here = new Set<number>();
    for (const client of this.clients) {
      const seat = client.address ? this.seatOf(client.address) : null;
      if (seat !== null) here.add(seat);
    }
    return this.match.seats.map((seat) => seat.index).filter((index) => !this.bots.has(index) && !here.has(index));
  }

  /** Starts the clock now, everyone being here. */
  private start(now: number): void {
    this.started = true;
    const window = this.match.phase === MatchPhase.Reveal ? this.options.revealMs : this.options.commitMs;
    this.deadlineAt = Math.min(this.deadlineAt, now + window);
    this.journal?.({ kind: 'start', at: now });
    this.broadcastState();
  }

  /** Tells everyone watching how the match settled on-chain. */
  announceSettled(tx: `0x${string}` | null): void {
    const message = { type: 'settled', matchId: this.matchId, tx } as const;
    for (const client of this.clients) client.send(message);
  }

  get matchId(): `0x${string}` {
    return this.match.matchId;
  }

  get finished(): boolean {
    return this.match.finished;
  }

  /** True for a match played for escrowed stakes; false for practice. */
  get staked(): boolean {
    return this.options.staked ?? false;
  }

  get deadline(): number {
    return this.deadlineAt;
  }

  /** The signatures behind each resolved round, indexed like `match.history`. */
  get proofs(): readonly (readonly SeatProof[])[] {
    return this.proofLog;
  }

  /** Every grant a seat's moves were signed under. */
  get grants(): SignedGrant[] {
    return [...this.grantLog.values()];
  }

  seatOf(address: `0x${string}`): number | null {
    return this.seatByAddress.get(addressKey(address)) ?? null;
  }

  attach(client: Client, now: number = Date.now()): void {
    this.clock = now;
    this.clients.add(client);
    this.pushState(client);
    // While the table fills, everyone sees who is still to come.
    if (!this.started && this.absent().length === 0) this.start(now);
    else if (!this.started) this.broadcastState();
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

  /** Every client attached now. */
  get attached(): ReadonlySet<Client> {
    return this.clients;
  }

  /**
   * @param hold The move behind `commitment`, if the player wants the server to
   *        reveal it for them. Checked against the commitment and against the
   *        rules up front, so a held move can never be one the player could not
   *        have revealed: the server opens it unattended, on the room's clock,
   *        where a rejection would have nobody to report to.
   * @returns What the server's receipt for the commit says, for the gateway
   *          to sign and send back.
   */
  submitCommit(
    address: `0x${string}`,
    commitment: `0x${string}`,
    now: number = Date.now(),
    hold?: SealedMove,
    aim?: MoveAim,
    proof?: MoveProof,
  ): CommitReceipt {
    const seat = this.requireSeat(address);
    this.requireAim(aim);
    this.clock = now;
    const round = this.match.round;
    if (hold) {
      const opened = commitMove(this.matchId, this.match.round, seat, hold);
      if (opened.toLowerCase() !== commitment.toLowerCase()) {
        throw new RequestError('COMMITMENT_MISMATCH', 'the held move does not open the commitment');
      }
      this.match.assertPlayable(seat, hold);
    }
    this.match.submitCommit(seat, commitment);
    this.journal?.({
      kind: 'commit',
      at: now,
      seat,
      commitment,
      aim: { matchId: this.matchId, round },
      ...(hold ? { hold } : {}),
      ...(proof ? { proof } : {}),
    });
    this.receivedAt.set(seat, now);
    if (hold) this.held.set(seat, hold);
    if (proof) {
      this.recordGrant(proof.grant);
      this.commitSignatures.set(seat, proof.signature);
      if (hold && proof.holdSignature) this.heldSignatures.set(seat, proof.holdSignature);
    }
    // During the hold the commit is kept but the fast path waits: `tick` opens
    // the reveal once the replay has finished.
    if (this.match.allCommitted() && now >= this.replayUntil) this.openReveal(now);
    else this.broadcastState();
    return { matchId: this.matchId, round, seat, commitment, receivedAt: now };
  }

  submitReveal(
    address: `0x${string}`,
    move: SealedMove,
    now: number = Date.now(),
    aim?: MoveAim,
    proof?: MoveProof,
  ): void {
    const seat = this.requireSeat(address);
    this.requireAim(aim);
    this.clock = now;
    const round = this.match.round;
    this.match.submitReveal(seat, move);
    this.journal?.({ kind: 'reveal', at: now, seat, move, aim: { matchId: this.matchId, round }, ...(proof ? { proof } : {}) });
    if (proof) {
      this.recordGrant(proof.grant);
      this.revealSignatures.set(seat, proof.signature);
    }
    if (this.match.allRevealed()) this.resolveRound(now);
    else this.broadcastState();
  }

  /** Advances the phase clock. Safe to call at any frequency. */
  tick(now: number = Date.now()): void {
    if (this.match.finished) return;
    this.clock = now;
    const before = this.position();
    this.advance(now);
    if (this.position() !== before) this.journal?.({ kind: 'tick', at: now });
  }

  /** Where the room is: what a tick that moved it changes. */
  private position(): string {
    return `${this.started}:${this.match.round}:${this.match.phase}`;
  }

  private advance(now: number): void {
    if (!this.started && now >= this.readyUntil) {
      // Not everyone came: play starts without them, on the clock it was always going to.
      this.started = true;
      this.broadcastState();
    }
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

  /**
   * Refuses a move made for another match or round: see `MoveAim`. Every
   * client move carries one; only the server's own moves (house bots) omit it.
   */
  private requireAim(aim: MoveAim | undefined): void {
    if (!aim) return;
    if (aim.matchId.toLowerCase() !== this.matchId.toLowerCase()) {
      throw new RequestError('STALE_MOVE', 'this move is for another match');
    }
    if (aim.round !== this.match.round) {
      throw new RequestError('STALE_MOVE', `this move is for round ${aim.round}; the match is on round ${this.match.round}`);
    }
  }

  private recordGrant(grant: SignedGrant): void {
    this.grantLog.set(addressKey(grant.grant.sessionKey), grant);
  }

  private requireSeat(address: `0x${string}`): number {
    const seat = this.seatOf(address);
    if (seat === null) throw new RequestError('NOT_SEATED', 'you are not seated in this match');
    if (this.bots.has(seat)) throw new RequestError('FORBIDDEN', 'seat is played by the house bot');
    return seat;
  }

  private openReveal(now: number): void {
    if (this.match.phase !== MatchPhase.Commit) return;
    this.match.openRevealPhase();
    this.bots.reveal(this.match);
    // Held moves open at once, whether or not their players are still here.
    // Each was checked at commit, but one that is still refused must cost only
    // its own seat the round, never the reveals queued behind it.
    for (const [seat, move] of this.held) {
      try {
        this.match.submitReveal(seat, move);
        const signature = this.heldSignatures.get(seat);
        if (signature) this.revealSignatures.set(seat, signature);
      } catch (error) {
        console.warn(`[room] held move for seat ${seat} refused; it sits the round out:`, errorMessage(error));
      }
    }
    this.held.clear();
    this.heldSignatures.clear();

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
    const proofs: SeatProof[] = record.moves.map((move) => ({
      index: move.index,
      commitSignature: this.commitSignatures.get(move.index) ?? null,
      revealSignature: move.revealed ? (this.revealSignatures.get(move.index) ?? null) : null,
      receivedAt: this.receivedAt.get(move.index) ?? null,
    }));
    this.proofLog.push(proofs);
    this.commitSignatures.clear();
    this.revealSignatures.clear();
    this.receivedAt.clear();

    // One object for the whole table: the gateway serialises a shared message
    // once, however many sockets it goes to.
    const message = { type: 'round', record, proofs, lines: describeRound(record), replayMs } as const;
    for (const client of this.clients) client.send(message);

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
    const message = { type: 'finished', result, ranking } as const;
    for (const client of this.clients) client.send(message);
    this.options.onFinished?.(this.transcript());
  }

  /** The finished match, complete enough for anyone to check without the server. */
  transcript(): Transcript {
    return {
      version: TRANSCRIPT_VERSION,
      matchId: this.matchId,
      chainId: this.options.chainId ?? 0,
      seed: this.match.seed,
      rules: this.match.rules,
      seats: [...this.match.seats],
      botSeats: [...this.options.botSeats],
      receiptSigner: this.options.receiptSigner ?? null,
      grants: this.grants,
      rounds: this.match.history.map((record, i) => ({ record, proofs: [...(this.proofLog[i] ?? [])] })),
      result: this.match.result(),
    };
  }

  /**
   * Tells every client what changed. One object for the whole table, so the
   * gateway serialises it once however many sockets it goes to.
   */
  private broadcastState(): void {
    const message = {
      type: 'delta',
      delta: matchDelta(this.match.publicState()),
      msRemaining: this.remaining(),
      waitingFor: this.absent(),
    } as const;
    for (const client of this.clients) client.send(message);
  }

  private remaining(): number {
    return Math.max(0, this.deadlineAt - this.clock);
  }

  private pushAvatars(client: Client): void {
    client.send({ type: 'avatars', matchId: this.matchId, entries: this.avatars });
  }

  /** The whole match, for a client that has just attached. */
  private pushState(client: Client): void {
    client.send({
      type: 'state',
      state: this.match.publicState(),
      you: client.address ? this.seatOf(client.address) : null,
      msRemaining: this.remaining(),
      waitingFor: this.absent(),
    });
  }
}

