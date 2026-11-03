import { Action, type RoundRecord } from '@lms/consensus';

/**
 * A wallet's play style across every match it has settled.
 *
 * Kept by wallet, so a regular arrives with a record: how often they strike,
 * guard or charge, and how often it works. Everything here comes from
 * published, settled rounds — the same history any player could have written
 * down — so it reveals nothing that was ever hidden.
 */
export interface PlayStyle {
  matches: number;
  wins: number;
  strikes: number;
  guards: number;
  charges: number;
  noShows: number;
}

/** What one seat did over some rounds. */
export interface SeatTally {
  strikes: number;
  guards: number;
  charges: number;
  /** Rounds it committed to and never revealed. */
  noShows: number;
  /** How often it struck each seat, by seat. */
  targets: Map<number, number>;
}

/**
 * Counts what `seat` did in `history`: the bookkeeping behind the reads
 * panel, the analyst's briefing and the style book, which all describe a
 * seat from the same published rounds.
 */
export function tallySeat(history: readonly RoundRecord[], seat: number): SeatTally {
  const tally: SeatTally = { strikes: 0, guards: 0, charges: 0, noShows: 0, targets: new Map() };
  for (const record of history) {
    const move = record.moves.find((entry) => entry.index === seat);
    if (!move) continue;
    if (!move.revealed) tally.noShows += 1;
    else if (move.action === Action.Guard) tally.guards += 1;
    else if (move.action === Action.Charge) tally.charges += 1;
    else if (move.action === Action.Strike) {
      tally.strikes += 1;
      tally.targets.set(move.target, (tally.targets.get(move.target) ?? 0) + 1);
    }
  }
  return tally;
}

/** The seat struck most often, the lower seat on a tie, and how many times; null for a seat that never struck. */
export function favouriteTarget(targets: ReadonlyMap<number, number>): { seat: number; hits: number } | null {
  const [best] = [...targets].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return best ? { seat: best[0], hits: best[1] } : null;
}
