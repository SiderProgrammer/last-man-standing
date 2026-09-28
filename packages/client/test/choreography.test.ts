import { describe, expect, it } from 'vitest';
import {
  Action,
  AttackOutcome,
  type AttackRecord,
  type RoundRecord,
} from '@lms/protocol';
import { choreograph, type SeatSnapshot, type Timeline } from '../src/arena/choreography.js';
import { buildReplay, type SeatDisplay } from '../src/arena/replay.js';
import { bytes32 } from './helpers.js';

/** The server's default replay hold, which every timeline must fit inside. */
const HOLD_SECONDS = 2.5;

function seats(...hp: number[]): SeatSnapshot[] {
  return hp.map((value, index) => ({ index, hp: value, alive: value > 0 }));
}

function record(fields: Partial<RoundRecord> & Pick<RoundRecord, 'hpAfter'>): RoundRecord {
  return {
    round: 3,
    moves: fields.hpAfter.map((_, index) => ({
      index,
      action: Action.Defend,
      target: 0,
      revealed: true,
    })),
    attacks: [],
    stormDamage: 0,
    eliminated: [],
    hash: bytes32('round'),
    ...fields,
  };
}

function attack(
  attacker: number,
  target: number,
  outcome: AttackRecord['outcome'],
  damage = 0,
  riposte = 0,
): AttackRecord {
  return { attacker, target, outcome, damage, riposte };
}

const END = 99;

/**
 * What every seat shows `t` seconds in, read by seeking the GSAP timeline the
 * arena plays. Copied out, because the timeline keeps mutating the live objects.
 */
function sample(timeline: Timeline, t: number): Map<number, SeatDisplay> {
  const replay = buildReplay(3, timeline);
  replay.timeline.seek(t);
  return new Map([...replay.seats].map(([seat, display]) => [seat, { ...display }]));
}

