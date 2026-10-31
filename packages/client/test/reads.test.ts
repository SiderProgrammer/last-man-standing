import { describe, expect, it } from 'vitest';
import { Action } from '@lms/consensus';
import { readOpponents } from '../src/game/reads.js';
import { describeStyle } from '../src/game/style.js';
import { round, stateWith } from './helpers.js';

/**
 * What `readOpponents` concludes from a history. The first-round leader
 * fallback, which treats every mover as a leader, is pinned deliberately.
 */
describe('reads panel', () => {
  it('omits your own seat and sorts the living first, then by seat', () => {
    const state = stateWith(
      4,
      [round(1, [{ index: 1, action: Action.Guard }], [100, 100, 100, 100])],
      [2],
    );
    const reads = readOpponents(state, 0);

    expect(reads.map((read) => read.seat)).toEqual([1, 3, 2]);
    expect(reads.find((read) => read.seat === 0)).toBeUndefined();
  });

  it('counts each action and the rounds a seat failed to reveal', () => {
    const state = stateWith(3, [
      round(
        1,
        [
          { index: 1, action: Action.Strike, target: 2 },
          { index: 2, action: Action.Guard },
        ],
        [100, 100, 80],
      ),
      round(
        2,
        [
          { index: 1, action: Action.Charge },
          { index: 2, action: Action.None, revealed: false },
        ],
        [100, 100, 60],
      ),
    ]);
    const [one, two] = readOpponents(state, 0);

    expect(one).toMatchObject({ seat: 1, strikes: 1, charges: 1, guards: 0, noShows: 0 });
    expect(two).toMatchObject({ seat: 2, guards: 1, noShows: 1, strikes: 0 });
  });

  it('picks the most-attacked seat as the favourite, breaking ties on the lower seat', () => {
    const state = stateWith(4, [
      round(1, [{ index: 1, action: Action.Strike, target: 3 }], [100, 100, 100, 66]),
      round(2, [{ index: 1, action: Action.Strike, target: 2 }], [100, 100, 66, 66]),
    ]);
    const [one] = readOpponents(state, 0);

    // One attack each on seats 2 and 3, so the tie breaks to the lower seat.
    expect(one?.favourite).toBe(2);
  });

  it('stays quiet until three moves have been revealed', () => {
    const state = stateWith(3, [
      round(1, [{ index: 1, action: Action.Strike, target: 2 }], [100, 100, 66]),
      round(2, [{ index: 1, action: Action.Strike, target: 2 }], [100, 100, 32]),
    ]);
    const [one] = readOpponents(state, 0);

    expect(one?.strikes).toBe(2);
    expect(one?.tell).toBe('');
  });

  it('calls out a seat that keeps coming after you, ahead of every other tell', () => {
    const state = stateWith(3, [
      round(1, [{ index: 1, action: Action.Strike, target: 0 }], [66, 100, 100]),
      round(2, [{ index: 1, action: Action.Strike, target: 0 }], [32, 100, 100]),
      round(3, [{ index: 1, action: Action.Strike, target: 0 }], [10, 100, 100]),
    ]);
    const [one] = readOpponents(state, 0);

    expect(one?.againstYou).toBe(3);
    expect(one?.tell).toBe('has a grudge on you (3×)');
  });

  it('calls out a seat that always swings', () => {
    // Seat 3 is behind from round 1 on, so hunting it never counts as hunting
    // the leader and the attack-ratio branch is the one that fires.
    const state = stateWith(4, [
      round(1, [{ index: 1, action: Action.Strike, target: 3 }], [100, 100, 100, 66]),
      round(2, [{ index: 1, action: Action.Strike, target: 3 }], [100, 100, 100, 32]),
      round(3, [{ index: 1, action: Action.Strike, target: 3 }], [100, 100, 100, 10]),
    ]);
    const [one] = readOpponents(state, 0);

    expect(one?.tell).toBe('always swings');
  });

  it('calls out a seat that guards whenever its cooldown allows', () => {
    const state = stateWith(3, [
      round(1, [{ index: 1, action: Action.Guard }], [100, 100, 100]),
      round(2, [{ index: 1, action: Action.Charge }], [100, 100, 100]),
      round(3, [{ index: 1, action: Action.Guard }], [100, 100, 100]),
    ]);
    const [one] = readOpponents(state, 0);

    expect(one?.tell).toBe('guards every chance it gets');
  });

  it('names a seat fixated on one target once it has attacked it three times', () => {
    const state = stateWith(4, [
      round(1, [{ index: 1, action: Action.Guard }], [100, 100, 100, 66]),
      round(2, [{ index: 1, action: Action.Charge }], [100, 100, 100, 66]),
      round(3, [{ index: 1, action: Action.Strike, target: 3 }], [100, 100, 100, 32]),
      round(4, [{ index: 1, action: Action.Strike, target: 3 }], [100, 100, 100, 20]),
      round(5, [{ index: 1, action: Action.Strike, target: 3 }], [100, 100, 100, 10]),
      round(6, [{ index: 1, action: Action.Guard }], [100, 100, 100, 10]),
      round(7, [{ index: 1, action: Action.Charge }], [100, 100, 100, 10]),
    ]);
    const [one] = readOpponents(state, 0);

    expect(one?.strikes).toBe(3);
    expect(one?.tell).toBe('fixated on #3');
  });

  it('does not call a seat fixated when its strikes are spread across targets', () => {
    // Three strikes, but no target was hit three times. Seat 3 is never the
    // HP leader, so the hunt and grudge tells stay out of the way.
    const state = stateWith(5, [
      round(1, [{ index: 1, action: Action.Guard }], [100, 100, 100, 50, 100]),
      round(2, [{ index: 1, action: Action.Strike, target: 3 }], [100, 100, 100, 40, 100]),
      round(3, [{ index: 1, action: Action.Charge }], [100, 100, 100, 40, 100]),
      round(4, [{ index: 1, action: Action.Strike, target: 3 }], [100, 100, 100, 30, 100]),
      round(5, [{ index: 1, action: Action.Guard }], [100, 100, 100, 30, 100]),
      round(6, [{ index: 1, action: Action.Strike, target: 4 }], [100, 100, 100, 30, 90]),
      round(7, [{ index: 1, action: Action.Charge }], [100, 100, 100, 30, 90]),
    ]);
    const [one] = readOpponents(state, 0);

    expect(one?.strikes).toBe(3);
    expect(one?.favourite).toBe(3);
    expect(one?.tell).toBe('');
  });

  it('says nothing about a favourite backed by only two attacks, however long the history', () => {
    const state = stateWith(4, [
      round(1, [{ index: 1, action: Action.Guard }], [100, 100, 100, 66]),
      round(2, [{ index: 1, action: Action.Guard }], [100, 100, 100, 66]),
      round(3, [{ index: 1, action: Action.Strike, target: 3 }], [100, 100, 100, 32]),
      round(4, [{ index: 1, action: Action.Strike, target: 3 }], [100, 100, 100, 20]),
      round(5, [{ index: 1, action: Action.Charge }], [100, 100, 100, 20]),
    ]);
    const [one] = readOpponents(state, 0);

    expect(one?.favourite).toBe(3);
    expect(one?.strikes).toBe(2);
    expect(one?.tell).toBe('');
  });

  it('treats every mover as a leader in the first round, having no prior HP to compare', () => {
    // Unlike the tests above, these records list every seat's move, because
    // `hpLeaders` ranks the seats that moved — a record naming one seat makes
    // that seat the sole leader. Round 1 has no predecessor, so the fallback
    // treats all four movers as leaders and the opening attack counts as a
    // hunt; round 2 ranks them on round 1's HP, leaving seat 3 behind.
    const others = (round1: boolean) => [
      { index: 0, action: Action.Guard },
      { index: 1, action: Action.Strike, target: round1 ? 3 : 0 },
      { index: 2, action: Action.Guard },
      { index: 3, action: Action.Guard },
    ];
    const state = stateWith(4, [
      round(1, others(true), [100, 100, 100, 66]),
      round(2, others(false), [66, 100, 100, 66]),
      round(3, [{ index: 1, action: Action.Guard }], [66, 100, 100, 66]),
    ]);
    const [one] = readOpponents(state, 0);

    expect(one?.strikes).toBe(2);
    expect(one?.againstYou).toBe(1);
    expect(one?.tell).toBe('hunts the leader');
  });

  it('carries a returning player\'s record from earlier matches', () => {
    const state = stateWith(3, []);
    const regular = state.players[1]?.address as `0x${string}`;
    const dossier = new Map([
      [regular.toLowerCase(), { matches: 4, wins: 2, strikes: 6, guards: 3, charges: 1, noShows: 0 }],
    ]);
    const reads = readOpponents(state, 0, dossier);
    expect(reads.find((read) => read.seat === 1)?.past).toBe('4 matches · 2 won · ⚔️60% 🛡️30% ⚡10%');
    // A stranger has no record to show.
    expect(reads.find((read) => read.seat === 2)?.past).toBe('');
  });
});

describe('describeStyle', () => {
  it('reads a record as shares of the revealed moves, with no-shows apart', () => {
    expect(describeStyle({ matches: 1, wins: 1, strikes: 0, guards: 1, charges: 0, noShows: 1 })).toBe(
      '1 match · 1 won · ⚔️0% 🛡️100% ⚡0% · 1 no-show',
    );
  });

  it('is empty for a stranger', () => {
    expect(describeStyle(undefined)).toBe('');
    expect(describeStyle({ matches: 0, wins: 0, strikes: 0, guards: 0, charges: 0, noShows: 0 })).toBe('');
  });
});
