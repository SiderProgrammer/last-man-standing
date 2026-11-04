/**
 * What to ask Pixi for to load a face. Pixi picks a parser from the URL's
 * extension or data URI type, and has none for a URL it cannot read one from,
 * such as `https://gateway/ipfs/<cid>`, the usual way to name an NFT's image.
 * Those are loaded as images. A generated face is an SVG data URI, which the
 * image parser cannot decode, so anything Pixi can tell is an SVG stays with it.
 */
export function faceSource(url: string): string | { src: string; parser: 'texture' } {
  return /^data:|\.svg($|[?#])/i.test(url) ? url : { src: url, parser: 'texture' };
}

/**
 * Textures loaded by URL and shared, freed when the last user lets go.
 *
 * Seat faces are loaded per wallet — a generated face as a data URI, or an
 * NFT image — and Pixi's cache keeps every one it ever loaded. Over an
 * evening of matches that is a texture per opponent ever met. A seat takes a
 * lease on its face and hands it back when it is destroyed; the texture is
 * unloaded once no seat holds it, and loaded again if a later match needs it.
 *
 * Counted rather than unloaded outright because faces outlive seats: the
 * same wallet sits in the next match while the last one's seats are being
 * torn down, and a seat can be destroyed while its face is still loading.
 */
export class TextureLeases<T> {
  private readonly held = new Map<string, number>();
  /** Unloads still running, which a new lease on the same URL waits out. */
  private readonly unloading = new Map<string, Promise<void>>();

  constructor(
    private readonly load: (url: string) => Promise<T | null | undefined>,
    private readonly unload: (url: string) => Promise<void> | void,
  ) {}

  /**
   * Loads `url`, or shares it if it is already held. Pair every call with
   * `release`, even one that throws.
   *
   * Throws if the load comes back empty: the asset loader's `skip` strategy
   * reports a failed load by resolving with nothing, not by rejecting.
   */
  async acquire(url: string): Promise<T> {
    this.held.set(url, (this.held.get(url) ?? 0) + 1);
    await this.unloading.get(url);
    const loaded = await this.load(url);
    if (loaded === null || loaded === undefined) throw new Error(`could not load ${url}`);
    return loaded;
  }

  release(url: string): void {
    const count = (this.held.get(url) ?? 0) - 1;
    if (count > 0) {
      this.held.set(url, count);
      return;
    }
    this.held.delete(url);
    const done: Promise<void> = Promise.resolve()
      .then(() => this.unload(url))
      .catch(() => {
        // Never loaded (a failed load) or already gone: nothing to free.
      })
      .finally(() => {
        if (this.unloading.get(url) === done) this.unloading.delete(url);
      });
    this.unloading.set(url, done);
  }

  /** How many URLs are held now. */
  get size(): number {
    return this.held.size;
  }
}
