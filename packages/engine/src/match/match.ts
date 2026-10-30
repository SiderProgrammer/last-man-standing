import {
  Action,
  assertValidRules,
  chainHistory,
  commitMove,
  hashRound,
  hashRules,
  historySeed,
  isLegalAction,
  MatchPhase,
  NO_COMMITMENT,
  type ActionValue,
  type MatchErrorCode,
  type MatchPhaseValue,
  type MatchResult,
  type Move,
  type PlayerState,
  type PublicMatchState,
  type RoundRecord,
  type Rules,
  type SealedMove,
  type Seat,
  ZERO_SALT,
} from '@lms/protocol';
import { entropyOf, resolveRound, tiebreakKey, type DeclaredMove } from '../kernel/resolve.js';

export class MatchError extends Error {
  constructor(
    readonly code: MatchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MatchError';
  }
}

export interface MatchSetup {
  matchId: `0x${string}`;
  /** Seats in the order they were assigned. Seat index must equal array index. */
  seats: Seat[];
  /** Randomness-oracle seed, fixed before the first commit. */
  seed: `0x${string}`;
  rules: Rules;
}

/** Snapshot safe to broadcast to every player, including spectators. */
export type { PublicMatchState };

/**
 * Authoritative state machine for one match.
 *
 * Hidden information is enforced cryptographically rather than by trusting the
 * server: during the commit phase players publish only `keccak256(move‖salt)`,
 * and the server cannot learn a move until the reveal phase. Because every
 * commitment is broadcast, players can verify after the fact that no one's
 * move was altered once the reveals were known.
 */
export class Match {
  readonly matchId: `0x${string}`;
  readonly rules: Rules;
  readonly rulesHash: `0x${string}`;
  readonly seed: `0x${string}`;
  readonly seats: readonly Seat[];

  private phaseValue: MatchPhaseValue;
  private roundValue: number;
  private states: PlayerState[];
  private readonly rounds: RoundRecord[] = [];
  private root: `0x${string}`;
  private readonly commitments = new Map<number, `0x${string}`>();
  private readonly reveals = new Map<number, DeclaredMove>();
  /** Seats in elimination order, worst-placed first. */
  private readonly eliminationSequence: number[] = [];
  /** Rounds in a row without a hit, which drives the stall penalty. */
  private quietRounds = 0;

  constructor(setup: MatchSetup) {
    assertValidRules(setup.rules);

    if (setup.seats.length < setup.rules.minPlayers || setup.seats.length > setup.rules.maxPlayers) {
      throw new MatchError(
        'INVALID_MOVE',
        `seat count ${setup.seats.length} outside [${setup.rules.minPlayers}, ${setup.rules.maxPlayers}]`,
      );
    }
    setup.seats.forEach((seat, index) => {
      if (seat.index !== index) {
        throw new MatchError('UNKNOWN_SEAT', `seat ${index} declares index ${seat.index}`);
      }
    });

    this.matchId = setup.matchId;
    this.rules = setup.rules;
    this.rulesHash = hashRules(setup.rules);
    this.seed = setup.seed;
    this.seats = setup.seats;
    this.phaseValue = MatchPhase.Commit;
    this.roundValue = 1;
    this.root = historySeed(setup.matchId, this.rulesHash, setup.seed);
    this.states = setup.seats.map((seat) => ({
      index: seat.index,
      hp: setup.rules.startingHp,
      alive: true,
      eliminatedInRound: 0,
      timeouts: 0,
      charged: false,
      lastAction: Action.None,
    }));
  }

  get phase(): MatchPhaseValue {
    return this.phaseValue;
  }

  get round(): number {
    return this.roundValue;
  }

  get historyRoot(): `0x${string}` {
    return this.root;
  }

  get history(): readonly RoundRecord[] {
    return this.rounds;
  }

  get alive(): number[] {
    return this.states.filter((state) => state.alive).map((state) => state.index);
  }

  playerState(seat: number): PlayerState {
    const state = this.states[seat];
    if (state === undefined) throw new MatchError('UNKNOWN_SEAT', `no seat ${seat}`);
    return { ...state };
  }

