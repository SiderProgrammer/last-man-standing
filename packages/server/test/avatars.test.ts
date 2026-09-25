import { describe, expect, it, vi } from 'vitest';
import { AvatarRegistry, parseCollections, type AvatarSubject } from '../src/chain/avatars.js';

const COLLECTION = '0x00000000000000000000000000000000000000aa' as const;
const ALICE = '0x00000000000000000000000000000000000000a1' as const;
const BOB = '0x00000000000000000000000000000000000000b2' as const;

const HUB = 11155111;
const SPOKE = 84532;

/**
 * Builds a registry whose chain reads are stubbed.
 *
 * `readContract` is replaced rather than mocking viem wholesale: the point of
 * these tests is what the registry does with the answers, including the ones
 * that are failures.
 */
function registry(options: {
  reads: Record<number, (player: string) => Promise<readonly [bigint, string]>>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
}): AvatarRegistry {
  const instance = new AvatarRegistry({
    collections: [
      { chainId: HUB, address: COLLECTION, rpcUrl: 'http://127.0.0.1:1' },
      { chainId: SPOKE, address: COLLECTION, rpcUrl: 'http://127.0.0.1:2' },
    ],
    gateway: 'https://gateway.test/ipfs/',
    fetchImpl: options.fetchImpl ?? notCalled,
    ...(options.now ? { now: options.now } : {}),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  });

  const clients = (instance as unknown as { clients: Map<number, { client: { readContract: unknown } }> })
    .clients;
  for (const [chainId, entry] of clients) {
    const read = options.reads[chainId];
    entry.client.readContract = (args: { args: readonly [string] }) =>
      read ? read(args.args[0]) : Promise.reject(new Error('no stub'));
  }
  return instance;
}

const notCalled: typeof fetch = () => {
  throw new Error('fetch should not have been called');
};

function jsonFetch(body: unknown, ok = true): typeof fetch {
  return (() =>
    Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response)) as typeof fetch;
}

const seats: AvatarSubject[] = [
  { index: 0, address: ALICE, chainId: HUB },
  { index: 1, address: BOB, chainId: SPOKE },
];

