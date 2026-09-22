import { describe, expect, it } from 'vitest';
import { MatchPhase, type MatchPhaseValue, type PublicMatchState } from '@lms/protocol';
import { phasePlan, type PhaseContext } from '../src/phase.js';
import { stateWith } from './helpers.js';

function at(phase: MatchPhaseValue, round = 3): PublicMatchState {
  return { ...stateWith(4, []), phase, round };
}

const SPECTATOR: PhaseContext = {
  you: null,
  committedRound: null,
  revealedRound: null,
  draft: null,
};

const SEATED: PhaseContext = { ...SPECTATOR, you: 0 };

describe('commit phase', () => {
  it('opens the actions for a seated player who has not committed', () => {
    expect(phasePlan(at(MatchPhase.Commit), SEATED)).toEqual({
      label: 'Round 3 — commit',
      actionsEnabled: true,
      // No draft yet, so there is nothing to lock in.
      lockInDisabled: true,
      betDisabled: false,
      statusText: 'Pick an action before the timer runs out.',
      shouldReveal: false,
    });
  });

  it('enables lock-in once an action has been picked', () => {
    const plan = phasePlan(at(MatchPhase.Commit), { ...SEATED, draft: { action: 2, target: 0 } });
    expect(plan.lockInDisabled).toBe(false);
  });

  it('closes the actions once the round is committed', () => {
    const plan = phasePlan(at(MatchPhase.Commit), {
      ...SEATED,
      committedRound: 3,
      draft: { action: 2, target: 0 },
    });

    expect(plan.actionsEnabled).toBe(false);
    expect(plan.lockInDisabled).toBe(true);
    expect(plan.statusText).toBe('Move sealed. Waiting for the table.');
  });

  it('treats a commitment from a previous round as no commitment at all', () => {
    const plan = phasePlan(at(MatchPhase.Commit), { ...SEATED, committedRound: 2 });
    expect(plan.actionsEnabled).toBe(true);
  });

  it('locks a spectator out of acting and betting', () => {
    const plan = phasePlan(at(MatchPhase.Commit), SPECTATOR);

    expect(plan.actionsEnabled).toBe(false);
    expect(plan.betDisabled).toBe(true);
    expect(plan.statusText).toBe('Spectating — no seat in this match.');
  });
});

describe('reveal phase', () => {
  it('asks for a reveal from a seated player who has not sent one', () => {
    const plan = phasePlan(at(MatchPhase.Reveal), SEATED);

    expect(plan.label).toBe('Round 3 — reveal');
    expect(plan.shouldReveal).toBe(true);
    // Left alone so `revealNow` can write something more specific.
    expect(plan.statusText).toBeNull();
  });

  it('asks only once per round', () => {
    expect(phasePlan(at(MatchPhase.Reveal), { ...SEATED, revealedRound: 3 }).shouldReveal).toBe(false);
    expect(phasePlan(at(MatchPhase.Reveal), { ...SEATED, revealedRound: 2 }).shouldReveal).toBe(true);
  });

  it('never asks a spectator to reveal', () => {
    expect(phasePlan(at(MatchPhase.Reveal), SPECTATOR).shouldReveal).toBe(false);
  });

  it('closes every control', () => {
    const plan = phasePlan(at(MatchPhase.Reveal), SEATED);
    expect(plan).toMatchObject({ actionsEnabled: false, lockInDisabled: true, betDisabled: true });
  });
});

describe('other phases', () => {
  it('reads as finished at the end of a match', () => {
    expect(phasePlan(at(MatchPhase.Finished), SEATED)).toEqual({
      label: 'Finished',
      actionsEnabled: false,
      lockInDisabled: true,
      betDisabled: true,
      statusText: null,
      shouldReveal: false,
    });
  });

  it('reads as waiting in the lobby', () => {
    expect(phasePlan(at(MatchPhase.Lobby), SEATED).label).toBe('Waiting');
  });
});
