import type { Address, PublicClient } from 'viem';
import { addressKey } from '@lms/consensus';
import { playerAvatarsAbi } from '@lms/contracts';
import { errorMessage, type AvatarEntry } from '@lms/api';
import { readClient } from './viem.js';

/** One `PlayerAvatars` deployment, and the RPC that can be used to read it. */
export interface AvatarCollection {
  chainId: number;
  address: Address;
  rpcUrl: string;
}

export interface AvatarRegistryOptions {
  collections: readonly AvatarCollection[];
  /** Prefix that `ipfs://` is rewritten to. */
  gateway?: string;
  /** How long a resolved avatar is trusted, in milliseconds. */
  ttlMs?: number;
  /** Per-request timeout for the metadata fetch. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** A seat, reduced to what deciding its avatar actually needs. */
export interface AvatarSubject {
  index: number;
  address: Address;
  chainId: number;
}

interface CacheEntry {
  expires: number;
  value: Omit<AvatarEntry, 'seat'> | null;
}

const DEFAULT_GATEWAY = 'https://ipfs.io/ipfs/';
const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 4_000;

/**
 * Resolves the avatar a seat is wearing.
 *
 * Avatars are minted per chain, so this holds one RPC client per configured
 * collection and asks the one matching the chain a seat staked from. A seat on
 * a chain with no configured collection simply has no avatar.
 *
 * Every failure path is soft. An avatar is cosmetic, so a dead RPC, an
 * unreachable IPFS gateway, malformed metadata or a slow response all resolve
 * to "no avatar" rather than to an error: a match must never wait on, or be
 * blocked by, a picture. Results are cached per wallet — including the misses,
 * which are the expensive ones — because a match asks for the same seats
 * repeatedly and an avatar changes about as often as a profile picture.
 */
export class AvatarRegistry {
  private readonly clients = new Map<number, { client: PublicClient; address: Address }>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly gateway: string;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: AvatarRegistryOptions) {
    this.gateway = options.gateway ?? DEFAULT_GATEWAY;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;

    for (const collection of options.collections) {
      this.clients.set(collection.chainId, {
        address: collection.address,
        client: readClient(collection.chainId, collection.rpcUrl),
      });
    }
  }

  get chains(): number[] {
    return [...this.clients.keys()];
  }

  /** True when no collection is configured, so callers can skip the work entirely. */
  get empty(): boolean {
    return this.clients.size === 0;
  }

  /**
   * Resolves every seat that has an avatar, dropping the rest.
   *
   * Seats are resolved concurrently: they are independent reads, often against
   * different chains, and doing them in sequence would make the wait the sum of
   * every RPC rather than the slowest one.
   */
  async resolve(subjects: readonly AvatarSubject[]): Promise<AvatarEntry[]> {
    if (this.empty) return [];

    const settled = await Promise.all(
      subjects.map(async (subject) => {
        const value = await this.resolveOne(subject);
        return value === null ? null : { seat: subject.index, ...value };
      }),
    );

    return settled.filter((entry): entry is AvatarEntry => entry !== null);
  }

  private async resolveOne(subject: AvatarSubject): Promise<Omit<AvatarEntry, 'seat'> | null> {
    const collection = this.clients.get(subject.chainId);
    if (!collection) return null;

    const key = `${subject.chainId}:${addressKey(subject.address)}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return cached.value;

    const value = await this.read(collection, subject.chainId, subject.address);
    this.cache.set(key, { value, expires: this.now() + this.ttlMs });
    return value;
  }

  private async read(
    collection: { client: PublicClient; address: Address },
    chainId: number,
    player: Address,
  ): Promise<Omit<AvatarEntry, 'seat'> | null> {
    try {
      const [tokenId, uri] = await collection.client.readContract({
        address: collection.address,
        abi: playerAvatarsAbi,
        functionName: 'avatarOf',
        args: [player],
      });

      if (tokenId === 0n) return null;

      return {
        tokenId: tokenId.toString(),
        chainId,
        image: await this.imageFor(uri),
      };
    } catch (error) {
      console.warn(`[avatars] read failed for ${player} on ${chainId}:`, errorMessage(error));
      return null;
    }
  }

  /**
   * Follows the token URI to the image the arena will draw.
   *
   * The metadata hop happens here rather than in the browser so there is one
   * gateway policy, one cache and one timeout, instead of every connected
   * client independently hammering a public gateway for the same eight files.
   * A token whose metadata cannot be read still returns its id, so the client
   * can show that the seat owns an avatar it could not fetch.
   */
  private async imageFor(uri: string): Promise<string | null> {
    if (uri.length === 0) return null;

    try {
      const response = await this.fetchImpl(this.toHttp(uri), {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return null;

      const metadata: unknown = await response.json();
      if (typeof metadata !== 'object' || metadata === null) return null;

      const image = (metadata as { image?: unknown }).image;
      return typeof image === 'string' && image.length > 0 ? this.toHttp(image) : null;
    } catch (error) {
      console.warn('[avatars] metadata fetch failed:', errorMessage(error));
      return null;
    }
  }

  private toHttp(uri: string): string {
    return uri.startsWith('ipfs://') ? `${this.gateway}${uri.slice('ipfs://'.length)}` : uri;
  }
}

/**
 * Parses the `AVATAR_COLLECTIONS` env var.
 *
 * Malformed configuration is dropped with a warning rather than crashing the
 * server: avatars are decoration, and a typo in a cosmetic setting should not
 * stop matches from being played or settled.
 */
export function parseCollections(raw: string): AvatarCollection[] {
  if (raw.trim().length === 0) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');

    return parsed.flatMap((item): AvatarCollection[] => {
      const { chainId, address, rpcUrl } = item as Partial<AvatarCollection>;
      if (
        typeof chainId !== 'number' ||
        typeof address !== 'string' ||
        !/^0x[0-9a-fA-F]{40}$/.test(address) ||
        typeof rpcUrl !== 'string' ||
        rpcUrl.length === 0
      ) {
        console.warn('[avatars] ignoring malformed collection:', JSON.stringify(item));
        return [];
      }
      return [{ chainId, address: address as Address, rpcUrl }];
    });
  } catch (error) {
    console.warn('[avatars] AVATAR_COLLECTIONS is not valid JSON:', errorMessage(error));
    return [];
  }
}

