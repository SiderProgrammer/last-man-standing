import type { AssetsManifest } from 'pixi.js';

/**
 * Every asset the client ships, in Pixi's manifest format.
 *
 * The replay's effect textures are the images in `packages/client/fx/`: the
 * Kenney CC0 set, white with the shape in alpha so they can be tinted. The
 * folder is scanned when the client is built, so an image dropped in it is
 * loaded without changing any code, under its file name without the extension.
 * Avatars are not here: their URLs come from the chain at match time, so they
 * load on demand instead.
 *
 * `no-inline` keeps Vite from turning the smallest ones into data URIs, so
 * every texture is a file of its own, in development and in a build alike.
 */
const FX_FILES = import.meta.glob<string>('../../fx/*.{png,jpg,jpeg,webp,avif,svg}', {
  eager: true,
  query: '?url&no-inline',
  import: 'default',
});

export const FX_BUNDLE = 'fx';

/** `../../fx/glow.png` is `glow`. */
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1, path.lastIndexOf('.'));

const FX_ASSETS = Object.entries(FX_FILES).map(([path, src]) => ({ alias: nameOf(path), src }));

/** The name of every texture found in the folder. */
export const FX_NAMES: readonly string[] = FX_ASSETS.map(({ alias }) => alias);

export const manifest: AssetsManifest = {
  bundles: [{ name: FX_BUNDLE, assets: FX_ASSETS }],
};
