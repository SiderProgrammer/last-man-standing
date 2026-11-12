import { describe, expect, it } from 'vitest';
import { Action, StrikeOutcome, type RoundRecord } from '@lms/consensus';
import { missedRound, roundLines, roundRecap } from '../src/ui/roundText.js';

type Move = RoundRecord['moves'][number];
type Strike = RoundRecord['strikes'][number];

const move = (index: number, action: Move['action'], target = 0, revealed = true): Move => ({
  index,
  action,
  target,
  revealed,
  salt: '0x00',
  commitment: '0x00',
});

const strike = (striker: number, target: number, outcome: Strike['outcome'], extra: Partial<Strike> = {}): Strike => ({
  striker,
  target,
  outcome,
  charged: false,
  damage: outcome === StrikeOutcome.Hit ? 25 : 0,
  heal: outcome === StrikeOutcome.Hit ? 5 : 0,
  reflected: outcome === StrikeOutcome.Guarded ? 34 : 0,
  ...extra,
});

/** Seat 0 strikes 1; 1 guards and blocks 2; 2 strikes 1; 3 sat it out and was struck by nobody. */
const ROUND = {
  moves: [move(0, Action.Strike, 1), move(1, Action.Guard), move(2, Action.Strike, 1), move(3, Action.None, 0, false)],
  strikes: [strike(0, 1, StrikeOutcome.Hit), strike(2, 1, StrikeOutcome.Guarded)],
  stallDamage: 0,
  eliminated: [] as number[],
};

describe('roundLines', () => {
  it('shows what each strike did, and a seat with no move as "no move"', () => {
    expect(roundLines(ROUND)).toEqual([
      '#0 → struck #1 (−25, +5 hp)',
      '#1 → guarded',
      '#2 → struck #1 (blocked: took −34)',
      '#3 → no move',
    ]);
  });

  it('leaves eliminations to the feed, so none is listed twice', () => {
    const lines = roundLines({ ...ROUND, eliminated: [3], stallDamage: 4 });
    expect(lines.filter((line) => line.includes('eliminated'))).toEqual([]);
    expect(lines.at(-1)).toBe('stall → everyone took 4');
  });
});

describe('roundRecap', () => {
  it('reads the round from your own seat first', () => {
    expect(roundRecap(ROUND, 0)).toBe('You hit #1 for 25 and healed 5.');
    expect(roundRecap(ROUND, 1)).toBe('Your guard blocked #2 and reflected 34 · you took 25 from #0.');
    expect(roundRecap(ROUND, 2)).toBe('#1 guarded your strike and reflected 34.');
  });

  it('warns a seat that did not lock in', () => {
    expect(roundRecap(ROUND, 3)).toBe('You did not lock in a move.');
    expect(missedRound(ROUND, 3)).toBe(true);
    expect(missedRound(ROUND, 0)).toBe(false);
    const struck = { ...ROUND, strikes: [...ROUND.strikes, strike(0, 3, StrikeOutcome.Hit)] };
    expect(roundRecap(struck, 3)).toBe('You did not lock in: every strike on you hit · you took 25 from #0.');
  });

  it('says nothing to a spectator or a seat that was not in the round', () => {
    expect(roundRecap(ROUND, null)).toBeNull();
    expect(roundRecap(ROUND, 7)).toBeNull();
  });

  it('ends with being knocked out', () => {
    expect(roundRecap({ ...ROUND, eliminated: [1] }, 1)).toMatch(/· you are out\.$/);
  });
});
