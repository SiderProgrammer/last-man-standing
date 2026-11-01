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
