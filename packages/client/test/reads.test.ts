import { describe, expect, it } from 'vitest';
import { Action } from '@lms/protocol';
import { readOpponents } from '../src/game/reads.js';
import { round, stateWith } from './helpers.js';

/**
 * Characterisation tests: these pin what `readOpponents` does today, including
 * where that is arguably wrong. See `docs/TODO.md` §3.4 for the two quirks
 * pinned here deliberately — the unreachable `revealed >= 5` disjunct and the
 * first-round leader fallback that treats every mover as a leader.
 */
describe('reads panel', () => {
  it('omits your own seat and sorts the living first, then by seat', () => {
    const state = stateWith(
      4,
      [round(1, [{ index: 1, action: Action.Defend }], [100, 100, 100, 100])],
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
          { index: 1, action: Action.Attack, target: 2 },
          { index: 2, action: Action.Defend },
        ],
        [100, 100, 80],
      ),
      round(
        2,
        [
          { index: 1, action: Action.Hide },
          { index: 2, action: Action.None, revealed: false },
        ],
        [100, 100, 60],
      ),
    ]);
    const [one, two] = readOpponents(state, 0);

    expect(one).toMatchObject({ seat: 1, attacks: 1, hides: 1, defends: 0, noShows: 0 });
    expect(two).toMatchObject({ seat: 2, defends: 1, noShows: 1, attacks: 0 });
  });

  it('picks the most-attacked seat as the favourite, breaking ties on the lower seat', () => {
    const state = stateWith(4, [
      round(1, [{ index: 1, action: Action.Attack, target: 3 }], [100, 100, 100, 66]),
      round(2, [{ index: 1, action: Action.Attack, target: 2 }], [100, 100, 66, 66]),
    ]);
    const [one] = readOpponents(state, 0);

    // One attack each on seats 2 and 3, so the tie breaks to the lower seat.
    expect(one?.favourite).toBe(2);
  });

  it('stays quiet until three moves have been revealed', () => {
    const state = stateWith(3, [
      round(1, [{ index: 1, action: Action.Attack, target: 2 }], [100, 100, 66]),
      round(2, [{ index: 1, action: Action.Attack, target: 2 }], [100, 100, 32]),
    ]);
    const [one] = readOpponents(state, 0);

    expect(one?.attacks).toBe(2);
    expect(one?.tell).toBe('');
  });

  it('calls out a seat that keeps coming after you, ahead of every other tell', () => {
    const state = stateWith(3, [
      round(1, [{ index: 1, action: Action.Attack, target: 0 }], [66, 100, 100]),
      round(2, [{ index: 1, action: Action.Attack, target: 0 }], [32, 100, 100]),
      round(3, [{ index: 1, action: Action.Attack, target: 0 }], [10, 100, 100]),
    ]);
    const [one] = readOpponents(state, 0);

    expect(one?.againstYou).toBe(3);
    expect(one?.tell).toBe('has a grudge on you (3×)');
  });

  it('calls out a seat that always swings', () => {
    // Seat 3 is behind from round 1 on, so hunting it never counts as hunting
    // the leader and the attack-ratio branch is the one that fires.
    const state = stateWith(4, [
      round(1, [{ index: 1, action: Action.Attack, target: 3 }], [100, 100, 100, 66]),
      round(2, [{ index: 1, action: Action.Attack, target: 3 }], [100, 100, 100, 32]),
      round(3, [{ index: 1, action: Action.Attack, target: 3 }], [100, 100, 100, 10]),
    ]);
    const [one] = readOpponents(state, 0);

    expect(one?.tell).toBe('always swings');
  });

  it('calls out a turtle', () => {
    const state = stateWith(3, [
      round(1, [{ index: 1, action: Action.Defend }], [100, 100, 100]),
      round(2, [{ index: 1, action: Action.Defend }], [100, 100, 100]),
      round(3, [{ index: 1, action: Action.Hide }], [100, 100, 100]),
    ]);
    const [one] = readOpponents(state, 0);

    expect(one?.tell).toBe('turtles');
  });

  it('names a seat fixated on one target once it has attacked it three times', () => {
    const state = stateWith(4, [
      round(1, [{ index: 1, action: Action.Defend }], [100, 100, 100, 66]),
      round(2, [{ index: 1, action: Action.Hide }], [100, 100, 100, 66]),
      round(3, [{ index: 1, action: Action.Attack, target: 3 }], [100, 100, 100, 32]),
      round(4, [{ index: 1, action: Action.Attack, target: 3 }], [100, 100, 100, 20]),
      round(5, [{ index: 1, action: Action.Attack, target: 3 }], [100, 100, 100, 10]),
      round(6, [{ index: 1, action: Action.Defend }], [100, 100, 100, 10]),
      round(7, [{ index: 1, action: Action.Hide }], [100, 100, 100, 10]),
    ]);
    const [one] = readOpponents(state, 0);

    expect(one?.attacks).toBe(3);
    expect(one?.tell).toBe('fixated on #3');
  });

  it('says nothing about a favourite backed by only two attacks, however long the history', () => {
    // Pins the dead disjunct in `tellFor`: the outer guard admits
    // `revealed >= 5`, but the inner one re-requires `attacks >= 3`, so a long
    // history with two attacks can never produce the "fixated" tell.
    const state = stateWith(4, [
      round(1, [{ index: 1, action: Action.Defend }], [100, 100, 100, 66]),
      round(2, [{ index: 1, action: Action.Defend }], [100, 100, 100, 66]),
      round(3, [{ index: 1, action: Action.Attack, target: 3 }], [100, 100, 100, 32]),
      round(4, [{ index: 1, action: Action.Attack, target: 3 }], [100, 100, 100, 20]),
      round(5, [{ index: 1, action: Action.Hide }], [100, 100, 100, 20]),
    ]);
    const [one] = readOpponents(state, 0);

    expect(one?.favourite).toBe(3);
    expect(one?.attacks).toBe(2);
    expect(one?.tell).toBe('');
  });

  it('treats every mover as a leader in the first round, having no prior HP to compare', () => {
    // Unlike the tests above, these records list every seat's move, because
    // `hpLeaders` ranks the seats that moved — a record naming one seat makes
    // that seat the sole leader. Round 1 has no predecessor, so the fallback
    // treats all four movers as leaders and the opening attack counts as a
    // hunt; round 2 ranks them on round 1's HP, leaving seat 3 behind.
    const others = (round1: boolean) => [
      { index: 0, action: Action.Defend },
      { index: 1, action: Action.Attack, target: round1 ? 3 : 0 },
      { index: 2, action: Action.Defend },
      { index: 3, action: Action.Defend },
    ];
    const state = stateWith(4, [
      round(1, others(true), [100, 100, 100, 66]),
      round(2, others(false), [66, 100, 100, 66]),
      round(3, [{ index: 1, action: Action.Defend }], [66, 100, 100, 66]),
    ]);
    const [one] = readOpponents(state, 0);

    expect(one?.attacks).toBe(2);
    expect(one?.againstYou).toBe(1);
    expect(one?.tell).toBe('hunts the leader');
  });

  it('carries a returning player\'s record from earlier matches', () => {
    const state = stateWith(3, []);
    const regular = state.players[1]?.address as `0x${string}`;
    const dossier = new Map([
      [regular.toLowerCase(), { matches: 4, wins: 2, attacks: 6, defends: 3, hides: 1, noShows: 0 }],
    ]);
    const reads = readOpponents(state, 0, dossier);
    expect(reads.find((read) => read.seat === 1)?.past).toBe('4 matches · 2 won · ⚔️60% 🛡️30% 🏃10%');
    // A stranger has no record to show.
    expect(reads.find((read) => read.seat === 2)?.past).toBe('');
  });
});