  /** Records a blinded commitment. Rejects unknown, dead, or duplicate seats. */
  submitCommit(seat: number, commitment: `0x${string}`): void {
    this.requirePhase(MatchPhase.Commit);
    this.requireAlive(seat);
    if (this.commitments.has(seat)) {
      throw new MatchError('ALREADY_COMMITTED', `seat ${seat} already committed in round ${this.roundValue}`);
    }
    this.commitments.set(seat, commitment);
  }

  /** True once every living player has committed, so the phase can close early. */
  allCommitted(): boolean {
    return this.alive.every((seat) => this.commitments.has(seat));
  }

  /** Closes the commit window. Seats without a commitment can no longer act this round. */
  openRevealPhase(): void {
    this.requirePhase(MatchPhase.Commit);
    this.phaseValue = MatchPhase.Reveal;
  }

  /**
   * Accepts a reveal and checks it against the stored commitment. A move that
   * does not hash to the commitment is rejected outright: the player is then
   * treated as having timed out rather than being allowed to pick again.
   */
  submitReveal(seat: number, move: SealedMove): void {
    this.requirePhase(MatchPhase.Reveal);
    this.requireAlive(seat);

    const commitment = this.commitments.get(seat);
    if (commitment === undefined) {
      throw new MatchError('NO_COMMITMENT', `seat ${seat} did not commit in round ${this.roundValue}`);
    }
    if (this.reveals.has(seat)) {
      throw new MatchError('ALREADY_REVEALED', `seat ${seat} already revealed in round ${this.roundValue}`);
    }
    this.assertLegalMove(seat, move.action, move.target);

    const expected = commitMove(this.matchId, this.roundValue, seat, move);
    if (expected.toLowerCase() !== commitment.toLowerCase()) {
      throw new MatchError('COMMITMENT_MISMATCH', `reveal from seat ${seat} does not match its commitment`);
    }

    this.reveals.set(seat, {
      index: seat,
      action: move.action,
      target: move.action === Action.Strike ? move.target : 0,
      revealed: true,
      salt: move.salt,
      commitment,
    });
  }

  /**
   * Throws exactly when `submitReveal` would reject `move` from `seat` for what
   * it is rather than for whether it opens the commitment: a seat that is out,
   * an action that is not playable, a Guard or Charge its cooldown rules out,
   * a target that is not a living opponent. For callers that are handed a move
   * before the reveal window, so it can be refused up front.
   */
  assertPlayable(seat: number, move: Move): void {
    this.requireAlive(seat);
    this.assertLegalMove(seat, move.action, move.target);
  }

  /**
   * True once every seat that *can* still act has revealed. A seat that missed
   * the commit window has nothing to open, so waiting on it would only stall
   * the round timer for players who did commit.
   */
  allRevealed(): boolean {
    return this.alive.every((seat) => !this.commitments.has(seat) || this.reveals.has(seat));
  }

  /**
   * Closes the reveal window, resolves the round, and advances the match.
   * Returns the public record that is appended to the history feed.
   */
  resolve(): RoundRecord {
    this.requirePhase(MatchPhase.Reveal);

    const moves: DeclaredMove[] = this.alive.map(
      (seat) =>
        this.reveals.get(seat) ?? {
          index: seat,
          action: Action.None,
          target: 0,
          revealed: false,
          salt: ZERO_SALT,
          commitment: this.commitments.get(seat) ?? NO_COMMITMENT,
        },
    );

    const resolution = resolveRound(this.rules, this.seed, this.roundValue, this.states, moves, this.quietRounds);
    const hash = hashRound(this.roundValue, this.states.length, resolution.record);
    const record: RoundRecord = { ...resolution.record, hash };

    this.states = resolution.states;
    this.quietRounds = resolution.quietRounds;
    this.eliminationSequence.push(...resolution.eliminationOrder);
    this.rounds.push(record);
    this.root = chainHistory(this.root, hash);

    this.commitments.clear();
    this.reveals.clear();

    const survivors = this.alive.length;
    if (survivors <= 1 || this.roundValue >= this.rules.maxRounds) {
      this.phaseValue = MatchPhase.Finished;
    } else {
      this.roundValue += 1;
      this.phaseValue = MatchPhase.Commit;
    }

    return record;
  }

