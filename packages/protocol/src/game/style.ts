import { Action, type MatchResult, type RoundRecord } from './types.js';
import { addressKey } from '../util/address.js';

/**
 * A wallet's play style across every match it has settled.
 *
 * The reads panel used to forget a player the moment their room closed. Kept
 * by wallet instead, a regular arrives with a record: how often they strike,
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

export function emptyStyle(): PlayStyle {
  return { matches: 0, wins: 0, strikes: 0, guards: 0, charges: 0, noShows: 0 };
}

/** One match's contribution to each seat's style, keyed by lowercased address. */
export function tallyStyles(
  result: MatchResult,
  history: readonly RoundRecord[],
  seatAddresses: readonly `0x${string}`[],
): Map<string, PlayStyle> {
  const styles = new Map<string, PlayStyle>();
  for (const address of seatAddresses) {
    styles.set(addressKey(address), { ...emptyStyle(), matches: 1 });
  }
  const winner = result.ranking[0];
  if (winner) {
    const style = styles.get(addressKey(winner));
    if (style) style.wins = 1;
  }

  for (const record of history) {
    for (const move of record.moves) {
      const address = seatAddresses[move.index];
      const style = address ? styles.get(addressKey(address)) : undefined;
      if (!style) continue;
      if (!move.revealed) style.noShows += 1;
      else if (move.action === Action.Strike) style.strikes += 1;
      else if (move.action === Action.Guard) style.guards += 1;
      else if (move.action === Action.Charge) style.charges += 1;
    }
  }
  return styles;
}

export function addStyles(a: PlayStyle, b: PlayStyle): PlayStyle {
  return {
    matches: a.matches + b.matches,
    wins: a.wins + b.wins,
    strikes: a.strikes + b.strikes,
    guards: a.guards + b.guards,
    charges: a.charges + b.charges,
    noShows: a.noShows + b.noShows,
  };
}

/** One line for the reads panel, or empty for a stranger. */
export function describeStyle(style: PlayStyle | undefined): string {
  if (!style || style.matches === 0) return '';
  const moves = style.strikes + style.guards + style.charges;
  const pct = (n: number) => (moves === 0 ? 0 : Math.round((n / moves) * 100));
  const parts = [`${style.matches} match${style.matches === 1 ? '' : 'es'}`, `${style.wins} won`];
  if (moves > 0) parts.push(`⚔️${pct(style.strikes)}% 🛡️${pct(style.guards)}% ⚡${pct(style.charges)}%`);
  if (style.noShows > 0) parts.push(`${style.noShows} no-show${style.noShows === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
