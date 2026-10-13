import { Action, type MatchResult, type RoundRecord } from './types.js';
import { addressKey } from '../util/address.js';

/**
 * A wallet's play style across every match it has settled.
 *
 * The reads panel used to forget a player the moment their room closed. Kept
 * by wallet instead, a regular arrives with a record: how often they swing,
 * turtle or vanish, and how often it works. Everything here comes from
 * published, settled rounds — the same history any player could have written
 * down — so it reveals nothing that was ever hidden.
 */
export interface PlayStyle {
  matches: number;
  wins: number;
  attacks: number;
  defends: number;
  hides: number;
  noShows: number;
}

export function emptyStyle(): PlayStyle {
  return { matches: 0, wins: 0, attacks: 0, defends: 0, hides: 0, noShows: 0 };
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
      else if (move.action === Action.Attack) style.attacks += 1;
      else if (move.action === Action.Defend) style.defends += 1;
      else if (move.action === Action.Hide) style.hides += 1;
    }
  }
  return styles;
}

export function addStyles(a: PlayStyle, b: PlayStyle): PlayStyle {
  return {
    matches: a.matches + b.matches,
    wins: a.wins + b.wins,
    attacks: a.attacks + b.attacks,
    defends: a.defends + b.defends,
    hides: a.hides + b.hides,
    noShows: a.noShows + b.noShows,
  };
}

/** One line for the reads panel, or empty for a stranger. */
export function describeStyle(style: PlayStyle | undefined): string {
  if (!style || style.matches === 0) return '';
  const moves = style.attacks + style.defends + style.hides;
  const pct = (n: number) => (moves === 0 ? 0 : Math.round((n / moves) * 100));
  const parts = [`${style.matches} match${style.matches === 1 ? '' : 'es'}`, `${style.wins} won`];
  if (moves > 0) parts.push(`⚔️${pct(style.attacks)}% 🛡️${pct(style.defends)}% 🏃${pct(style.hides)}%`);
  if (style.noShows > 0) parts.push(`${style.noShows} no-show${style.noShows === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
