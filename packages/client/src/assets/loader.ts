import { Assets, type Texture } from 'pixi.js';
import { FX_BUNDLE, FX_TEXTURES, manifest, type FxTexture } from './manifest.js';

/** The effect textures that loaded. A missing one is simply absent. */
export type FxTextures = Partial<Record<FxTexture, Texture>>;

let loading: Promise<FxTextures> | null = null;

/**
 * Loads every bundled asset, once.
 *
 * Started at boot behind the loading screen, so that by the time a match opens
 * and the arena mounts, its textures are already in Pixi's cache. Later calls —
 * the arena's — share the same promise instead of loading again.
 *
 * Never rejects. Pixi's `skip` strategy drops a file that fails rather than
 * failing the whole bundle, and the effects layer draws a generated glow in
 * place of anything missing: the match never depends on a picture.
 */
export function loadAssets(onProgress?: (fraction: number) => void): Promise<FxTextures> {
  loading ??= load(onProgress ?? (() => {}));
  return loading;
}

async function load(onProgress: (fraction: number) => void): Promise<FxTextures> {
  try {
    await Assets.init({
      basePath: import.meta.env.BASE_URL,
      manifest,
      loadOptions: {
        strategy: 'skip',
        onError: (error, asset) => {
          const url = typeof asset === 'string' ? asset : asset.src;
          console.warn(`[assets] skipped ${String(url)}: ${error.message}`);
        },
      },
    });

    const loaded: Record<string, Texture | undefined> = await Assets.loadBundle(FX_BUNDLE, onProgress);
    const textures: FxTextures = {};
    for (const name of FX_TEXTURES) {
      const texture = loaded[name];
      if (texture) textures[name] = texture;
    }
    return textures;
  } catch (error) {
    console.warn('[assets] loading failed, continuing without textures', error);
    return {};
  } finally {
    onProgress(1);
  }
}
