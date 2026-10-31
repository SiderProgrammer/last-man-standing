import {
  Action,
  chainHistory,
  hashRound,
  hashRules,
  historySeed,
  type MatchResult,
  type PlayerState,
  type RoundRecord,
  type Seat,
} from '@lms/consensus';
import type { MatchSetup } from './match.js';
import { entropyOf, resolveRound, tiebreakKey, type DeclaredMove } from '../kernel/resolve.js';

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
    charged: false,
    lastAction: Action.None,
  }));

  const rounds: RoundRecord[] = [];
  const eliminationSequence: number[] = [];
  let quietRounds = 0;

  for (const [offset, moves] of moveLog.entries()) {
    const round = offset + 1;
    const resolution = resolveRound(setup.rules, setup.seed, round, states, moves, quietRounds);
    const hash = hashRound(round, states.length, resolution.record);
    rounds.push({ ...resolution.record, hash });
    root = chainHistory(root, hash);
    states = resolution.states;
    quietRounds = resolution.quietRounds;
    eliminationSequence.push(...resolution.eliminationOrder);
  }

  const last = rounds[rounds.length - 1];
  const entropy = last ? entropyOf(setup.seed, states.length, last) : setup.seed;
  const key = (seat: number) => tiebreakKey(entropy, seat);
  const survivors = states
    .filter((state) => state.alive)
    .sort((a, b) => b.hp - a.hp || (key(a.index) < key(b.index) ? -1 : 1))
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

/**
 * The move log a published history implies, ready to hand to `replayMatch`.
 *
 * Every `RoundRecord` carries each living seat's action, target, reveal flag
 * and salt, which is exactly what resolution consumes. Extracting them is pure
 * data plumbing — no rule is applied here — so it does not weaken the
 * independence of the replay: a fabricated record still has to hash to the
 * root the attestors signed.
 */
export function moveLogFromHistory(history: readonly RoundRecord[]): DeclaredMove[][] {
  return history.map((record) =>
    record.moves.map((move) => ({
      index: move.index,
      action: move.action,
      target: move.target,
      revealed: move.revealed,
      salt: move.salt,
      commitment: move.commitment,
    })),
  );
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
