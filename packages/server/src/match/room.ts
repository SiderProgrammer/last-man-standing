import {
  MatchPhase,
  addressKey,
  commitMove,
  errorMessage,
  type AvatarEntry,
  type BotDifficulty,
  type MatchResult,
  type PlayStyle,
  type MoveAim,
  type PublicMatchState,
  type RoundRecord,
  type SealedMove,
  type SeatProof,
  type ServerMessage,
  type SignedGrant,
} from '@lms/protocol';
import { Match, describeRound, type MatchSetup } from '@lms/engine';
import { BotDriver } from '../bots/bots.js';
import { RequestError } from '../errors.js';

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

/** Called once a match reaches a signable result. */
export type MatchFinished = (result: MatchResult, history: readonly RoundRecord[]) => void;

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
  /** Moves players asked the server to reveal for them this round, by seat. */
  private readonly held = new Map<number, SealedMove>();
  /** The reveal signature that came with each held move, by seat. */
  private readonly heldSignatures = new Map<number, `0x${string}`>();
  /** This round's commit and reveal signatures, by seat. House bots sign nothing. */
  private readonly commitSignatures = new Map<number, `0x${string}`>();
  private readonly revealSignatures = new Map<number, `0x${string}`>();
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

    this.deadlineAt = now + options.commitMs;
    this.bots.commit(this.match);
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
   *        reveal it for them. Checked against the commitment and against the
   *        rules up front, so a held move can never be one the player could not
   *        have revealed: the server opens it unattended, on the room's clock,
   *        where a rejection would have nobody to report to.
   */
  submitCommit(
    address: `0x${string}`,
    commitment: `0x${string}`,
    now: number = Date.now(),
    hold?: SealedMove,
    aim?: MoveAim,
    proof?: MoveProof,
  ): void {
    const seat = this.requireSeat(address);
    this.requireAim(aim);
    if (hold) {
      const opened = commitMove(this.matchId, this.match.round, seat, hold);
      if (opened.toLowerCase() !== commitment.toLowerCase()) {
        throw new RequestError('COMMITMENT_MISMATCH', 'the held move does not open the commitment');
      }
      this.match.assertPlayable(seat, hold);
    }
    this.match.submitCommit(seat, commitment);
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
    this.match.submitReveal(seat, move);
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
    }));
    this.proofLog.push(proofs);
    this.commitSignatures.clear();
    this.revealSignatures.clear();

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
    this.options.onFinished?.(result, this.match.history);
  }

  private broadcastState(): void {
    // Computed once: only `you` differs between the clients.
    const state = this.match.publicState();
    for (const client of this.clients) this.pushState(client, state);
  }

  private pushAvatars(client: Client): void {
    client.send({ type: 'avatars', matchId: this.matchId, entries: this.avatars });
  }

  private pushState(client: Client, state: PublicMatchState = this.match.publicState()): void {
    client.send({
      type: 'state',
      state,
      you: client.address ? this.seatOf(client.address) : null,
      deadline: this.deadlineAt,
    });
  }
}

