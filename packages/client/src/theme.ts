import type { TextStyleOptions } from 'pixi.js';

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

const FONT = 'Segoe UI, sans-serif';

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