  get finished(): boolean {
    return this.phaseValue === MatchPhase.Finished;
  }

  /**
   * Final ranking, best-first. Survivors are ordered by remaining HP, then by
   * everyone else in reverse elimination order, so a player who lasted longer
   * always outranks a player who fell earlier. Survivors level on HP (only
   * possible when the round cap ends the match) are split by the last round's
   * tiebreak draw, never by seat.
   *
   * `replayMatch` re-derives this independently; see the note in `replay.ts`
   * for why the two are not shared, and `properties.test.ts` for the test that
   * holds them to the same answer.
   */
  ranking(): number[] {
    if (!this.finished) throw new MatchError('BAD_PHASE', 'match has not finished');

    const last = this.rounds[this.rounds.length - 1];
    const entropy = last ? entropyOf(this.seed, this.states.length, last) : this.seed;
    const key = (seat: number) => tiebreakKey(entropy, seat);
    const survivors = this.states
      .filter((state) => state.alive)
      .sort((a, b) => b.hp - a.hp || (key(a.index) < key(b.index) ? -1 : 1))
      .map((state) => state.index);

    return [...survivors, ...[...this.eliminationSequence].reverse()];
  }

  /** The signable result handed to the attestor set. */
  result(): MatchResult {
    return {
      matchId: this.matchId,
      rounds: this.rounds.length,
      historyRoot: this.root,
      ranking: this.ranking().map((seat) => (this.seats[seat] as Seat).address),
    };
  }

  publicState(): PublicMatchState {
    return {
      matchId: this.matchId,
      seed: this.seed,
      rules: this.rules,
      phase: this.phaseValue,
      round: this.roundValue,
      players: this.states.map((state) => {
        const seat = this.seats[state.index] as Seat;
        return {
          index: state.index,
          address: seat.address,
          chainId: seat.chainId,
          hp: state.hp,
          alive: state.alive,
          charged: state.charged,
          lastAction: state.lastAction,
        };
      }),
      // Which seats have acted, never what they did: a revealed salt would
      // let anyone holding the rest of them preview the round's rolls.
      committed: [...this.commitments.keys()].sort((a, b) => a - b),
      commitments:
        this.phaseValue === MatchPhase.Reveal
          ? [...this.commitments].sort(([a], [b]) => a - b).map(([index, commitment]) => ({ index, commitment }))
          : [],
      revealed: [...this.reveals.keys()].sort((a, b) => a - b),
      history: this.rounds,
      historyRoot: this.root,
    };
  }

  private assertLegalMove(seat: number, action: ActionValue, target: number): void {
    if (action !== Action.Strike && action !== Action.Guard && action !== Action.Charge) {
      throw new MatchError('INVALID_MOVE', `seat ${seat} revealed a non-playable action`);
    }
    // A repeated Guard or Charge, or a Charge on top of a loaded one. The
    // player could see the cooldown before committing, so the move is lost.
    if (!isLegalAction(action, this.states[seat] as PlayerState)) {
      throw new MatchError('INVALID_MOVE', `seat ${seat} cannot ${action === Action.Guard ? 'guard' : 'charge'} again yet`);
    }
    if (action !== Action.Strike) return;
    if (target === seat) throw new MatchError('INVALID_MOVE', `seat ${seat} cannot strike itself`);
    const victim = this.states[target];
    if (victim === undefined) throw new MatchError('INVALID_MOVE', `seat ${seat} targeted nonexistent seat ${target}`);
    if (!victim.alive) throw new MatchError('INVALID_MOVE', `seat ${seat} targeted eliminated seat ${target}`);
  }

  private requirePhase(expected: MatchPhaseValue): void {
    if (this.phaseValue !== expected) {
      throw new MatchError('BAD_PHASE', `expected phase ${expected} but match is in ${this.phaseValue}`);
    }
  }

  private requireAlive(seat: number): void {
    const state = this.states[seat];
    if (state === undefined) throw new MatchError('UNKNOWN_SEAT', `no seat ${seat}`);
    if (!state.alive) throw new MatchError('SEAT_ELIMINATED', `seat ${seat} is eliminated`);
  }
}
