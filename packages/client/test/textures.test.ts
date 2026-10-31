import { describe, expect, it } from 'vitest';
import { TextureLeases } from '../src/arena/textures.js';

/** A cache that records what it was asked, like Pixi's `Assets`. */
function fakeAssets() {
  const loads: string[] = [];
  const unloads: string[] = [];
  const cached = new Set<string>();
  let release: (() => void) | null = null;
  return {
    loads,
    unloads,
    cached,
    /** Holds the next unload until `finishUnload`. */
    holdUnload: false,
    finishUnload: () => release?.(),
    leases: null as unknown as TextureLeases<string>,
    init() {
      this.leases = new TextureLeases<string>(
        async (url) => {
          loads.push(url);
          cached.add(url);
          return `texture:${url}`;
        },
        async (url) => {
          if (this.holdUnload) await new Promise<void>((resolve) => (release = resolve));
          unloads.push(url);
          cached.delete(url);
        },
      );
      return this;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('texture leases', () => {
  it('unloads a face once the last seat wearing it lets go', async () => {
    const assets = fakeAssets().init();
    await assets.leases.acquire('alice');
    await assets.leases.acquire('alice');

    assets.leases.release('alice');
    await flush();
    expect(assets.unloads).toEqual([]);

    assets.leases.release('alice');
    await flush();
    expect(assets.unloads).toEqual(['alice']);
    expect(assets.leases.size).toBe(0);
  });

  /** The next match seats the same wallet while the last one's unload is still running. */
  it('waits out an unload in flight before loading the same face again', async () => {
    const assets = fakeAssets().init();
    await assets.leases.acquire('alice');
    assets.holdUnload = true;
    assets.leases.release('alice');

    const again = assets.leases.acquire('alice');
    await flush();
    expect(assets.loads).toEqual(['alice']);

    assets.finishUnload();
    await expect(again).resolves.toBe('texture:alice');
    expect(assets.loads).toEqual(['alice', 'alice']);
    expect(assets.cached.has('alice')).toBe(true);
  });

  it('keeps faces other seats still wear', async () => {
    const assets = fakeAssets().init();
    await assets.leases.acquire('alice');
    await assets.leases.acquire('bob');

    assets.leases.release('alice');
    await flush();
    expect([...assets.cached]).toEqual(['bob']);
    expect(assets.leases.size).toBe(1);
  });

  it('survives an unload that fails, as for a face that never loaded', async () => {
    const leases = new TextureLeases<string>(
      async () => {
        throw new Error('404');
      },
      async () => {
        throw new Error('not in the cache');
      },
    );
    await expect(leases.acquire('gone')).rejects.toThrow('404');
    leases.release('gone');
    await flush();
    expect(leases.size).toBe(0);
  });
});
