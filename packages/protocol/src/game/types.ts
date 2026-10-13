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
  /** No action recorded (player timed out). Takes every attack and the full storm. */
  None: 0,
  /** Attempt to eliminate another player. */
  Attack: 1,
  /** Block incoming attacks and riposte the attacker. */
  Defend: 2,
  /** Evade attacks with high probability, but exposed to the storm. */
  Hide: 3,
} as const;

export type ActionValue = (typeof Action)[keyof typeof Action];

export const ACTION_NAMES: Record<ActionValue, string> = {
  [Action.None]: 'none',
  [Action.Attack]: 'attack',
  [Action.Defend]: 'defend',
  [Action.Hide]: 'hide',
};

/** A player's hidden choice for one round, before it is committed. */
export interface Move {
  action: ActionValue;
  /**
   * Seat index of the attack target. Ignored (and forced to 0 in the commit
   * hash) for every action other than Attack.
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
}

/** Why an individual attack did or did not connect. */
export const AttackOutcome = {
  /** Damage applied to the target. */
  Hit: 'hit',
  /**
   * Target was defending and chose this attacker to parry: no damage, the
   * attacker takes riposte damage. A defender parries one attacker per round;
   * the others connect.
   */
  Parried: 'parried',
  /** Target was hiding and evaded the roll. */
  Missed: 'missed',
  /** Target was already eliminated, or the target index was invalid. */
  Void: 'void',
} as const;

export type AttackOutcomeValue = (typeof AttackOutcome)[keyof typeof AttackOutcome];

/** One resolved attack, published in the round history. */
export interface AttackRecord {
  attacker: number;
  target: number;
  outcome: AttackOutcomeValue;
  /** Damage dealt to the target. */
  damage: number;
  /** Damage reflected back onto the attacker. */
  riposte: number;
}

/** The public, post-reveal record of a single round. */
export interface RoundRecord {
  round: number;
  /**
   * Declared move of every player that was alive at the start of the round,
   * with the salt it was revealed under (`ZERO_SALT` if it was not revealed).
   * The salts are published so anyone can recompute the round's rolls.
   */
  moves: Array<{
    index: number;
    action: ActionValue;
    target: number;
    revealed: boolean;
    salt: `0x${string}`;
  }>;
  attacks: AttackRecord[];
  /** Storm damage applied to every surviving player at the end of the round. */
  stormDamage: number;
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
   * publish: rolls come from each round's revealed salts, not from this alone.
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
  }>;
  /** Seats whose commitment has been received this round. */
  committed: number[];
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
