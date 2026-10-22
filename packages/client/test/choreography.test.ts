import { describe, expect, it } from 'vitest';
import {
  Action,
  StrikeOutcome,
  type RoundRecord,
  type StrikeRecord,
  ZERO_SALT,
} from '@lms/protocol';
import { choreograph, type SeatSnapshot, type Timeline } from '../src/arena/choreography.js';
import { buildReplay, type SeatDisplay } from '../src/arena/replay.js';
import { bytes32 } from './helpers.js';

/** The server's default replay hold, which every timeline must fit inside. */
const HOLD_SECONDS = 2.5;
const MAX_HP = 100;

function seats(...hp: number[]): SeatSnapshot[] {
  return hp.map((value, index) => ({ index, hp: value, alive: value > 0 }));
}

function record(fields: Partial<RoundRecord> & Pick<RoundRecord, 'hpAfter'>): RoundRecord {
  return {
    round: 3,
    moves: fields.hpAfter.map((_, index) => ({
      index,
      action: Action.Guard,
      target: 0,
      revealed: true,
      salt: ZERO_SALT,
    })),
    strikes: [],
    stallDamage: 0,
    eliminated: [],
    hash: bytes32('round'),
    ...fields,
  };
}

function strike(
  striker: number,
  target: number,
  outcome: StrikeRecord['outcome'],
  { damage = 0, heal = 0, reflected = 0, charged = false } = {},
): StrikeRecord {
  return { striker, target, outcome, charged, damage, heal, reflected };
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
        strikes: [
          strike(0, 1, StrikeOutcome.Hit, { damage: 25, heal: 12 }),
          strike(2, 3, StrikeOutcome.Guarded, { reflected: 34 }),
        ],
        stallDamage: 8,
        hpAfter: [92, 67, 58, 92],
      }),
      seats(100, 100, 100, 100),
      MAX_HP,
    );

    const end = sample(timeline, END);
    expect([0, 1, 2, 3].map((seat) => end.get(seat)?.hp)).toEqual([92, 67, 58, 92]);
    // Also exactly at the end of the timeline, not only long after it.
    expect(sample(timeline, timeline.duration).get(1)?.hp).toBe(67);
  });

  /**
   * The engine keeps exactly one winner by reviving the least-overkilled seat
   * on 1 HP. The client cannot reconstruct that, so it must trust `hpAfter`
   * rather than its own arithmetic.
   */
  it('lands on the survivor rule even when the arithmetic says everyone died', () => {
    const timeline = choreograph(
      record({
        strikes: [
          strike(0, 1, StrikeOutcome.Hit, { damage: 25, heal: 12 }),
          strike(1, 0, StrikeOutcome.Hit, { damage: 25, heal: 12 }),
        ],
        hpAfter: [1, 0],
        eliminated: [1],
      }),
      seats(12, 10),
      MAX_HP,
    );

    const end = sample(timeline, END);
    expect(end.get(0)).toMatchObject({ hp: 1, alive: true, dying: false });
    expect(end.get(1)).toMatchObject({ hp: 0, alive: false });
  });

  it('moves HP to the hits, reflections and heals before the stall penalty', () => {
    const timeline = choreograph(
      record({
        strikes: [
          strike(0, 1, StrikeOutcome.Hit, { damage: 25, heal: 12 }),
          // Seat 0 also strikes a guard and eats the reflection.
          strike(0, 2, StrikeOutcome.Guarded, { reflected: 34 }),
        ],
        stallDamage: 8,
        hpAfter: [70, 67, 92],
      }),
      seats(100, 100, 100),
      MAX_HP,
    );

    const stall = timeline.stall;
    expect(stall).not.toBeNull();
    // Just before the penalty starts, every blow has landed and drained.
    const beforeStall = sample(timeline, (stall?.start ?? 0) - 0.001);
    expect(beforeStall.get(0)?.hp).toBe(100 - 34 + 12);
    expect(beforeStall.get(1)?.hp).toBe(75);
    expect(beforeStall.get(2)?.hp).toBe(100);
  });

  it('never fills a striker past the HP cap with its heal', () => {
    const timeline = choreograph(
      record({ strikes: [strike(0, 1, StrikeOutcome.Hit, { damage: 25, heal: 12 })], hpAfter: [100, 75] }),
      seats(100, 100),
      MAX_HP,
    );

    expect(timeline.beats).toContainEqual(expect.objectContaining({ kind: 'heal', seat: 0, amount: 12 }));
    for (let t = 0; t <= timeline.duration; t += 0.05) {
      expect(sample(timeline, t).get(0)?.hp).toBeLessThanOrEqual(MAX_HP);
    }
  });

  it('bounces a Guard’s reflection back onto the striker it blocked', () => {
    const timeline = choreograph(
      record({ strikes: [strike(3, 1, StrikeOutcome.Guarded, { reflected: 34 })], hpAfter: [100, 100, 100, 66] }),
      seats(100, 100, 100, 100),
    );

    const reflect = timeline.beats.find((beat) => beat.kind === 'reflect');
    expect(reflect).toMatchObject({ from: 1, to: 3, damage: 34 });

    const impact = timeline.beats.find((beat) => beat.kind === 'impact');
    // The reflection launches the moment the blow is blocked.
    expect(reflect?.start).toBe(impact?.start);
  });

  it('marks a strike that spent a Charge, in flight and on impact', () => {
    const timeline = choreograph(
      record({ strikes: [strike(0, 1, StrikeOutcome.Hit, { damage: 59, heal: 29, charged: true })], hpAfter: [100, 41] }),
      seats(100, 100),
    );

    expect(timeline.beats).toContainEqual(expect.objectContaining({ kind: 'travel', charged: true }));
    expect(timeline.beats).toContainEqual(expect.objectContaining({ kind: 'impact', charged: true, damage: 59 }));
  });

  it('gives a void strike no travel and no impact', () => {
    const timeline = choreograph(
      record({ strikes: [strike(0, 1, StrikeOutcome.Void)], hpAfter: [100, 0] }),
      [
        { index: 0, hp: 100, alive: true },
        { index: 1, hp: 0, alive: false },
      ],
    );

    expect(timeline.beats.some((beat) => beat.kind === 'travel')).toBe(false);
    expect(timeline.beats.some((beat) => beat.kind === 'impact')).toBe(false);
  });

  it('shows a block without draining the target', () => {
    const timeline = choreograph(
      record({ strikes: [strike(0, 1, StrikeOutcome.Guarded, { reflected: 34 })], hpAfter: [66, 100] }),
      seats(100, 100),
    );

    const impact = timeline.beats.find((beat) => beat.kind === 'impact');
    expect(impact).toMatchObject({ outcome: StrikeOutcome.Guarded, damage: 0 });
    for (let t = 0; t <= timeline.duration; t += 0.05) {
      expect(sample(timeline, t).get(1)?.hp).toBe(100);
    }
  });

  it('eliminates in the record order, one after another', () => {
    const timeline = choreograph(
      record({ stallDamage: 30, hpAfter: [0, 10, 0, 0], eliminated: [3, 0, 2] }),
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
      record({ strikes: [strike(0, 1, StrikeOutcome.Hit, { damage: 25 })], hpAfter: [100, 0], eliminated: [1] }),
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
      record({ strikes: [strike(0, 1, StrikeOutcome.Hit, { damage: 25 })], stallDamage: 8, hpAfter: [92, 67] }),
      seats(100, 100),
    );

    const start = sample(timeline, 0);
    expect(start.get(0)?.hp).toBe(100);
    expect(start.get(1)?.hp).toBe(100);
    expect(sample(timeline, -1).get(1)?.hp).toBe(100);
  });

  it('shows the stall penalty as the HP each seat visibly loses to it', () => {
    const timeline = choreograph(
      record({
        moves: [
          { index: 0, action: Action.Guard, target: 0, revealed: true, salt: ZERO_SALT },
          { index: 1, action: Action.Charge, target: 0, revealed: true, salt: ZERO_SALT },
        ],
        stallDamage: 8,
        // A seat already low loses only what it had; the client learns that
        // from hpAfter, not from a rule constant.
        hpAfter: [92, 0],
        eliminated: [1],
      }),
      seats(100, 5),
    );

    const stalls = timeline.beats.filter((beat) => beat.kind === 'stall');
    expect(stalls.map((beat) => (beat.kind === 'stall' ? [beat.seat, beat.damage] : []))).toEqual([
      [0, 8],
      [1, 5],
    ]);
  });

  it('flags a seat that never revealed', () => {
    const timeline = choreograph(
      record({
        moves: [
          { index: 0, action: Action.Strike, target: 1, revealed: true, salt: ZERO_SALT },
          { index: 1, action: Action.None, target: 0, revealed: false, salt: ZERO_SALT },
        ],
        hpAfter: [100, 100],
      }),
      seats(100, 100),
    );

    expect(timeline.beats).toContainEqual(expect.objectContaining({ kind: 'noShow', seat: 1 }));
    expect(timeline.beats).toContainEqual(
      expect.objectContaining({ kind: 'declare', seat: 0, action: Action.Strike }),
    );
  });

  it('never moves HP for a quiet round', () => {
    const timeline = choreograph(record({ hpAfter: [100, 100] }), seats(100, 100));

    expect(timeline.stall).toBeNull();
    for (let t = 0; t <= timeline.duration; t += 0.05) {
      expect(sample(timeline, t).get(0)?.hp).toBe(100);
    }
  });

  /**
   * The budget that justifies the server's default hold: eight seats, every
   * one striking, guards reflecting, heals rising, a stall penalty and several
   * kills.
   */
  it('fits the worst case inside the default replay hold', () => {
    const strikes = Array.from({ length: 8 }, (_, seat) =>
      strike(
        seat,
        (seat + 1) % 8,
        seat % 2 === 0 ? StrikeOutcome.Guarded : StrikeOutcome.Hit,
        seat % 2 === 0 ? { reflected: 34 } : { damage: 59, heal: 29, charged: true },
      ),
    );
    const timeline = choreograph(
      record({
        moves: Array.from({ length: 8 }, (_, index) => ({
          index,
          action: Action.Strike,
          target: (index + 1) % 8,
          revealed: true,
          salt: ZERO_SALT,
        })),
        strikes,
        stallDamage: 40,
        hpAfter: [0, 0, 0, 0, 0, 0, 0, 1],
        eliminated: [0, 1, 2, 3, 4, 5, 6],
      }),
      seats(40, 40, 40, 40, 40, 40, 40, 40),
      MAX_HP,
    );

    expect(timeline.duration).toBeLessThanOrEqual(HOLD_SECONDS);
    expect(timeline.beats.filter((beat) => beat.kind === 'eliminate')).toHaveLength(7);
  });
});

