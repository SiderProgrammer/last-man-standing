/**
 * The post-match analyst's output, as it crosses the wire.
 *
 * Commentary, never consensus: nothing here feeds the engine, the result
 * hash or settlement. An analysis is written from a match's published
 * history after the match is over, and a client is free to ignore it.
 *
 * A key moment is a claim *about* the history in a shape that can be checked
 * against it — which round, which seat, what kind of event, against whom —
 * plus a sentence for people. The server drops every moment whose structured
 * part the history does not bear out before it is sent, so the sentence is
 * the only part a reader has to take on trust.
 */

/**
 * What a key moment claims happened. Each is checkable against one
 * `RoundRecord`:
 *
 * - `attack`     `seat` declared an attack on `target`.
 * - `hit`        `seat`'s attack on `target` connected.
 * - `parry`      `seat` defended and parried `target`'s attack.
 * - `evade`      `seat` hid and evaded `target`'s attack.
 * - `defend`     `seat` defended.
 * - `hide`       `seat` hid.
 * - `timeout`    `seat` failed to reveal a move.
 * - `eliminated` `seat` was eliminated.
 */
export const KEY_MOMENT_KINDS = [
  'attack',
  'hit',
  'parry',
  'evade',
  'defend',
  'hide',
  'timeout',
  'eliminated',
] as const;

export type KeyMomentKind = (typeof KEY_MOMENT_KINDS)[number];

/** Kinds that name a second seat; the rest must leave `target` null. */
export const TARGETED_MOMENT_KINDS: readonly KeyMomentKind[] = ['attack', 'hit', 'parry', 'evade'];

export interface KeyMoment {
  /** 1-based round, as in `RoundRecord.round`. */
  round: number;
  seat: number;
  kind: KeyMomentKind;
  /** The other seat involved, for the targeted kinds; null otherwise. */
  target: number | null;
  /** One sentence for the reader. Not machine-checked. */
  claim: string;
}

export interface MatchAnalysis {
  matchId: `0x${string}`;
  /** Whose perspective the advice is written from; null for a spectator. */
  seat: number | null;
  /** A few paragraphs of narrative. */
  summary: string;
  /** The round the analyst judges decided the match, or null if it named none that exists. */
  decisiveRound: number | null;
  /** Only moments the server verified against the history. */
  keyMoments: KeyMoment[];
  advice: string[];
  /** Moments the model produced that the history did not support, and were dropped. */
  dropped: number;
  /**
   * The model that wrote the final answer, as the API reported it. Usually the
   * one configured, but a refusal fallback can hand the answer to another.
   * `demo` for the offline demo analyst.
   */
  model: string;
}

/**
 * Why an analysis request failed. Machine-readable so the client can choose
 * between "try again", "not for you" and "not on this server".
 */
export type AnalysisErrorCode =
  /** The server has no model credentials, or the model rejected them. */
  | 'unavailable'
  /** No archived match with that id: still running, never finished, or unknown. */
  | 'not_found'
  /** The match is private to the players who sat in it. */
  | 'forbidden'
  /** This wallet has used its analyses for now. */
  | 'quota'
  /** The model provider is rate limiting or overloaded. */
  | 'busy'
  /** The model took too long. */
  | 'timeout'
  /** The model declined to write the analysis. */
  | 'refused'
  /** Anything else: a malformed answer, a provider error. */
  | 'failed';
