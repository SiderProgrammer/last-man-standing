import type { PlayStyle } from '@lms/api';

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