describe('AvatarRegistry', () => {
  it('reads each seat against the collection on the chain it staked from', async () => {
    const instance = registry({
      reads: {
        [HUB]: () => Promise.resolve([1n, 'ipfs://cid/1'] as const),
        [SPOKE]: () => Promise.resolve([7n, 'ipfs://cid/7'] as const),
      },
      fetchImpl: jsonFetch({ image: 'ipfs://img/one.png' }),
    });

    const entries = await instance.resolve(seats);

    expect(entries).toEqual([
      { seat: 0, tokenId: '1', chainId: HUB, image: 'https://gateway.test/ipfs/img/one.png' },
      { seat: 1, tokenId: '7', chainId: SPOKE, image: 'https://gateway.test/ipfs/img/one.png' },
    ]);
  });

  it('rewrites ipfs metadata and image URLs through the gateway', async () => {
    const fetchImpl = vi.fn(jsonFetch({ image: 'ipfs://img/two.png' }));
    const instance = registry({
      reads: { [HUB]: () => Promise.resolve([2n, 'ipfs://cid/2'] as const) },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [entry] = await instance.resolve([seats[0] as AvatarSubject]);

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://gateway.test/ipfs/cid/2');
    expect(entry?.image).toBe('https://gateway.test/ipfs/img/two.png');
  });

  it('leaves an http token URI alone', async () => {
    const fetchImpl = vi.fn(jsonFetch({ image: 'https://cdn.test/three.png' }));
    const instance = registry({
      reads: { [HUB]: () => Promise.resolve([3n, 'https://api.test/3'] as const) },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [entry] = await instance.resolve([seats[0] as AvatarSubject]);

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.test/3');
    expect(entry?.image).toBe('https://cdn.test/three.png');
  });

  it('drops a seat that owns no avatar', async () => {
    const instance = registry({
      reads: { [HUB]: () => Promise.resolve([0n, ''] as const) },
    });

    expect(await instance.resolve([seats[0] as AvatarSubject])).toEqual([]);
  });

  it('drops a seat on a chain with no configured collection', async () => {
    const instance = registry({ reads: {} });

    expect(await instance.resolve([{ index: 0, address: ALICE, chainId: 999 }])).toEqual([]);
  });

  /**
   * The whole reason every failure path is soft: a match must not depend on a
   * picture. A dead RPC costs the seat its avatar and nothing else.
   */
  it('survives a failing chain read', async () => {
    const instance = registry({
      reads: {
        [HUB]: () => Promise.reject(new Error('rpc down')),
        [SPOKE]: () => Promise.resolve([7n, 'ipfs://cid/7'] as const),
      },
      fetchImpl: jsonFetch({ image: 'ipfs://img/seven.png' }),
    });

    const entries = await instance.resolve(seats);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.seat).toBe(1);
  });

  it('keeps the token id when the metadata cannot be fetched', async () => {
    const instance = registry({
      reads: { [HUB]: () => Promise.resolve([4n, 'ipfs://cid/4'] as const) },
      fetchImpl: (() => Promise.reject(new Error('gateway timeout'))) as typeof fetch,
    });

    const [entry] = await instance.resolve([seats[0] as AvatarSubject]);

    expect(entry).toEqual({ seat: 0, tokenId: '4', chainId: HUB, image: null });
  });

  it('keeps the token id when the metadata has no image', async () => {
    const instance = registry({
      reads: { [HUB]: () => Promise.resolve([5n, 'ipfs://cid/5'] as const) },
      fetchImpl: jsonFetch({ name: 'no image here' }),
    });

    const [entry] = await instance.resolve([seats[0] as AvatarSubject]);

    expect(entry?.image).toBeNull();
  });

  it('keeps the token id when the gateway answers with an error status', async () => {
    const instance = registry({
      reads: { [HUB]: () => Promise.resolve([6n, 'ipfs://cid/6'] as const) },
      fetchImpl: jsonFetch({ image: 'ipfs://img/six.png' }, false),
    });

    const [entry] = await instance.resolve([seats[0] as AvatarSubject]);

    expect(entry?.image).toBeNull();
  });

  it('caches per wallet, including the misses', async () => {
    const read = vi.fn(() => Promise.resolve([1n, 'ipfs://cid/1'] as const));
    const miss = vi.fn(() => Promise.resolve([0n, ''] as const));
    const instance = registry({
      reads: { [HUB]: read, [SPOKE]: miss },
      fetchImpl: jsonFetch({ image: 'ipfs://img/one.png' }),
    });

    await instance.resolve(seats);
    await instance.resolve(seats);
    await instance.resolve(seats);

    expect(read).toHaveBeenCalledTimes(1);
    expect(miss).toHaveBeenCalledTimes(1);
  });

  it('re-reads once the cached entry expires', async () => {
    let clock = 0;
    const read = vi.fn(() => Promise.resolve([1n, 'ipfs://cid/1'] as const));
    const instance = registry({
      reads: { [HUB]: read },
      fetchImpl: jsonFetch({ image: 'ipfs://img/one.png' }),
      now: () => clock,
      ttlMs: 1_000,
    });

    await instance.resolve([seats[0] as AvatarSubject]);
    clock = 999;
    await instance.resolve([seats[0] as AvatarSubject]);
    expect(read).toHaveBeenCalledTimes(1);

    clock = 1_001;
    await instance.resolve([seats[0] as AvatarSubject]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does no work at all when nothing is configured', async () => {
    const instance = new AvatarRegistry({ collections: [] });

    expect(instance.empty).toBe(true);
    expect(await instance.resolve(seats)).toEqual([]);
  });
});

describe('parseCollections', () => {
  it('parses a well-formed list', () => {
    const raw = `[{"chainId":${HUB},"address":"${COLLECTION}","rpcUrl":"https://rpc.test"}]`;

    expect(parseCollections(raw)).toEqual([
      { chainId: HUB, address: COLLECTION, rpcUrl: 'https://rpc.test' },
    ]);
  });

  it('treats an empty value as no collections', () => {
    expect(parseCollections('')).toEqual([]);
    expect(parseCollections('   ')).toEqual([]);
  });

  /**
   * A typo in a cosmetic setting must not stop matches being played, so bad
   * configuration degrades to "no avatars" instead of crashing the boot.
   */
  it('drops malformed entries and keeps the good ones', () => {
    const raw = JSON.stringify([
      { chainId: HUB, address: 'not-an-address', rpcUrl: 'https://rpc.test' },
      { chainId: 'eight', address: COLLECTION, rpcUrl: 'https://rpc.test' },
      { chainId: SPOKE, address: COLLECTION },
      { chainId: SPOKE, address: COLLECTION, rpcUrl: 'https://rpc.test' },
    ]);

    expect(parseCollections(raw)).toEqual([
      { chainId: SPOKE, address: COLLECTION, rpcUrl: 'https://rpc.test' },
    ]);
  });

  it('survives invalid JSON and a non-array', () => {
    expect(parseCollections('{not json')).toEqual([]);
    expect(parseCollections('{"chainId":1}')).toEqual([]);
  });
});
