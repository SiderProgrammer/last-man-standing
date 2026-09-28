import {
  chainHistory,
  hashRound,
  hashRules,
  historySeed,
  type MatchResult,
  type PlayerState,
  type RoundRecord,
  type Seat,
} from '@lms/protocol';
import type { MatchSetup } from './match.js';
import { resolveRound, type DeclaredMove } from '../kernel/resolve.js';

export interface ReplayResult {
  result: MatchResult;
  rounds: RoundRecord[];
}

/**
 * Recomputes a match from its setup and the revealed moves of every round.
 *
 * This is the audit path: a player who distrusts the server can take the
 * published seed and move log, replay them here, and check that the history
 * root the attestors signed is the one the moves actually produce. It shares
 * no state with `Match`, only the pure `resolveRound` kernel.
 *
 * The initial state, the per-round fold and the ranking rule below are
 * therefore written out a second time rather than shared with `Match`. That is
 * deliberate and should stay: extracting them would make `verifyResult` a
 * tautology, because a wrong ranking rule would produce a wrong result and a
 * wrong replay that agree with each other perfectly. The duplication is paid
 * for by `packages/engine/test/properties.test.ts`, which replays 40 matches
 * across both bot strategies and asserts the two derivations agree.
 */
export function replayMatch(setup: MatchSetup, moveLog: readonly (readonly DeclaredMove[])[]): ReplayResult {
  const rulesHash = hashRules(setup.rules);
  let root = historySeed(setup.matchId, rulesHash, setup.seed);

  let states: PlayerState[] = setup.seats.map((seat) => ({
    index: seat.index,
    hp: setup.rules.startingHp,
    alive: true,
    eliminatedInRound: 0,
    timeouts: 0,
  }));

  const rounds: RoundRecord[] = [];
  const eliminationSequence: number[] = [];

  for (const [offset, moves] of moveLog.entries()) {
    const round = offset + 1;
    const resolution = resolveRound(setup.rules, setup.seed, round, states, moves);
    const hash = hashRound(round, states.length, resolution.record);
    rounds.push({ ...resolution.record, hash });
    root = chainHistory(root, hash);
    states = resolution.states;
    eliminationSequence.push(...resolution.eliminationOrder);
  }

  const survivors = states
    .filter((state) => state.alive)
    .sort((a, b) => (b.hp !== a.hp ? b.hp - a.hp : a.index - b.index))
    .map((state) => state.index);

  const ranking = [...survivors, ...[...eliminationSequence].reverse()];

  return {
    result: {
      matchId: setup.matchId,
      rounds: rounds.length,
      historyRoot: root,
      ranking: ranking.map((seat) => (setup.seats[seat] as Seat).address),
    },
    rounds,
  };
}

/** True when a claimed result matches an independent replay of the move log. */
export function verifyResult(
  setup: MatchSetup,
  moveLog: readonly (readonly DeclaredMove[])[],
  claimed: MatchResult,
): boolean {
  const { result } = replayMatch(setup, moveLog);
  return (
    result.matchId.toLowerCase() === claimed.matchId.toLowerCase() &&
    result.rounds === claimed.rounds &&
    result.historyRoot.toLowerCase() === claimed.historyRoot.toLowerCase() &&
    result.ranking.length === claimed.ranking.length &&
    result.ranking.every(
      (address, i) => address.toLowerCase() === (claimed.ranking[i] ?? '').toLowerCase(),
    )
  );
}
