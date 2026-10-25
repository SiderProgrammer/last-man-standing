/**
 * Where things sit in the arena.
 *
 * Extracted from `arena.ts` so the geometry has names instead of literals, and
 * so the radius and centre are computed once rather than derived independently
 * by the seat ring and the arena wall. Pure: no Pixi, no canvas, testable in
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
/** How far inside the arena edge the wall starts. */
const STORM_INSET = 20;
/**
 * How far the wall closes in at full pressure: far enough that, once the stall
 * penalty is biting, it is visibly cutting across the seats it hits.
 */
const STORM_TRAVEL = 64;

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
  /** 0 while the table is fighting, 1 once the stall penalty is biting. */
  intensity: number;
}

/**
 * The arena wall, which closes in as the table stalls. `pressure` is how far
 * the stall penalty has come: 0 while blows are landing, 1 once it bites.
 */
export function stormRing(width: number, height: number, pressure: number): StormRing {
  const intensity = Math.min(1, Math.max(0, pressure));
  return {
    centre: centreOf(width, height),
    radius: Math.min(width, height) / 2 - STORM_INSET - intensity * STORM_TRAVEL,
    intensity,
  };
}
