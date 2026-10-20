import { ACTION_NAMES, Action, MatchPhase, type ActionValue, type MatchPhaseValue } from '@lms/protocol';

/** Presentation helpers. Pure, so they can be tested without a DOM. */

/** Truncates a hash or address to something that fits in a label. */
export function short(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** How a chosen move reads back to the player before it is sealed. */
export function describeDraft(draft: { action: ActionValue; target: number }): string {
  return draft.action === Action.Attack ? `attack #${draft.target}` : ACTION_NAMES[draft.action];
}

/** Time left in the round, or `--` when no clock is running. */
export function formatCountdown(
  phase: MatchPhaseValue | null,
  deadline: number,
  now: number,
): string {
  if (phase === null || phase === MatchPhase.Finished) return '--';
  return `${(Math.max(0, deadline - now) / 1000).toFixed(1)}s`;
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
export function ordinal(value: number): string {
  const suffix = value % 100 >= 11 && value % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][value % 10] ?? 'th');
  return `${value}${suffix}`;
}

/** Where a player finished, as the history list shows it. */
export function placeLabel(place: number, players: number): string {
  if (place === 1) return 'Won';
  if (place < 1) return 'Played';
  return `${ordinal(place)} of ${players}`;
}