describe('replay timeline', () => {
  it('runs exactly as long as the choreography', () => {
    const timeline = choreograph(
      record({ strikes: [strike(0, 1, StrikeOutcome.Hit, { damage: 25 })], stallDamage: 8, hpAfter: [92, 67] }),
      seats(100, 100),
    );
    expect(buildReplay(3, timeline).timeline.duration()).toBeCloseTo(timeline.duration, 6);
  });

  it('eases the drain with a cubic ease-out, as the arena always has', () => {
    const timeline = choreograph(
      record({ strikes: [strike(0, 1, StrikeOutcome.Hit, { damage: 60 })], hpAfter: [100, 40] }),
      seats(100, 100),
    );
    const track = timeline.tracks.get(1);
    const window = track?.strikeWindow;
    if (!window) throw new Error('no strike window');

    // Halfway through a cubic ease-out, 1 - 0.5^3 = 87.5% of the drop is done.
    const halfway = sample(timeline, (window.start + window.end) / 2).get(1)?.hp;
    expect(halfway).toBeCloseTo(100 - 60 * 0.875, 6);
  });

  it('flares the arena wall up and back down across the stall penalty', () => {
    const timeline = choreograph(record({ stallDamage: 8, hpAfter: [92, 92] }), seats(100, 100));
    const stall = timeline.stall;
    if (!stall) throw new Error('no stall');

    const flareAt = (t: number) => {
      const replay = buildReplay(3, timeline);
      replay.timeline.seek(t);
      return replay.stall.flare;
    };
    expect(flareAt(stall.start)).toBe(0);
    expect(flareAt((stall.start + stall.end) / 2)).toBeCloseTo(1, 6);
    expect(flareAt(stall.end)).toBeCloseTo(0, 6);
  });

  it('swells a shattering seat, then shrinks it into the dead style', () => {
    const timeline = choreograph(
      record({ strikes: [strike(0, 1, StrikeOutcome.Hit, { damage: 25 })], hpAfter: [100, 0], eliminated: [1] }),
      seats(100, 20),
    );
    const beat = timeline.beats.find((entry) => entry.kind === 'eliminate');
    if (!beat) throw new Error('no elimination beat');
    const length = beat.end - beat.start;

    expect(sample(timeline, beat.start + length * 0.35).get(1)?.scale).toBeCloseTo(1.2, 6);
    expect(sample(timeline, beat.end).get(1)).toMatchObject({ scale: 1, fade: 0.4 });
  });
});
