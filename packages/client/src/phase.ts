import { MatchPhase, type PublicMatchState } from '@lms/protocol';

/** What the controls should look like, and whether a reveal is now due. */
export interface PhasePlan {
  label: string;
  actionsEnabled: boolean;
  lockInDisabled: boolean;
  betDisabled: boolean;
  /**
   * New status line, or null to leave the current one alone.
   *
   * Null is not an oversight: the reveal and finished phases deliberately keep
   * whatever the previous step wrote, because `revealNow` and `lockControls`
   * set a more specific message than this function could.
   */
  statusText: string | null;
  /**
   * True when the reveal for this round has not been sent yet.
   *
   * The caller acts on it. Keeping the decision here and the sending there is
   * the whole reason this function is pure — it used to send the reveal itself,
   * from inside what was otherwise a render pass.
   */
  shouldReveal: boolean;
}

export interface PhaseContext {
  you: number | null;
  committedRound: number | null;
  revealedRound: number | null;
  draft: unknown;
}

/**
 * The player's half of the commit-reveal handshake, as a pure function.
 *
 * The reveal is due as soon as the server opens the window: the player already
 * chose during the commit phase, and asking them to click a second time would
 * only manufacture no-shows.
 */
export function phasePlan(state: PublicMatchState, context: PhaseContext): PhasePlan {
  const seated = context.you !== null;
  const committed = context.committedRound === state.round;

  if (state.phase === MatchPhase.Commit) {
    return {
      label: `Round ${state.round} — commit`,
      actionsEnabled: seated && !committed,
      lockInDisabled: !seated || committed || context.draft === null,
      betDisabled: !seated,
      statusText: committed
        ? 'Move sealed. Waiting for the table.'
        : seated
          ? 'Pick an action before the timer runs out.'
          : 'Spectating — no seat in this match.',
      shouldReveal: false,
    };
  }

  if (state.phase === MatchPhase.Reveal) {
    return {
      label: `Round ${state.round} — reveal`,
      actionsEnabled: false,
      lockInDisabled: true,
      betDisabled: true,
      statusText: null,
      shouldReveal: seated && context.revealedRound !== state.round,
    };
  }

  return {
    label: state.phase === MatchPhase.Finished ? 'Finished' : 'Waiting',
    actionsEnabled: false,
    lockInDisabled: true,
    betDisabled: true,
    statusText: null,
    shouldReveal: false,
  };
}
