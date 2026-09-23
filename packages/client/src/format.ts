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
