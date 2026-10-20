import type { FxTexture } from '../assets/manifest.js';
import { FX } from './theme.js';

/**
 * What each moment of the replay looks like, as data. `Effects.play` turns a
 * recipe into sprites and tweens; tuning a moment means editing this table,
 * not code.
 */

/** One sprite that grows or shrinks between two widths and fades where a moment happens. */
export interface Puff {
  texture: FxTexture;
  tint: number;
  life: number;
  /** Width in pixels at birth and at death. */
  size: [number, number];
  /** Starting opacity; it always fades to nothing. */
  alpha?: number;
  /** Drifts upward this fast, in pixels per second: smoke and dust. */
  rise?: number;
  /** Radians turned over its life. */
  spin?: number;
  /** Starts at a random angle, so no two scratches look alike. */
  randomTurn?: boolean;
  additive?: boolean;
}

/** A handful of sprites thrown outward: sparks, debris, confetti. */
export interface Spray {
  texture: FxTexture;
  count: number;
  /** One tint, or a palette each sprite picks from. */
  tint: number | number[];
  life: [number, number];
  size: [number, number];
  /** Launch speed range, in pixels per second. */
  speed: [number, number];
  /** Launch directions in degrees, 0 right and 90 down; all the way round by default. */
  angles?: [number, number];
  gravity?: number;
  /** Most radians a piece tumbles, either way, over its life. */
  spin?: number;
  additive?: boolean;
}

export interface Recipe {
  puffs?: Puff[];
  sprays?: Spray[];
  /** World shake: pixels, then jolts. */
  shake?: [number, number];
  /** Full-screen flash: tint, then strength. */
  flash?: [number, number];
}

/** Small glowing sparks: the common case of a spray. */
function sparks(tint: number, count: number, size: number, speed: [number, number]): Spray {
  return { texture: 'glow', count, tint, life: [0.3, 0.4], size: [size, 2], speed, additive: true };
}

export const RECIPES = {
  noShow: {
    puffs: [{ texture: 'puff', tint: FX.noShow, life: 0.7, size: [40, 80], alpha: 0.6, rise: 18 }],
  },
  /** An attacker gathering itself before the blow leaves. */
  charge: {
    puffs: [{ texture: 'glow', tint: FX.hit, life: 0.3, size: [110, 50], alpha: 0.55, additive: true }],
  },
  hit: {
    puffs: [
      { texture: 'flash', tint: FX.hit, life: 0.25, size: [30, 90], additive: true },
      { texture: 'burst', tint: FX.hit, life: 0.35, size: [40, 75], additive: true },
      { texture: 'claw', tint: 0xffffff, life: 0.45, size: [58, 62], randomTurn: true, additive: true },
    ],
    sprays: [sparks(FX.hit, 8, 11, [100, 200])],
    // Smaller than a kill's, so the kill still stands out.
    shake: [3, 3],
  },
  parry: {
    puffs: [
      { texture: 'ring', tint: FX.parry, life: 0.35, size: [60, 110], additive: true },
      { texture: 'flash', tint: FX.parry, life: 0.2, size: [20, 55], additive: true },
      { texture: 'shield', tint: 0xffffff, life: 0.3, size: [70, 100], alpha: 0.8, spin: 2, additive: true },
    ],
    sprays: [sparks(FX.parry, 6, 8, [120, 200])],
  },
  evade: {
    puffs: [{ texture: 'puff', tint: FX.miss, life: 0.55, size: [30, 64], alpha: 0.7, rise: 14 }],
  },
  riposte: {
    puffs: [{ texture: 'flash', tint: FX.parry, life: 0.22, size: [22, 60], additive: true }],
    sprays: [sparks(FX.parry, 4, 8, [70, 130])],
  },
  storm: {
    puffs: [
      { texture: 'bolt', tint: FX.storm, life: 0.35, size: [80, 80], additive: true },
      { texture: 'glow', tint: FX.storm, life: 0.3, size: [40, 70], additive: true },
    ],
  },
  /** The one moment in the replay that is allowed to be loud. */
  eliminate: {
    puffs: [
      { texture: 'blast', tint: FX.kill, life: 0.45, size: [40, 130], additive: true },
      { texture: 'shockwave', tint: FX.kill, life: 0.5, size: [40, 180], alpha: 0.9, additive: true },
      { texture: 'smoke', tint: 0x6b7280, life: 0.9, size: [50, 115], alpha: 0.5, rise: 16 },
    ],
    sprays: [
      {
        texture: 'debris',
        count: 10,
        tint: 0x9a8f82,
        life: [0.6, 0.9],
        size: [24, 6],
        speed: [90, 190],
        gravity: 260,
        spin: 6,
      },
    ],
    shake: [7, 6],
    flash: [FX.kill, 0.2],
  },
  winner: {
    puffs: [{ texture: 'ring', tint: FX.winner, life: 0.8, size: [50, 170], alpha: 0.9, additive: true }],
    sprays: [
      { ...sparks(FX.winner, 16, 12, [70, 180]), life: [0.8, 1] },
      // Confetti: slow, tumbling, falling.
      {
        texture: 'debris',
        count: 36,
        tint: [FX.winner, 0x52d1a4, 0x6fa8f5, 0xe0575b, 0xffffff],
        life: [1.2, 1.9],
        size: [12, 8],
        speed: [160, 340],
        angles: [-160, -20],
        gravity: 320,
        spin: 10,
      },
    ],
    flash: [FX.winner, 0.22],
  },
} satisfies Record<string, Recipe>;
