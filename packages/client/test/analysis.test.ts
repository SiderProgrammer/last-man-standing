import { describe, expect, it } from 'vitest';
import { Action, type MatchAnalysis } from '@lms/protocol';
import { stateBeforeRound } from '../src/game/rewind.js';
import { analysisNote, errorText, momentHeading, paragraphs, progressText } from '../src/ui/analysis.js';
import { round, stateWith } from './helpers.js';

describe('rewinding a finished match', () => {
  const history = [
    round(1, [{ index: 0, action: Action.Strike, target: 1 }, { index: 1, action: Action.Guard }, { index: 2, action: Action.Charge }], [100, 66, 100]),
    { ...round(2, [{ index: 0, action: Action.Strike, target: 1 }, { index: 1, action: Action.Guard }, { index: 2, action: Action.Charge }], [94, -2, 90]), eliminated: [1] },
    round(3, [{ index: 0, action: Action.Strike, target: 2 }, { index: 2, action: Action.Charge }], [80, 0, 40]),
  ];
  const state = stateWith(3, history, [1]);

  it('starts round 1 from full health', () => {
    const before = stateBeforeRound(state, 1);
    expect(before?.players.map((p) => p.hp)).toEqual([100, 100, 100]);
    expect(before?.players.every((p) => p.alive)).toBe(true);
    expect(before?.history).toEqual([]);
  });

  it('carries the HP and eliminations of every earlier round', () => {
    const before = stateBeforeRound(state, 3);
    // Overkill is floored: a seat on -2 shows as empty, not negative.
    expect(before?.players.map((p) => p.hp)).toEqual([94, 0, 90]);
    expect(before?.players.map((p) => p.alive)).toEqual([true, false, true]);
    expect(before?.history).toHaveLength(2);
    expect(before?.round).toBe(3);
  });

  it('is a copy, not an edit of the live state', () => {
    stateBeforeRound(state, 2);
    expect(state.players.map((p) => p.hp)).toEqual(stateWith(3, history, [1]).players.map((p) => p.hp));
    expect(state.history).toHaveLength(3);
  });

  it('refuses a round the match never played', () => {
    expect(stateBeforeRound(state, 4)).toBeNull();
    expect(stateBeforeRound(state, 0)).toBeNull();
  });
});

describe('analysis presentation', () => {
  const analysis: MatchAnalysis = {
    matchId: `0x${'ab'.repeat(32)}`,
    seat: 0,
    summary: 'First paragraph.\n\nSecond paragraph.\nThird line.',
    decisiveRound: 2,
    keyMoments: [],
    advice: [],
    dropped: 0,
    model: 'gemini-3.8-flash',
  };

  it('heads a moment with its checked facts', () => {
    expect(momentHeading({ round: 4, seat: 2, kind: 'hit', target: 0, claim: 'x' })).toBe('Round 4 · #2 💥 hit #0');
    expect(momentHeading({ round: 1, seat: 3, kind: 'eliminated', target: null, claim: 'x' })).toBe(
      'Round 1 · #3 ☠️ eliminated',
    );
  });

  it('splits the narrative into paragraphs, partial or whole', () => {
    expect(paragraphs(analysis.summary)).toEqual(['First paragraph.', 'Second paragraph.', 'Third line.']);
    expect(paragraphs('Half a sente')).toEqual(['Half a sente']);
    expect(paragraphs('')).toEqual([]);
  });

  it('says how long the analysis has been running, and what to expect', () => {
    expect(progressText(0)).toBe('Working… 0s · this usually takes under a minute.');
    expect(progressText(59)).toMatch(/^Working… 59s/);
    expect(progressText(75)).toBe("Still working… 1m 15s · Gemini's free tier can take a few minutes.");
  });

  it('names the model that wrote it', () => {
    expect(analysisNote(analysis, false)).toMatch(/^Written by Gemini \(gemini-3\.8-flash\)\./);
  });

  it('says what the verifier removed', () => {
    expect(analysisNote(analysis, false)).not.toMatch(/removed/);
    expect(analysisNote({ ...analysis, dropped: 1 }, false)).toMatch(/1 claim the record did not support was removed/);
    expect(analysisNote({ ...analysis, dropped: 2 }, true)).toMatch(/2 claims .* were removed\. Saved/);
  });

  it('offers a retry only where one could help', () => {
    expect(errorText('unavailable', 'x').retry).toBe(false);
    expect(errorText('forbidden', 'x').retry).toBe(false);
    expect(errorText('busy', 'the analyst is busy').retry).toBe(true);
    expect(errorText('busy', 'the analyst is busy').text).toBe('the analyst is busy');
  });
});
