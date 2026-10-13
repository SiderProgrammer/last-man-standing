import { describe, expect, it } from 'vitest';
import {
  Action,
  AttackOutcome,
  DEFAULT_RULES,
  draw,
  drawBps,
  roundSeed,
  saltsBySeat,
  stormDamageForRound,
  ZERO_SALT,
  type PlayerState,
} from '@lms/protocol';
import { PARRY_NONCE_BASE, resolveRound, type DeclaredMove } from '@lms/engine';
import { bytes32, freshStates } from './helpers.js';

const SEED = bytes32('resolve-seed');

function move(index: number, action: DeclaredMove['action'], target = 0, saltLabel = 'a'): DeclaredMove {
  return { index, action, target, revealed: true, salt: bytes32(`salt:${saltLabel}:${index}`) };
}

describe('round resolution', () => {
  it('applies attack damage to an attacking target', () => {
    const states = freshStates(2);
    const { states: next, record } = resolveRound(DEFAULT_RULES, SEED, 1, states, [
      move(0, Action.Attack, 1),
      move(1, Action.Attack, 0),
    ]);

    // Round 1 is inside the storm grace period, so damage is attacks only.
    expect(record.stormDamage).toBe(0);
    expect(next[0]?.hp).toBe(DEFAULT_RULES.startingHp - DEFAULT_RULES.attackDamage);
    expect(next[1]?.hp).toBe(DEFAULT_RULES.startingHp - DEFAULT_RULES.attackDamage);
    expect(record.attacks.every((attack) => attack.outcome === AttackOutcome.Hit)).toBe(true);
  });

  it('punishes a lone attack into a defender with a riposte', () => {
    const states = freshStates(2);
    const { states: next, record } = resolveRound(DEFAULT_RULES, SEED, 1, states, [
      move(0, Action.Attack, 1),
      move(1, Action.Defend),
    ]);

    expect(record.attacks[0]?.outcome).toBe(AttackOutcome.Parried);
    expect(next[1]?.hp).toBe(DEFAULT_RULES.startingHp);
    expect(next[0]?.hp).toBe(DEFAULT_RULES.startingHp - DEFAULT_RULES.riposteDamage);
  });

  it('lets hiders take only a share of the storm', () => {
    const round = 6;
    const storm = stormDamageForRound(DEFAULT_RULES, round);
    const states = freshStates(2);
    const { states: next } = resolveRound(DEFAULT_RULES, SEED, round, states, [
      move(0, Action.Defend),
      move(1, Action.Hide),
    ]);

    expect(storm).toBeGreaterThan(0);
    expect(next[0]?.hp).toBe(DEFAULT_RULES.startingHp - storm);
    expect(next[1]?.hp).toBe(
      DEFAULT_RULES.startingHp - Math.floor((storm * DEFAULT_RULES.hideStormBps) / 10_000),
    );
    // This gap is the only reason hiding beats turtling.
    expect(next[1]?.hp as number).toBeGreaterThan(next[0]?.hp as number);
  });

  it('voids an attack on an eliminated or out-of-range seat', () => {
    const states = freshStates(3);
    (states[2] as PlayerState).alive = false;

    const { record } = resolveRound(DEFAULT_RULES, SEED, 1, states, [
      move(0, Action.Attack, 2),
      move(1, Action.Attack, 99),
    ]);

    expect(record.attacks).toHaveLength(2);
    expect(record.attacks.every((attack) => attack.outcome === AttackOutcome.Void)).toBe(true);
    expect(record.attacks.every((attack) => attack.damage === 0)).toBe(true);
  });

  it('resolves attacks simultaneously so a dying player still lands its move', () => {
    const states = freshStates(2, DEFAULT_RULES.attackDamage);
    const { states: next, record } = resolveRound(DEFAULT_RULES, SEED, 1, states, [
      move(0, Action.Attack, 1),
      move(1, Action.Attack, 0),
    ]);

    // Both were on lethal HP and both attacks connect, so the last-stand rule
    // has to pick a single winner rather than wiping the lobby.
    expect(record.attacks.every((attack) => attack.outcome === AttackOutcome.Hit)).toBe(true);
    expect(next.filter((state) => state.alive)).toHaveLength(1);
    expect(record.eliminated).toHaveLength(1);
  });

  it('revives exactly one player when a round would wipe the lobby', () => {
    const states = freshStates(4, 5);
    const { states: next, record } = resolveRound(DEFAULT_RULES, SEED, 20, states, [
      move(0, Action.Defend),
      move(1, Action.Defend),
      move(2, Action.Defend),
      move(3, Action.Hide),
    ]);

    const survivors = next.filter((state) => state.alive);
    expect(survivors).toHaveLength(1);
    // The hider took half storm, so it is the one left standing on 1 HP.
    expect(survivors[0]?.index).toBe(3);
    expect(survivors[0]?.hp).toBe(1);
    expect(record.eliminated).toEqual([0, 1, 2]);
  });

  it('counts a missing move as a timeout that takes every hit', () => {
    const states = freshStates(2);
    const { states: next, record } = resolveRound(DEFAULT_RULES, SEED, 1, states, [
      move(0, Action.Attack, 1),
    ]);

    const silent = record.moves.find((entry) => entry.index === 1);
    expect(silent?.revealed).toBe(false);
    expect(silent?.salt).toBe(ZERO_SALT);
    expect(next[1]?.timeouts).toBe(1);
    expect(next[0]?.timeouts).toBe(0);
    // No evade bonus for not playing: the attack always lands.
    expect(record.attacks[0]?.outcome).toBe(AttackOutcome.Hit);
    expect(next[1]?.hp).toBe(DEFAULT_RULES.startingHp - DEFAULT_RULES.attackDamage);
  });

  it('never lets an absent player evade, whatever the seed', () => {
    for (let i = 0; i < 50; i += 1) {
      const { record } = resolveRound(DEFAULT_RULES, bytes32(`absent:${i}`), 1, freshStates(2), [
        move(0, Action.Attack, 1),
      ]);
      expect(record.attacks[0]?.outcome).toBe(AttackOutcome.Hit);
    }
  });

  it('parries exactly one attacker and lets the rest connect', () => {
    const states = freshStates(4);
    const { states: next, record } = resolveRound(DEFAULT_RULES, SEED, 1, states, [
      move(0, Action.Attack, 3),
      move(1, Action.Attack, 3),
      move(2, Action.Attack, 3),
      move(3, Action.Defend),
    ]);

    const outcomes = record.attacks.map((attack) => attack.outcome);
    expect(outcomes.filter((outcome) => outcome === AttackOutcome.Parried)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === AttackOutcome.Hit)).toHaveLength(2);
    expect(next[3]?.hp).toBe(DEFAULT_RULES.startingHp - 2 * DEFAULT_RULES.attackDamage);

    const parried = record.attacks.find((attack) => attack.outcome === AttackOutcome.Parried);
    const riposted = next[parried?.attacker as number];
    expect(riposted?.hp).toBe(DEFAULT_RULES.startingHp - DEFAULT_RULES.riposteDamage);
  });

  it('picks the parried attacker from the round seed, not from seat order', () => {
    const states = freshStates(3);
    const picks = new Set<number>();
    for (let i = 0; i < 40 && picks.size < 2; i += 1) {
      const moves = [
        move(0, Action.Attack, 2, `p${i}`),
        move(1, Action.Attack, 2, `p${i}`),
        move(2, Action.Defend, 0, `p${i}`),
      ];
      const { record } = resolveRound(DEFAULT_RULES, SEED, 1, states, moves);
      const parried = record.attacks.find((attack) => attack.outcome === AttackOutcome.Parried);
      picks.add(parried?.attacker as number);

      // And it is exactly the documented draw.
      const entropy = roundSeed(SEED, 1, saltsBySeat(3, moves));
      expect(parried?.attacker).toBe(Number(draw(entropy, PARRY_NONCE_BASE + 2) % 2n));
    }
    expect([...picks].sort()).toEqual([0, 1]);
  });

  it('rolls a hider\'s evade from every revealed salt', () => {
    const states = freshStates(2);
    const outcomes = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      const moves = [move(0, Action.Attack, 1, `h${i}`), move(1, Action.Hide, 0, `h${i}`)];
      const { record } = resolveRound(DEFAULT_RULES, SEED, 1, states, moves);
      const entropy = roundSeed(SEED, 1, saltsBySeat(2, moves));
      const expected =
        drawBps(entropy, 0) < DEFAULT_RULES.hideEvadeBps ? AttackOutcome.Missed : AttackOutcome.Hit;
      expect(record.attacks[0]?.outcome).toBe(expected);
      outcomes.add(record.attacks[0]?.outcome as string);
    }
    // Same seed and round, different salts: both outcomes occur, so the roll is
    // not knowable from the public seed alone.
    expect([...outcomes].sort()).toEqual([AttackOutcome.Hit, AttackOutcome.Missed].sort());
  });

  it('records each revealed salt in the round', () => {
    const states = freshStates(2);
    const moves = [move(0, Action.Defend), move(1, Action.Hide)];
    const { record } = resolveRound(DEFAULT_RULES, SEED, 1, states, moves);
    expect(record.moves.map((entry) => entry.salt)).toEqual(moves.map((entry) => entry.salt));
  });

  it('ignores the order in which moves are supplied', () => {
    const states = freshStates(4);
    const moves = [
      move(0, Action.Attack, 3),
      move(1, Action.Defend),
      move(2, Action.Hide),
      move(3, Action.Attack, 2),
    ];

    const forwards = resolveRound(DEFAULT_RULES, SEED, 4, states, moves);
    const backwards = resolveRound(DEFAULT_RULES, SEED, 4, states, [...moves].reverse());

    expect(backwards.states).toEqual(forwards.states);
    expect(backwards.record).toEqual(forwards.record);
  });

  it('does not mutate the states it is given', () => {
    const states = freshStates(3);
    const snapshot = structuredClone(states);
    resolveRound(DEFAULT_RULES, SEED, 8, states, [
      move(0, Action.Attack, 1),
      move(1, Action.Attack, 0),
      move(2, Action.Hide),
    ]);
    expect(states).toEqual(snapshot);
  });
});
