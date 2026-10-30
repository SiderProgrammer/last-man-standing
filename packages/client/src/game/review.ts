import { MatchPhase, cooldownsFrom, sameAddress, type PublicMatchState, type ReviewedMatch } from '@lms/protocol';

/** An archived match, rebuilt into what the match screen draws. */
export interface Review {
  /** The table as the last round left it. */
  state: PublicMatchState;
  /** The viewer's seat, or null when they only watched. */
  you: number | null;
  /** Seat indices ordered best-first, as a live `finished` carries them. */
  ranking: number[];
}

/**
 * Rebuilds the final snapshot of a finished match from its archive record.
 *
 * Only the archive's own fields go in — seed, rules, seats, rounds — so the
 * browser check that runs on it next is exactly the one a live match gets.
 */
export function reviewOf(match: ReviewedMatch, viewer: `0x${string}` | null): Review {
  const last = match.history.at(-1);
  const eliminated = new Set(match.history.flatMap((record) => record.eliminated));

  const state: PublicMatchState = {
    matchId: match.result.matchId,
    seed: match.seed,
    rules: match.rules,
    phase: MatchPhase.Finished,
    round: match.result.rounds,
    players: match.seats.map((seat) => ({
      index: seat.index,
      address: seat.address,
      chainId: seat.chainId,
      hp: last?.hpAfter[seat.index] ?? match.rules.startingHp,
      alive: !eliminated.has(seat.index),
      ...cooldownsFrom(match.history, seat.index),
    })),
    committed: [],
    commitments: [],
    revealed: [],
    history: match.history,
    historyRoot: match.result.historyRoot,
  };

  const seatOf = (address: string) => match.seats.find((seat) => sameAddress(seat.address, address))?.index;
  const ranking = match.result.ranking
    .map(seatOf)
    .filter((seat): seat is number => seat !== undefined);

  return { state, you: viewer ? (seatOf(viewer) ?? null) : null, ranking };
}
