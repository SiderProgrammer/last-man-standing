import { MatchPhase, type PublicMatchState } from '@lms/consensus';

/** What the controls should look like, and whether a reveal is now due. */
export interface PhasePlan {
  label: string;
  actionsEnabled: boolean;
  lockInDisabled: boolean;
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
   * The caller acts on it: the decision is made here and the sending in an
   * action, so nothing that renders ever sends.
   */
  shouldReveal: boolean;
}

export interface PhaseContext {
  you: number | null;
  committedRound: number | null;
  revealedRound: number | null;
  draft: unknown;
  /**
   * True while the last round is being replayed. The server holds the next
   * commit clock for exactly this long, so nobody loses decision time to it.
   */
  replaying?: boolean;
}

/**
 * The player's half of the commit-reveal handshake, as a pure function.
 *
 * The reveal is due as soon as the server opens the window: the player already
 * chose during the commit phase, and asking them to click a second time would
 * only manufacture no-shows.
 */
export function phasePlan(state: PublicMatchState, context: PhaseContext): PhasePlan {
  // An eliminated seat has nothing left to commit or reveal: it watches.
  const eliminated =
    context.you !== null && state.players.some((player) => player.index === context.you && !player.alive);
  const seated = context.you !== null && !eliminated;
  const committed = context.committedRound === state.round;

  // The replay is of the round that just resolved; the snapshot has already
  // moved on to the next one, whose commit window the replay holds closed.
  const replayed = Math.max(1, state.round - 1);

  if (eliminated && (state.phase === MatchPhase.Commit || state.phase === MatchPhase.Reveal)) {
    const replaying = context.replaying && state.phase === MatchPhase.Commit;
    return {
      label: replaying ? `Round ${replayed} — replay` : `Round ${state.round} — spectating`,
      actionsEnabled: false,
      lockInDisabled: true,
      statusText: 'You were eliminated. Watching the rest of the match.',
      shouldReveal: false,
    };
  }

  if (state.phase === MatchPhase.Commit && context.replaying) {
    return {
      label: `Round ${replayed} — replay`,
      actionsEnabled: false,
      lockInDisabled: true,
      statusText: 'Watching the last round…',
      shouldReveal: false,
    };
  }

  if (state.phase === MatchPhase.Commit) {
    return {
      label: `Round ${state.round} — commit`,
      actionsEnabled: seated && !committed,
      lockInDisabled: !seated || committed || context.draft === null,
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
      statusText: null,
      // Not when the server already opened a move it was holding for us:
      // a second reveal would only come back as an error.
      shouldReveal:
        seated &&
        context.revealedRound !== state.round &&
        !(context.you !== null && state.revealed.includes(context.you)),
    };
  }

  return {
    label: state.phase === MatchPhase.Finished ? 'Finished' : 'Waiting',
    actionsEnabled: false,
    lockInDisabled: true,
    statusText: null,
    shouldReveal: false,
  };
}