describe('choreograph', () => {
  it('ends every seat exactly on the published hpAfter', () => {
    const timeline = choreograph(
      record({
        attacks: [attack(0, 1, AttackOutcome.Hit, 34), attack(2, 3, AttackOutcome.Parried, 0, 20)],
        stormDamage: 6,
        hpAfter: [94, 60, 74, 94],
      }),
      seats(100, 100, 100, 100),
    );

    const end = sample(timeline, END);
    expect([0, 1, 2, 3].map((seat) => end.get(seat)?.hp)).toEqual([94, 60, 74, 94]);
    // Also exactly at the end of the timeline, not only long after it.
    expect(sample(timeline, timeline.duration).get(1)?.hp).toBe(60);
  });

  /**
   * The engine keeps exactly one winner by reviving the least-overkilled seat
   * on 1 HP. The client cannot reconstruct that, so it must trust `hpAfter`
   * rather than its own arithmetic.
   */
  it('lands on the survivor rule even when the arithmetic says everyone died', () => {
    const timeline = choreograph(
      record({
        attacks: [attack(0, 1, AttackOutcome.Hit, 34), attack(1, 0, AttackOutcome.Hit, 34)],
        hpAfter: [1, 0],
        eliminated: [1],
      }),
      seats(20, 10),
    );

    const end = sample(timeline, END);
    expect(end.get(0)).toMatchObject({ hp: 1, alive: true, dying: false });
    expect(end.get(1)).toMatchObject({ hp: 0, alive: false });
  });

  it('drains to the damage-plus-riposte waypoint before the storm', () => {
    const timeline = choreograph(
      record({
        attacks: [
          attack(0, 1, AttackOutcome.Hit, 34),
          // Seat 0 also attacks a defender and eats the riposte.
          attack(0, 2, AttackOutcome.Parried, 0, 20),
        ],
        stormDamage: 6,
        hpAfter: [74, 60, 94],
      }),
      seats(100, 100, 100),
    );

    const storm = timeline.storm;
    expect(storm).not.toBeNull();
    // Just before the storm starts, every blow has landed and drained.
    const beforeStorm = sample(timeline, (storm?.start ?? 0) - 0.001);
    expect(beforeStorm.get(0)?.hp).toBe(80);
    expect(beforeStorm.get(1)?.hp).toBe(66);
    expect(beforeStorm.get(2)?.hp).toBe(100);
  });

  it('bounces a riposte back onto the attacker of a parried blow', () => {
    const timeline = choreograph(
      record({
        attacks: [attack(3, 1, AttackOutcome.Parried, 0, 20)],
        hpAfter: [100, 100, 100, 80],
      }),
      seats(100, 100, 100, 100),
    );

    const riposte = timeline.beats.find((beat) => beat.kind === 'riposte');
    expect(riposte).toMatchObject({ from: 1, to: 3, damage: 20 });

    const impact = timeline.beats.find((beat) => beat.kind === 'impact');
    // The riposte launches the moment the blow is parried.
    expect(riposte?.start).toBe(impact?.start);
  });

  it('gives a void attack no travel and no impact', () => {
    const timeline = choreograph(
      record({ attacks: [attack(0, 1, AttackOutcome.Void)], hpAfter: [100, 0] }),
      [
        { index: 0, hp: 100, alive: true },
        { index: 1, hp: 0, alive: false },
      ],
    );

    expect(timeline.beats.some((beat) => beat.kind === 'travel')).toBe(false);
    expect(timeline.beats.some((beat) => beat.kind === 'impact')).toBe(false);
  });

  it('shows a miss without draining the target', () => {
    const timeline = choreograph(
      record({ attacks: [attack(0, 1, AttackOutcome.Missed)], hpAfter: [100, 100] }),
      seats(100, 100),
    );

    const impact = timeline.beats.find((beat) => beat.kind === 'impact');
    expect(impact).toMatchObject({ outcome: AttackOutcome.Missed, damage: 0 });
    for (let t = 0; t <= timeline.duration; t += 0.05) {
      expect(sample(timeline, t).get(1)?.hp).toBe(100);
    }
  });

  it('eliminates in the record order, one after another', () => {
    const timeline = choreograph(
      record({ stormDamage: 30, hpAfter: [0, 10, 0, 0], eliminated: [3, 0, 2] }),
      seats(20, 40, 25, 5),
    );

    const eliminations = timeline.beats.filter((beat) => beat.kind === 'eliminate');
    expect(eliminations.map((beat) => (beat.kind === 'eliminate' ? beat.seat : -1))).toEqual([3, 0, 2]);
    const starts = eliminations.map((beat) => beat.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(new Set(starts).size).toBe(3);
  });

  it('keeps the doomed seat alive on screen until its shatter has played', () => {
    const timeline = choreograph(
      record({ attacks: [attack(0, 1, AttackOutcome.Hit, 34)], hpAfter: [100, 0], eliminated: [1] }),
      seats(100, 20),
    );
    const beat = timeline.beats.find((entry) => entry.kind === 'eliminate');
    if (!beat) throw new Error('no elimination beat');

    expect(sample(timeline, beat.start - 0.001).get(1)).toMatchObject({ alive: true, dying: false });
    expect(sample(timeline, (beat.start + beat.end) / 2).get(1)?.alive).toBe(true);
    expect(sample(timeline, beat.end).get(1)).toMatchObject({ alive: false, dying: true });
  });

  it('shows the pre-round HP before anything has happened', () => {
    const timeline = choreograph(
      record({ attacks: [attack(0, 1, AttackOutcome.Hit, 34)], stormDamage: 6, hpAfter: [94, 60] }),
      seats(100, 100),
    );

    const start = sample(timeline, 0);
    expect(start.get(0)?.hp).toBe(100);
    expect(start.get(1)?.hp).toBe(100);
    expect(sample(timeline, -1).get(1)?.hp).toBe(100);
  });

  it('shows storm damage as the HP a seat visibly loses to it', () => {
    const timeline = choreograph(
      record({
        moves: [
          { index: 0, action: Action.Defend, target: 0, revealed: true },
          { index: 1, action: Action.Hide, target: 0, revealed: true },
        ],
        stormDamage: 12,
        // A hider takes a reduced share; the client learns that from hpAfter,
        // not from a rule constant.
        hpAfter: [88, 94],
      }),
      seats(100, 100),
    );

    const storms = timeline.beats.filter((beat) => beat.kind === 'storm');
    expect(storms.map((beat) => (beat.kind === 'storm' ? [beat.seat, beat.damage] : []))).toEqual([
      [0, 12],
      [1, 6],
    ]);
  });

  it('flags a seat that never revealed', () => {
    const timeline = choreograph(
      record({
        moves: [
          { index: 0, action: Action.Attack, target: 1, revealed: true },
          { index: 1, action: Action.None, target: 0, revealed: false },
        ],
        hpAfter: [100, 100],
      }),
      seats(100, 100),
    );

    expect(timeline.beats).toContainEqual(expect.objectContaining({ kind: 'noShow', seat: 1 }));
    expect(timeline.beats).toContainEqual(
      expect.objectContaining({ kind: 'declare', seat: 0, action: Action.Attack }),
    );
  });

  it('never moves HP for a quiet round', () => {
    const timeline = choreograph(record({ hpAfter: [100, 100] }), seats(100, 100));

    expect(timeline.storm).toBeNull();
    for (let t = 0; t <= timeline.duration; t += 0.05) {
      expect(sample(timeline, t).get(0)?.hp).toBe(100);
    }
  });

  /**
   * The budget that justifies the server's default hold: eight seats, every
   * one attacking, parries bouncing ripostes, a heavy storm and several kills.
   */
  it('fits the worst case inside the default replay hold', () => {
    const attacks = Array.from({ length: 8 }, (_, seat) =>
      attack(
        seat,
        (seat + 1) % 8,
        seat % 2 === 0 ? AttackOutcome.Parried : AttackOutcome.Hit,
        seat % 2 === 0 ? 0 : 34,
        seat % 2 === 0 ? 20 : 0,
      ),
    );
    const timeline = choreograph(
      record({
        moves: Array.from({ length: 8 }, (_, index) => ({
          index,
          action: Action.Attack,
          target: (index + 1) % 8,
          revealed: true,
        })),
        attacks,
        stormDamage: 60,
        hpAfter: [0, 0, 0, 0, 0, 0, 0, 1],
        eliminated: [0, 1, 2, 3, 4, 5, 6],
      }),
      seats(40, 40, 40, 40, 40, 40, 40, 40),
    );

    expect(timeline.duration).toBeLessThanOrEqual(HOLD_SECONDS);
    expect(timeline.beats.filter((beat) => beat.kind === 'eliminate')).toHaveLength(7);
  });
});

describe('replay timeline', () => {
  it('runs exactly as long as the choreography', () => {
    const timeline = choreograph(
      record({ attacks: [attack(0, 1, AttackOutcome.Hit, 34)], stormDamage: 6, hpAfter: [94, 60] }),
      seats(100, 100),
    );
    expect(buildReplay(3, timeline).timeline.duration()).toBeCloseTo(timeline.duration, 6);
  });

  it('eases the drain with a cubic ease-out, as the arena always has', () => {
    const timeline = choreograph(
      record({ attacks: [attack(0, 1, AttackOutcome.Hit, 60)], hpAfter: [100, 40] }),
      seats(100, 100),
    );
    const track = timeline.tracks.get(1);
    const window = track?.attackWindow;
    if (!window) throw new Error('no attack window');

    // Halfway through a cubic ease-out, 1 - 0.5^3 = 87.5% of the drop is done.
    const halfway = sample(timeline, (window.start + window.end) / 2).get(1)?.hp;
    expect(halfway).toBeCloseTo(100 - 60 * 0.875, 6);
  });

  it('flares the storm ring up and back down across the storm', () => {
    const timeline = choreograph(record({ stormDamage: 12, hpAfter: [88, 88] }), seats(100, 100));
    const storm = timeline.storm;
    if (!storm) throw new Error('no storm');

    const flareAt = (t: number) => {
      const replay = buildReplay(3, timeline);
      replay.timeline.seek(t);
      return replay.storm.flare;
    };
    expect(flareAt(storm.start)).toBe(0);
    expect(flareAt((storm.start + storm.end) / 2)).toBeCloseTo(1, 6);
    expect(flareAt(storm.end)).toBeCloseTo(0, 6);
  });

  it('swells a shattering seat, then shrinks it into the dead style', () => {
    const timeline = choreograph(
      record({ attacks: [attack(0, 1, AttackOutcome.Hit, 34)], hpAfter: [100, 0], eliminated: [1] }),
      seats(100, 20),
    );
    const beat = timeline.beats.find((entry) => entry.kind === 'eliminate');
    if (!beat) throw new Error('no elimination beat');
    const length = beat.end - beat.start;

    expect(sample(timeline, beat.start + length * 0.35).get(1)?.scale).toBeCloseTo(1.2, 6);
    expect(sample(timeline, beat.end).get(1)).toMatchObject({ scale: 1, fade: 0.4 });
  });
});
