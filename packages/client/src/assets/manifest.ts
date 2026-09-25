import type { AssetsManifest } from 'pixi.js';

/**
 * Every asset the client ships, in Pixi's manifest format.
 *
 * The replay's effect textures are the Kenney CC0 set in `public/fx/`, white
 * with the shape in alpha so they can be tinted. Avatars are not listed: their
 * URLs come from the chain at match time, so they load on demand instead.
 */
export const FX_TEXTURES = [
  'glow',
  'streak',
  'flash',
  'burst',
  'claw',
  'shield',
  'ring',
  'puff',
  'blast',
  'debris',
  'shockwave',
  'smoke',
  'bolt',
  'flare',
] as const;

export type FxTexture = (typeof FX_TEXTURES)[number];

export const FX_BUNDLE = 'fx';

export const manifest: AssetsManifest = {
  bundles: [
    {
      name: FX_BUNDLE,
      assets: FX_TEXTURES.map((name) => ({ alias: name, src: `fx/${name}.png` })),
    },
  ],
};
