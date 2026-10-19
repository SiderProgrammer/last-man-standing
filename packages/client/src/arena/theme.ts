import type { TextStyleOptions } from 'pixi.js';

const FONT = 'Segoe UI, system-ui, sans-serif';

/**
 * The arena's palette and type, as Pixi wants them.
 *
 * Colours are `0xRRGGBB` numbers rather than CSS strings because that is what
 * Pixi's `Graphics` takes. They intentionally mirror `styles.css`; the two are
 * separate because nothing in the canvas can read a CSS custom property.
 */
export const COLORS = {
  background: 0x070a10,
  seat: 0x1b2331,
  seatDead: 0x11151d,
  outline: 0x2b3547,
  you: 0x52d1a4,
  hp: 0x52d1a4,
  hpLow: 0xe6b455,
  hpCritical: 0xe0575b,
  text: 0xdbe3f0,
  muted: 0x8794ab,
  attack: 0xe0575b,
  parried: 0x6fa8f5,
  missed: 0x5a6579,
  storm: 0x3a2d4a,
  /** The arena floor: lit in the middle, falling off to the walls. */
  floorCentre: 0x131b2a,
  floorEdge: 0x05070b,
  /** Faint lines etched into the floor. */
  floorLine: 0x1d2737,
  /** The fog the storm drags in from the walls. */
  stormFog: 0x6b4fc8,
  stormEdge: 0x9d84ff,
  /** The commit-phase aim: your reticle and the line to it. */
  aim: 0xff6b6e,
} as const;

const FX_STROKE = 0x05070c;

/**
 * Tints for the round replay. The textures are white with the shape in alpha,
 * so each of these comes out exactly as written. Hit, parry and miss reuse the
 * arena's existing outcome colours so the replay reads the same as the history
 * feed does.
 */
export const FX = {
  projectile: COLORS.attack,
  hit: COLORS.attack,
  parry: COLORS.parried,
  miss: 0xaab4c6,
  storm: 0xb49cff,
  kill: 0xf5a34b,
  noShow: COLORS.muted,
  winner: 0xf5d06f,
  /** Dark outline behind floating numbers, so they read over any avatar. */
  textStroke: FX_STROKE,
} as const;

export const FLOAT: TextStyleOptions = {
  fill: COLORS.text,
  fontFamily: FONT,
  fontSize: 18,
  fontWeight: '800',
  stroke: { color: FX.textStroke, width: 5 },
};

export const BANNER: TextStyleOptions = {
  fill: FX.winner,
  fontFamily: FONT,
  fontSize: 15,
  fontWeight: '800',
  letterSpacing: 2.5,
  stroke: { color: FX.textStroke, width: 5 },
};

export const LABEL: TextStyleOptions = {
  fill: COLORS.text,
  fontFamily: FONT,
  fontSize: 13,
  fontWeight: '700',
  letterSpacing: 0.4,
};
export const SUBLABEL: TextStyleOptions = { fill: COLORS.muted, fontFamily: FONT, fontSize: 11 };
/** The HP number on a seat's nameplate. */
export const HP_LABEL: TextStyleOptions = {
  fill: COLORS.hp,
  fontFamily: FONT,
  fontSize: 12,
  fontWeight: '700',
};
/** The big round title that sweeps across the floor as a replay starts. */
export const TITLE: TextStyleOptions = {
  fill: COLORS.text,
  fontFamily: FONT,
  fontSize: 44,
  fontWeight: '800',
  letterSpacing: 8,
  stroke: { color: FX_STROKE, width: 6 },
};
/** The arena's corner readout: round number and the storm's next bite. */
export const HUD: TextStyleOptions = {
  fill: COLORS.muted,
  fontFamily: FONT,
  fontSize: 11,
  fontWeight: '700',
  letterSpacing: 2,
};
export const HUD_VALUE: TextStyleOptions = {
  fill: COLORS.text,
  fontFamily: FONT,
  fontSize: 22,
  fontWeight: '800',
  letterSpacing: 1,
};
export const BADGE: TextStyleOptions = {
  fill: COLORS.text,
  fontFamily: FONT,
  fontSize: 10,
  letterSpacing: 0.6,
};

/** HP colour for a fraction of full health. */
export function hpColor(fraction: number): number {
  return fraction > 0.5 ? COLORS.hp : fraction > 0.25 ? COLORS.hpLow : COLORS.hpCritical;
}
