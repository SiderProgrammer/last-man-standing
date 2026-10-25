import { describe, expect, it } from 'vitest';
import {
  Action,
  DEFAULT_RULES,
  draw,
  roundSeed,
  saltsBySeat,
  StrikeOutcome,
  ZERO_SALT,
  type PlayerState,
} from '@lms/protocol';
import { GUARD_NONCE_BASE, resolveRound, tiebreakKey, type DeclaredMove } from '@lms/engine';
import { bytes32, freshStates } from './helpers.js';

const SEED = bytes32('resolve-seed');
const R = DEFAULT_RULES;
const HEAL = Math.floor((R.strikeDamage * R.strikeHealBps) / 10_000);

function move(index: number, action: DeclaredMove['action'], target = 0, saltLabel = 'a'): DeclaredMove {
  return { index, action, target, revealed: true, salt: bytes32(`salt:${saltLabel}:${index}`) };
}

/** Fresh states with one seat's fields overridden. */
function withSeat(count: number, seat: number, patch: Partial<PlayerState>, hp = R.startingHp): PlayerState[] {
  const states = freshStates(count, hp);
  Object.assign(states[seat] as PlayerState, patch);
  return states;
}

describe('round resolution', () => {
  it('lands strikes both ways and heals each striker part of what it dealt', () => {
    const { states: next, record } = resolveRound(R, SEED, 1, freshStates(2, 80), [
      move(0, Action.Strike, 1),
      move(1, Action.Strike, 0),
    ]);

    expect(record.strikes.every((strike) => strike.outcome === StrikeOutcome.Hit)).toBe(true);
    expect(record.strikes.every((strike) => strike.heal === HEAL)).toBe(true);
    expect(next[0]?.hp).toBe(80 - R.strikeDamage + HEAL);
    expect(next[1]?.hp).toBe(80 - R.strikeDamage + HEAL);
    expect(record.stallDamage).toBe(0);
  });

  it('never heals a striker above its starting HP', () => {
    const { states: next, record } = resolveRound(R, SEED, 1, freshStates(2), [move(0, Action.Strike, 1), move(1, Action.Charge)]);
    expect(record.strikes[0]?.heal).toBeGreaterThan(0);
    expect(next[0]?.hp).toBe(R.startingHp);
  });

  it('blocks a lone strike into a Guard and reflects it onto the striker', () => {
    const { states: next, record } = resolveRound(R, SEED, 1, freshStates(2), [
      move(0, Action.Strike, 1),
      move(1, Action.Guard),
    ]);

    expect(record.strikes[0]?.outcome).toBe(StrikeOutcome.Guarded);
    expect(record.strikes[0]?.reflected).toBe(R.guardReflectDamage);
    expect(next[1]?.hp).toBe(R.startingHp);
    expect(next[0]?.hp).toBe(R.startingHp - R.guardReflectDamage);
  });

  it('blocks exactly one striker and lets the rest connect', () => {
    const { states: next, record } = resolveRound(R, SEED, 1, freshStates(4), [
      move(0, Action.Strike, 3),
      move(1, Action.Strike, 3),
      move(2, Action.Strike, 3),
      move(3, Action.Guard),
    ]);

    const outcomes = record.strikes.map((strike) => strike.outcome);
    expect(outcomes.filter((outcome) => outcome === StrikeOutcome.Guarded)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === StrikeOutcome.Hit)).toHaveLength(2);
    expect(next[3]?.hp).toBe(R.startingHp - 2 * R.strikeDamage);

    const blocked = record.strikes.find((strike) => strike.outcome === StrikeOutcome.Guarded);
    expect(next[blocked?.striker as number]?.hp).toBe(R.startingHp - R.guardReflectDamage);
  });

  it('picks the blocked striker from the round seed, not from seat order', () => {
    const states = freshStates(3);
    const picks = new Set<number>();
    for (let i = 0; i < 40 && picks.size < 2; i += 1) {
      const moves = [move(0, Action.Strike, 2, `p${i}`), move(1, Action.Strike, 2, `p${i}`), move(2, Action.Guard, 0, `p${i}`)];
      const { record } = resolveRound(R, SEED, 1, states, moves);
      const blocked = record.strikes.find((strike) => strike.outcome === StrikeOutcome.Guarded);
      picks.add(blocked?.striker as number);

      // And it is exactly the documented draw.
      const entropy = roundSeed(SEED, 1, saltsBySeat(3, moves));
      expect(blocked?.striker).toBe(Number(draw(entropy, GUARD_NONCE_BASE + 2) % 2n));
    }
    expect([...picks].sort()).toEqual([0, 1]);
  });

  it('makes a charging player take extra damage and loads its next strike', () => {
    const { states: next, record } = resolveRound(R, SEED, 1, freshStates(2), [
      move(0, Action.Strike, 1),
      move(1, Action.Charge),
    ]);

    const exposed = Math.floor((R.strikeDamage * (10_000 + R.chargeExposureBps)) / 10_000);
    expect(record.strikes[0]?.damage).toBe(exposed);
    expect(next[1]?.hp).toBe(R.startingHp - exposed);
    expect(next[1]?.charged).toBe(true);
    expect(next[0]?.charged).toBe(false);
  });

  it('spends a loaded Charge on the next strike for the bonus damage', () => {
    const states = withSeat(2, 0, { charged: true, lastAction: Action.Charge });
    const { states: next, record } = resolveRound(R, SEED, 2, states, [move(0, Action.Strike, 1), move(1, Action.Strike, 0)]);

    expect(record.strikes.find((strike) => strike.striker === 0)?.charged).toBe(true);
    expect(next[1]?.hp).toBe(R.startingHp - R.strikeDamage - R.chargeBonusDamage + HEAL);
    expect(next[0]?.charged).toBe(false);
  });

  it('spends the Charge even when the loaded strike is guarded', () => {
    const states = withSeat(2, 0, { charged: true, lastAction: Action.Charge });
    const { states: next, record } = resolveRound(R, SEED, 2, states, [move(0, Action.Strike, 1), move(1, Action.Guard)]);
    expect(record.strikes[0]?.outcome).toBe(StrikeOutcome.Guarded);
    expect(next[0]?.charged).toBe(false);
    expect(next[1]?.hp).toBe(R.startingHp);
  });

  it('keeps a Charge loaded through a Guard', () => {
    const states = withSeat(2, 0, { charged: true, lastAction: Action.Charge });
    const { states: next } = resolveRound(R, SEED, 2, states, [move(0, Action.Guard), move(1, Action.Guard)]);
    expect(next[0]?.charged).toBe(true);
  });

  it('treats a repeated Guard, a repeated Charge and a stacked Charge as no move', () => {
    const cases: Array<[Partial<PlayerState>, DeclaredMove['action']]> = [
      [{ lastAction: Action.Guard }, Action.Guard],
      [{ lastAction: Action.Charge, charged: true }, Action.Charge],
      [{ lastAction: Action.Guard, charged: true }, Action.Charge],
    ];
    for (const [patch, action] of cases) {
      const { states: next, record } = resolveRound(R, SEED, 3, withSeat(2, 1, patch), [move(0, Action.Strike, 1), move(1, action)]);
      const declared = record.moves.find((entry) => entry.index === 1);
      expect(declared?.action).toBe(Action.None);
      expect(declared?.revealed).toBe(false);
      expect(next[1]?.timeouts).toBe(1);
      expect(record.strikes[0]?.outcome).toBe(StrikeOutcome.Hit);
    }
  });

  it('records each seat\'s action as the next round\'s cooldown', () => {
    const { states: next } = resolveRound(R, SEED, 1, freshStates(3), [move(0, Action.Strike, 1), move(1, Action.Guard), move(2, Action.Charge)]);
    expect(next.map((state) => state.lastAction)).toEqual([Action.Strike, Action.Guard, Action.Charge]);
  });

  it('starts the stall penalty after the grace of quiet rounds, and grows it', () => {
    const quiet = [move(0, Action.Guard), move(1, Action.Guard)];
    const first = resolveRound(R, SEED, 1, freshStates(2), quiet, 0);
    expect(first.record.stallDamage).toBe(0);
    expect(first.quietRounds).toBe(1);

    const second = resolveRound(R, SEED, 2, freshStates(2), [move(0, Action.Charge), move(1, Action.Charge)], first.quietRounds);
    expect(second.record.stallDamage).toBe(R.stallDamage);
    expect(second.states[0]?.hp).toBe(R.startingHp - R.stallDamage);

    const third = resolveRound(R, SEED, 3, freshStates(2), quiet, second.quietRounds);
    expect(third.record.stallDamage).toBe(2 * R.stallDamage);
  });

  it('lifts the stall penalty the round anyone lands anything, a reflection included', () => {
    const hit = resolveRound(R, SEED, 5, freshStates(2), [move(0, Action.Strike, 1), move(1, Action.Charge)], 5);
    expect(hit.record.stallDamage).toBe(0);
    expect(hit.quietRounds).toBe(0);

    const reflected = resolveRound(R, SEED, 5, freshStates(2), [move(0, Action.Strike, 1), move(1, Action.Guard)], 5);
    expect(reflected.record.stallDamage).toBe(0);
  });

  it('voids a strike on an eliminated or out-of-range seat', () => {
    const states = freshStates(3);
    (states[2] as PlayerState).alive = false;

    const { record } = resolveRound(R, SEED, 1, states, [move(0, Action.Strike, 2), move(1, Action.Strike, 99)]);

    expect(record.strikes).toHaveLength(2);
    expect(record.strikes.every((strike) => strike.outcome === StrikeOutcome.Void)).toBe(true);
    expect(record.strikes.every((strike) => strike.damage === 0)).toBe(true);
  });

  it('resolves strikes simultaneously so a dying player still lands its move', () => {
    // Low enough that even a landed strike's heal cannot save either of them.
    const { states: next, record } = resolveRound(R, SEED, 1, freshStates(2, R.strikeDamage - HEAL), [
      move(0, Action.Strike, 1),
      move(1, Action.Strike, 0),
    ]);

    // Both were on lethal HP and both strikes connect, so the last-stand rule
    // has to pick a single winner rather than wiping the lobby.
    expect(record.strikes.every((strike) => strike.outcome === StrikeOutcome.Hit)).toBe(true);
    expect(next.filter((state) => state.alive)).toHaveLength(1);
    expect(record.eliminated).toHaveLength(1);
  });

  it('keeps the least-overkilled player alive on 1 HP when a round would wipe the lobby', () => {
    const states = freshStates(3, 5);
    (states[2] as PlayerState).hp = 7;
    const { states: next, record } = resolveRound(R, SEED, 9, states, [move(0, Action.Guard), move(1, Action.Guard), move(2, Action.Guard)], 4);

    const survivors = next.filter((state) => state.alive);
    expect(record.stallDamage).toBeGreaterThan(7);
    expect(survivors.map((state) => state.index)).toEqual([2]);
    expect(survivors[0]?.hp).toBe(1);
  });

  it('breaks an exact tie with the round draw, not the seat index', () => {
    const winners = new Set<number>();
    for (let i = 0; i < 40 && winners.size < 2; i += 1) {
      const moves = [move(0, Action.Guard, 0, `t${i}`), move(1, Action.Guard, 0, `t${i}`)];
      const { states: next } = resolveRound(R, SEED, 9, freshStates(2, 5), moves, 4);
      const survivor = next.findIndex((state) => state.alive);
      winners.add(survivor);

      const entropy = roundSeed(SEED, 9, saltsBySeat(2, moves));
      expect(survivor).toBe(tiebreakKey(entropy, 0) < tiebreakKey(entropy, 1) ? 0 : 1);
    }
    expect([...winners].sort()).toEqual([0, 1]);
  });

  it('counts a missing move as a timeout that takes every hit', () => {
    const { states: next, record } = resolveRound(R, SEED, 1, freshStates(2), [move(0, Action.Strike, 1)]);

    const silent = record.moves.find((entry) => entry.index === 1);
    expect(silent?.revealed).toBe(false);
    expect(silent?.salt).toBe(ZERO_SALT);
    expect(next[1]?.timeouts).toBe(1);
    expect(next[0]?.timeouts).toBe(0);
    expect(record.strikes[0]?.outcome).toBe(StrikeOutcome.Hit);
    expect(next[1]?.hp).toBe(R.startingHp - R.strikeDamage);
  });

  it('records each revealed salt in the round', () => {
    const moves = [move(0, Action.Guard), move(1, Action.Charge)];
    const { record } = resolveRound(R, SEED, 1, freshStates(2), moves);
    expect(record.moves.map((entry) => entry.salt)).toEqual(moves.map((entry) => entry.salt));
  });

  it('ignores the order in which moves are supplied', () => {
    const moves = [move(0, Action.Strike, 3), move(1, Action.Guard), move(2, Action.Charge), move(3, Action.Strike, 2)];

    const forwards = resolveRound(R, SEED, 4, freshStates(4), moves);
    const backwards = resolveRound(R, SEED, 4, freshStates(4), [...moves].reverse());

    expect(backwards.states).toEqual(forwards.states);
    expect(backwards.record).toEqual(forwards.record);
  });

  it('does not mutate the states it is given', () => {
    const states = freshStates(3);
    const snapshot = structuredClone(states);
    resolveRound(R, SEED, 8, states, [move(0, Action.Strike, 1), move(1, Action.Strike, 0), move(2, Action.Charge)]);
    expect(states).toEqual(snapshot);
  });
});
