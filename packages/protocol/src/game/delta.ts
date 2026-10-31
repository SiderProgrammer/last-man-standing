import type { PublicMatchState, RoundRecord } from './types.js';

/**
 * What a match's state can change by from one moment to the next: all of it
 * but the seed and rules, which never change, and the history, which only
 * ever grows by the round a `round` frame already carries. A delta's size is
 * the table's, not the match's length.
 */
export type MatchDelta = Omit<PublicMatchState, 'seed' | 'rules' | 'history'>;

/** The delta that brings any earlier state of the same match to `state`. */
export function matchDelta(state: PublicMatchState): MatchDelta {
  const { seed: _seed, rules: _rules, history: _history, ...delta } = state;
  return delta;
}

/** `state` moved on by `delta`. The history is `state`'s own: rounds arrive apart, through `withRound`. */
export function applyDelta(state: PublicMatchState, delta: MatchDelta): PublicMatchState {
  return { ...state, ...delta, seed: state.seed, rules: state.rules, history: state.history };
}

/** `state` with `record` at the end of its history, unless it is there already. */
export function withRound(state: PublicMatchState, record: RoundRecord): PublicMatchState {
  if (state.history.some((entry) => entry.round === record.round)) return state;
  return { ...state, history: [...state.history, record] };
}
