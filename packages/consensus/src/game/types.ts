import type { Rules } from './rules.js';

/**
 * Core protocol types shared by the game engine, the authoritative server,
 * the browser client, and the Solidity settlement layer.
 *
 * Every numeric value here is an integer. The engine must produce bit-identical
 * results on any machine so that a match can be replayed and its result hash
 * re-derived independently by a verifier.
 */

/** Action identifiers. Values are part of the wire format and the commit hash. */
export const Action = {
  /** No action recorded (timed out, or an illegal move). Takes every strike in full. */
  None: 0,
  /** Hit a chosen seat. A landed hit heals the striker part of the damage. */
  Strike: 1,
  /** Block one strike and reflect damage onto that striker. Never two rounds running. */
  Guard: 2,
  /** Load the next Strike with bonus damage, at the cost of taking more this round. Never two rounds running. */
  Charge: 3,
} as const;

export type ActionValue = (typeof Action)[keyof typeof Action];

export const ACTION_NAMES: Record<ActionValue, string> = {
  [Action.None]: 'none',
  [Action.Strike]: 'strike',
  [Action.Guard]: 'guard',
  [Action.Charge]: 'charge',
};

/** How well the house bots play. Easy bots blunder often; hard bots never do. */
export const BOT_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;

export type BotDifficulty = (typeof BOT_DIFFICULTIES)[number];

/** A player's hidden choice for one round, before it is committed. */
export interface Move {
  action: ActionValue;
  /**
   * Seat index of the strike target. Ignored (and forced to 0 in the commit
   * hash) for every action other than Strike.
   */
  target: number;
}

/** A move plus the salt that blinds its commitment hash. */
export interface SealedMove extends Move {
  /** 32-byte hex salt, unique per player per round. */
  salt: `0x${string}`;
}

/** Seat assignment inside a match. Seat index is stable for the whole match. */
export interface Seat {
  index: number;
  /** Wallet that staked for this seat. */
  address: `0x${string}`;
  /** EVM chain the stake was placed on. Enables cross-chain lobbies. */
  chainId: number;
}

/** Mutable per-player state tracked by the engine. */
export interface PlayerState {
  index: number;
  hp: number;
  alive: boolean;
  /** Round in which the player was eliminated, or 0 while still alive. */
  eliminatedInRound: number;
  /** Number of rounds the player failed to reveal a move. */
  timeouts: number;
  /** True while a Charge is loaded: the player's next Strike deals bonus damage. */
  charged: boolean;
  /**
   * What the player did last round (`None` before the first). Guard and Charge
   * cannot be repeated, so this is what decides which moves are legal now.
   */
  lastAction: ActionValue;
}

/** Why an individual strike did or did not connect. */
export const StrikeOutcome = {
  /** Damage applied to the target. */
  Hit: 'hit',
  /**
   * Target was guarding and picked this striker to block: no damage, and the
   * striker takes the reflected damage. A guard blocks one striker per round;
   * the others connect.
   */
  Guarded: 'guarded',
  /** Target was already eliminated, or the target index was invalid. */
  Void: 'void',
} as const;

export type StrikeOutcomeValue = (typeof StrikeOutcome)[keyof typeof StrikeOutcome];

/** One resolved strike, published in the round history. */
export interface StrikeRecord {
  striker: number;
  target: number;
  outcome: StrikeOutcomeValue;
  /** True when the strike spent a loaded Charge, hit or not. */
  charged: boolean;
  /** Damage dealt to the target. */
  damage: number;
  /** HP the striker regained from landing it. */
  heal: number;
  /** Damage the target's Guard reflected back onto the striker. */
  reflected: number;
}

/** The public, post-reveal record of a single round. */
export interface RoundRecord {
  round: number;
  /**
   * Declared move of every player that was alive at the start of the round,
   * with the salt it was revealed under (`ZERO_SALT` if it was not revealed)
   * and the commitment it was sealed under.
   */
  moves: Array<{
    index: number;
    action: ActionValue;
    target: number;
    revealed: boolean;
    salt: `0x${string}`;
    /**
     * The commitment the seat sealed this round, or `NO_COMMITMENT` if it
     * sealed none. Published for every seat, revealed or not, so a reveal can
     * be checked against what was committed, and so a commitment the server
     * took cannot later vanish from the record.
     */
    commitment: `0x${string}`;
  }>;
  strikes: StrikeRecord[];
  /**
   * Stall penalty applied to every living player at the end of the round:
   * non-zero only once the table has gone `stallGraceRounds` rounds without a
   * single hit, and growing for every further quiet round.
   */
  stallDamage: number;
  /** Seat indices eliminated this round, in deterministic tie-broken order. */
  eliminated: number[];
  /** HP of every seat after the round, indexed by seat. */
  hpAfter: number[];
  /** keccak256 commitment over this round, chained into the history root. */
  hash: `0x${string}`;
}

export const MatchPhase = {
  /** Waiting for the seats to fill. */
  Lobby: 'lobby',
  /** Players are submitting commitment hashes. */
  Commit: 'commit',
  /** Players are revealing the moves behind their commitments. */
  Reveal: 'reveal',
  /** The match ended and the result is ready to be attested. */
  Finished: 'finished',
  /** The match was abandoned before it could produce a result. */
  Aborted: 'aborted',
} as const;

export type MatchPhaseValue = (typeof MatchPhase)[keyof typeof MatchPhase];

/** Snapshot safe to broadcast to every player, including spectators. */
export interface PublicMatchState {
  matchId: `0x${string}`;
  /**
   * The oracle seed. Public on-chain from `MatchStarted` anyway, and safe to
   * publish: rolls come from each round's commitments, not from this alone.
   * Together with `rules`, the seats and `history`, it is everything a client
   * needs to replay the match and check the result for itself.
   */
  seed: `0x${string}`;
  rules: Rules;
  phase: MatchPhaseValue;
  round: number;
  players: Array<{
    index: number;
    address: `0x${string}`;
    chainId: number;
    hp: number;
    alive: boolean;
    /** A loaded Charge, visible to everyone: this seat's next Strike hits harder. */
    charged: boolean;
    /** Last round's action, which decides whether Guard or Charge is on cooldown. */
    lastAction: ActionValue;
  }>;
  /** Seats whose commitment has been received this round. */
  committed: number[];
  /**
   * Every commitment taken this round, by seat, once the commit window has
   * closed; empty while it is open. Withheld until then because the round's
   * rolls are drawn from the full set: a player who could see the others'
   * commitments while still choosing a salt could grind the rolls.
   */
  commitments: Array<{ index: number; commitment: `0x${string}` }>;
  /** Seats whose reveal has been accepted this round. */
  revealed: number[];
  history: RoundRecord[];
  historyRoot: `0x${string}`;
}

/** Final, signable outcome of a match. */
export interface MatchResult {
  matchId: `0x${string}`;
  /** Number of rounds actually played. */
  rounds: number;
  /** Chained keccak256 commitment over every round record. */
  historyRoot: `0x${string}`;
  /** Seat addresses ordered best-first. `ranking[0]` is the winner. */
  ranking: `0x${string}`[];
}

/** A move that breaks the match rules, as the engine's `MatchError` names it. */
export type MatchErrorCode =
  | 'BAD_PHASE'
  | 'UNKNOWN_SEAT'
  | 'SEAT_ELIMINATED'
  | 'ALREADY_COMMITTED'
  | 'NO_COMMITMENT'
  | 'COMMITMENT_MISMATCH'
  | 'ALREADY_REVEALED'
  | 'INVALID_MOVE';
