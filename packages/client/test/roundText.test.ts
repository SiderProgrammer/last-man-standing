import { describe, expect, it } from 'vitest';
import { Action, StrikeOutcome, type RoundRecord } from '@lms/consensus';
import { missedRound, roundRecap, roundRows } from '../src/ui/roundText.js';

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

describe('roundRows', () => {
  it('gives every seat its move, what it did and the HP it left on', () => {
    const rows = roundRows({ ...ROUND, hpAfter: [80, 50, 41, 75] }, [75, 75, 75, 75]);
    expect(rows.map((row) => [row.seat, row.action, row.target, row.outcome])).toEqual([
      [0, 'strike', 1, 'hit'],
      [1, 'guard', null, null],
      [2, 'strike', 1, 'blocked'],
      [3, 'none', null, null],
    ]);
    expect(rows[0]).toMatchObject({ dealt: 25, heal: 5, hpBefore: 75, hpAfter: 80 });
    expect(rows[1]).toMatchObject({ blocked: [2], reflected: 34, taken: 25, hpAfter: 50 });
    expect(rows[2]).toMatchObject({ recoil: 34, dealt: 0 });
  });

  it('marks a charged strike, a miss and an elimination', () => {
    const rows = roundRows({
      moves: [move(0, Action.Strike, 1), move(1, Action.Strike, 2)],
      strikes: [strike(0, 1, StrikeOutcome.Hit, { charged: true, damage: 60 }), strike(1, 2, StrikeOutcome.Void)],
      stallDamage: 0,
      eliminated: [1],
    });
    expect(rows[0]).toMatchObject({ charged: true, dealt: 60, hpAfter: null });
    expect(rows[1]).toMatchObject({ outcome: 'missed', out: true, taken: 60 });
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
