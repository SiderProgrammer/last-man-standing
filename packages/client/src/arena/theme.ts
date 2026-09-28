import type { TextStyleOptions } from 'pixi.js';

const FONT = 'Segoe UI, sans-serif';

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
} as const;

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
  textStroke: 0x05070c,
} as const;

export const FLOAT: TextStyleOptions = {
  fill: COLORS.text,
  fontFamily: FONT,
  fontSize: 16,
  fontWeight: '700',
  stroke: { color: FX.textStroke, width: 4 },
};

export const BANNER: TextStyleOptions = {
  fill: FX.winner,
  fontFamily: FONT,
  fontSize: 13,
  fontWeight: '700',
  letterSpacing: 1.5,
  stroke: { color: FX.textStroke, width: 4 },
};

export const LABEL: TextStyleOptions = { fill: COLORS.text, fontFamily: FONT, fontSize: 14 };
export const SUBLABEL: TextStyleOptions = { fill: COLORS.muted, fontFamily: FONT, fontSize: 11 };
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
