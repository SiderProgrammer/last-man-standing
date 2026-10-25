import { cooldownsFrom, type PublicMatchState } from '@lms/protocol';

/**
 * The table as it stood when a round began, rebuilt from the published
 * history: what the arena has to show before it plays that round back.
 *
 * Pure bookkeeping over records every client already holds — the HP each
 * round left behind, and who it eliminated — so jumping around a finished
 * match needs nothing from the server.
 *
 * @returns null for a round the match never played.
 */
export function stateBeforeRound(state: PublicMatchState, round: number): PublicMatchState | null {
  const index = state.history.findIndex((record) => record.round === round);
  if (index < 0) return null;
  const earlier = state.history.slice(0, index);
  const previous = earlier[earlier.length - 1];
  const out = new Set(earlier.flatMap((record) => record.eliminated));

  return {
    ...state,
    round,
    committed: [],
    revealed: [],
    history: earlier,
    players: state.players.map((player) => ({
      ...player,
      hp: previous ? Math.max(0, previous.hpAfter[player.index] ?? 0) : state.rules.startingHp,
      alive: !out.has(player.index),
      ...cooldownsFrom(earlier, player.index),
    })),
  };
}
