import { gsap } from 'gsap';
import type { Timeline } from './choreography.js';

/**
 * What one seat shows while a round is being played back.
 *
 * GSAP tweens these fields and the arena only reads them, so nothing on the
 * canvas computes its own interpolation. Plain data, not Pixi objects: the
 * timeline that drives them runs in node too, which is how it is tested.
 */
export interface SeatDisplay {
  hp: number;
  alive: boolean;
  /** True from the moment the seat's shatter begins. */
  dying: boolean;
  /** Size of the whole seat: swells as it shatters. */
  scale: number;
  /** Opacity of the whole seat: fades as it shatters. */
  fade: number;
  /** Opacity multiplier from the effects layer: a charging seat's pulse. */
  veil: number;
  /** Displacement from the seat's home: a lunge, or a sidestep. */
  dx: number;
  dy: number;
}

export interface Replay {
  round: number;
  /** Paused on creation. The arena plays it; tests seek it. */
  timeline: gsap.core.Timeline;
  seats: Map<number, SeatDisplay>;
  /** 0 outside the stall penalty, peaking at 1 halfway through it. */
  stall: { flare: number };
}

/**
 * Fast at first, then settling: how a draining bar reads as a hit.
 * Cubic — GSAP numbers its powers one above the curve they draw.
 */
const DRAIN = 'power2.out';
/** Share of a shatter spent swelling before it shrinks into the dead style. */
const SWELL = 0.35;
const SHATTER_SCALE = 1.2;
/** Opacity of a seat that is out of the match. */
export const DEAD_FADE = 0.4;

/**
 * Builds the round's timeline.
 *
 * Every HP tween ends on the value the choreography published rather than on
 * anything computed here, and GSAP lands a finished tween on its end value
 * exactly — so a replay that has played out shows the published integer, never
 * a float one step away from it.
 */
export function buildReplay(round: number, choreo: Timeline): Replay {
  const timeline = gsap.timeline({ paused: true });
  const seats = new Map<number, SeatDisplay>();

  for (const [index, track] of choreo.tracks) {
    const strike = track.strikeWindow;
    const settle = track.settleWindow;
    const seat: SeatDisplay = {
      // A seat nothing touches starts, and stays, on its final value.
      hp: strike || settle ? track.before : track.after,
      alive: track.aliveBefore,
      dying: false,
      scale: 1,
      fade: track.aliveBefore ? 1 : DEAD_FADE,
      veil: 1,
      dx: 0,
      dy: 0,
    };
    seats.set(index, seat);

    if (strike) {
      timeline.to(seat, { hp: track.afterStrikes, duration: span(strike), ease: DRAIN }, strike.start);
    }
    if (settle) {
      // The stall penalty, and whatever else the engine did that the client
      // cannot reconstruct — landing on the published value either way.
      timeline.to(seat, { hp: track.after, duration: span(settle), ease: DRAIN }, settle.start);
    } else if (strike) {
      timeline.set(seat, { hp: track.after }, strike.end);
    }

    const shatter = track.eliminateWindow;
    if (shatter) {
      const length = span(shatter);
      timeline
        .set(seat, { dying: true }, shatter.start)
        .to(
          seat,
          {
            keyframes: [
              { scale: SHATTER_SCALE, duration: length * SWELL },
              { scale: 1, duration: length * (1 - SWELL) },
            ],
            ease: 'none',
          },
          shatter.start,
        )
        .to(seat, { fade: DEAD_FADE, duration: length, ease: 'none' }, shatter.start)
        // Alive on screen until the shatter has played out, so the switch to
        // the dead style happens at the end of the beat, not the start.
        .set(seat, { alive: false }, shatter.end);
    }
  }

  const stall = { flare: 0 };
  if (choreo.stall) {
    // Up and back down over the penalty: `sine.out` mirrored by the yoyo
    // traces one arch of a sine wave.
    timeline.to(
      stall,
      { flare: 1, duration: span(choreo.stall) / 2, ease: 'sine.out', yoyo: true, repeat: 1 },
      choreo.stall.start,
    );
  }

  // Pads the timeline to the choreography's full length, so it neither ends
  // before the last beat nor reports a shorter duration than the schedule.
  timeline.set({}, {}, choreo.duration);

  return { round, timeline, seats, stall };
}

function span(window: { start: number; end: number }): number {
  return window.end - window.start;
}
