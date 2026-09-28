/**
 * Where things sit in the arena.
 *
 * Extracted from `arena.ts` so the geometry has names instead of literals, and
 * so the radius and centre are computed once rather than derived independently
 * by the seat ring and the storm ring. Pure: no Pixi, no canvas, testable in
 * node.
 */

/** Radius of a seat's circle. Everything else is positioned relative to it. */
export const SEAT_RADIUS = 30;
/** Radius of the HP arc drawn around a seat, clear of the circle above. */
export const HP_ARC_RADIUS = 38;
/** Offset of the chain badge above a seat: clear of both circle and HP arc. */
export const BADGE_Y = -52;
/** Radius of the circular mask an avatar is drawn through. */
export const AVATAR_RADIUS = 28;
/** Rendered size of an avatar sprite, before the mask clips it. */
export const AVATAR_SIZE = 56;
/** Edge of the arena kept clear, wider when avatars push labels downward. */
const MARGIN_PLAIN = 70;
const MARGIN_WITH_AVATARS = 92;
/** How far inside the arena edge the storm ring starts. */
const STORM_INSET = 20;
/** Rounds over which the storm ring tightens to its maximum. */
const STORM_RAMP_ROUNDS = 12;
/** How far the ring closes in at full intensity. */
const STORM_TRAVEL = 30;

export interface Point {
  x: number;
  y: number;
}

export function centreOf(width: number, height: number): Point {
  return { x: width / 2, y: height / 2 };
}

/** Radius the seats are arranged on. */
export function seatRingRadius(width: number, height: number, hasAvatars: boolean): number {
  const margin = hasAvatars ? MARGIN_WITH_AVATARS : MARGIN_PLAIN;
  return Math.min(width, height) / 2 - margin;
}

/**
 * Position of one seat on the ring.
 *
 * Starts at the top and runs clockwise, so seat #0 is where players look for it.
 */
export function seatPosition(
  position: number,
  count: number,
  width: number,
  height: number,
  hasAvatars: boolean,
): Point {
  const radius = seatRingRadius(width, height, hasAvatars);
  const centre = centreOf(width, height);
  const angle = (position / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2;
  return { x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius };
}

export interface StormRing {
  centre: Point;
  radius: number;
  /** 0 at the start of a match, 1 once the storm is at full strength. */
  intensity: number;
}

/** The storm ring, which tightens as its damage ramps with the round number. */
export function stormRing(width: number, height: number, round: number): StormRing {
  const intensity = Math.min(1, round / STORM_RAMP_ROUNDS);
  return {
    centre: centreOf(width, height),
    radius: Math.min(width, height) / 2 - STORM_INSET - intensity * STORM_TRAVEL,
    intensity,
  };
}
