import { describe, expect, it } from 'vitest';
import { minOutFor } from '@lms/protocol';
import {
  DEFAULT_FEE_KEEPER_POLICY,
  FeeKeeper,
  feeKeeperPolicy,
  loadConfig,
  type FeeKeeperPolicy,
  type FeeRouterPort,
} from '@lms/server';

const ETH = 10n ** 18n;
const NOW = 1_700_000_000n;

/** A router whose pool trades at `rate` LMS per ETH, recording what it was asked to do. */
class FakeRouter implements FeeRouterPort {
  creditedWei = 0n;
  pending = 0n;
  rate = 100_000n;
  shareTotal = 10_000n * ETH;
  shareLocked = ETH;
  quoteFails = false;
  buybackFails = false;

  readonly harvests: number[] = [];
  readonly buybacks: Array<{ amountIn: bigint; minLmsOut: bigint; deadline: bigint }> = [];
  readonly quotes: bigint[] = [];

  async credited() {
    return this.creditedWei;
  }

  async pendingBuyback() {
    return this.pending;
  }

  async shares() {
    return { total: this.shareTotal, locked: this.shareLocked };
  }

  async quote(amountIn: bigint) {
    this.quotes.push(amountIn);
    if (this.quoteFails) throw new Error('PoolNotInitialized');
    return amountIn * this.rate;
  }

  async harvest() {
    this.harvests.push(1);
    this.pending += this.creditedWei / 2n;
    this.creditedWei = 0n;
  }

  async buyback(amountIn: bigint, minLmsOut: bigint, deadline: bigint) {
    if (this.buybackFails) throw new Error('SlippageExceeded');
    this.buybacks.push({ amountIn, minLmsOut, deadline });
    this.pending -= amountIn;
  }
}

const POLICY: FeeKeeperPolicy = {
  minHarvest: ETH / 10n,
  minBuyback: ETH / 10n,
  maxBuyback: ETH,
  slippageBps: 100,
  maxDeviationBps: 500,
  referenceWeightBps: 2_000,
  maxLockedShareBps: 100,
};

function keeper(router: FakeRouter, policy: FeeKeeperPolicy = POLICY): FeeKeeper {
  return new FeeKeeper(router, policy, () => NOW);
}

describe('FeeKeeper', () => {
  it('does nothing below the thresholds', async () => {
    const router = new FakeRouter();
    router.creditedWei = ETH / 20n;
    router.pending = ETH / 20n;

    const tick = await keeper(router).tick();

    expect(tick).toEqual({ harvested: null, buyback: { kind: 'none' } });
    expect(router.harvests).toHaveLength(0);
    expect(router.quotes).toHaveLength(0);
  });

  it('harvests, then buys back in the same tick with a slippage floor and deadline', async () => {
    const router = new FakeRouter();
    router.creditedWei = ETH;

    const tick = await keeper(router).tick();

    expect(tick?.harvested).toBe(ETH);
    expect(router.buybacks).toEqual([
      { amountIn: ETH / 2n, minLmsOut: minOutFor((ETH / 2n) * 100_000n, 100), deadline: NOW + 300n },
    ]);
    expect(tick?.buyback.kind).toBe('bought');
  });

  it('caps each buyback at maxBuyback, so a backlog is bought in steps', async () => {
    const router = new FakeRouter();
    router.pending = 3n * ETH + ETH / 2n;
    const k = keeper(router);

    for (let i = 0; i < 4; i++) await k.tick();

    expect(router.buybacks.map((b) => b.amountIn)).toEqual([ETH, ETH, ETH, ETH / 2n]);
    expect(router.pending).toBe(0n);
  });

  it('declines a quote far below the reference, then resumes once the price settles', async () => {
    const router = new FakeRouter();
    router.pending = 10n * ETH;
    const k = keeper(router);

    await k.tick(); // sets the reference at 100k LMS per ETH
    router.rate = 80_000n; // a 20% worse price: a pushed pool, or a real move

    const declined = await k.tick();
    expect(declined?.buyback).toMatchObject({ kind: 'declined', amountIn: ETH });
    expect(router.buybacks).toHaveLength(1);

    // The average follows a lasting move, and buying resumes.
    let resumed = false;
    for (let i = 0; i < 10 && !resumed; i++) {
      resumed = (await k.tick())?.buyback.kind === 'bought';
    }
    expect(resumed).toBe(true);
    expect(k.referencePrice).toBeLessThan(100_000n * ETH);
  });

  it('buys at a better price without hesitation', async () => {
    const router = new FakeRouter();
    router.pending = 2n * ETH;
    const k = keeper(router);

    await k.tick();
    router.rate = 200_000n; // LMS got cheaper

    expect((await k.tick())?.buyback.kind).toBe('bought');
  });

  it('waits for stakers rather than buying LMS for the locked seed alone', async () => {
    const router = new FakeRouter();
    router.pending = ETH;
    router.shareTotal = ETH; // only the deploy seed
    router.shareLocked = ETH;
    const k = keeper(router);

    expect((await k.tick())?.buyback).toEqual({ kind: 'no-stakers', lockedShareBps: 10_000 });
    expect(router.quotes).toHaveLength(0);
    expect(router.pending).toBe(ETH);

    // Stakers arrive, but the seed is still 2% of the vault: still waiting.
    router.shareTotal = 50n * ETH;
    expect((await k.tick())?.buyback).toEqual({ kind: 'no-stakers', lockedShareBps: 200 });

    // At 1% or less, buying resumes.
    router.shareTotal = 100n * ETH;
    expect((await k.tick())?.buyback.kind).toBe('bought');
  });

  it('treats an empty vault as having no stakers', async () => {
    const router = new FakeRouter();
    router.pending = ETH;
    router.shareTotal = 0n;
    router.shareLocked = 0n;

    expect((await keeper(router).tick())?.buyback).toEqual({ kind: 'no-stakers', lockedShareBps: 10_000 });
  });

  it('reports a failed quote and leaves the ETH waiting', async () => {
    const router = new FakeRouter();
    router.pending = ETH;
    router.quoteFails = true;

    const tick = await keeper(router).tick();

    expect(tick?.buyback).toEqual({ kind: 'failed', error: 'PoolNotInitialized' });
    expect(router.pending).toBe(ETH);
    expect(router.buybacks).toHaveLength(0);
  });

  it('reports a reverted buyback rather than throwing', async () => {
    const router = new FakeRouter();
    router.pending = ETH;
    router.buybackFails = true;

    expect((await keeper(router).tick())?.buyback).toEqual({ kind: 'failed', error: 'SlippageExceeded' });
  });

  it('never runs two ticks at once', async () => {
    const router = new FakeRouter();
    router.pending = ETH;
    const k = keeper(router);

    const [first, second] = await Promise.all([k.tick(), k.tick()]);

    expect(first?.buyback.kind).toBe('bought');
    expect(second).toBeNull();
    expect(router.buybacks).toHaveLength(1);
  });
});

describe('fee keeper configuration', () => {
  it('is off, with the default policy, on an empty environment', () => {
    const config = loadConfig({});

    expect(config.feeRouter).toBe('0x0000000000000000000000000000000000000000');
    expect(feeKeeperPolicy(config.feeKeeper)).toEqual(DEFAULT_FEE_KEEPER_POLICY);
  });

  it('applies only the overrides that are set', () => {
    const config = loadConfig({ BUYBACK_MAX_WEI: '5', BUYBACK_SLIPPAGE_BPS: '30' });

    expect(feeKeeperPolicy(config.feeKeeper)).toEqual({
      ...DEFAULT_FEE_KEEPER_POLICY,
      maxBuyback: 5n,
      slippageBps: 30,
    });
  });

  it('rejects amounts that are not integers at boot', () => {
    expect(() => loadConfig({ BUYBACK_MIN_WEI: '0.5' })).toThrow();
    expect(() => loadConfig({ BUYBACK_SLIPPAGE_BPS: 'lots' })).toThrow();
  });
});

describe('minOutFor', () => {
  it('rounds down, and admits the quote itself at zero tolerance', () => {
    expect(minOutFor(1_000n, 0)).toBe(1_000n);
    expect(minOutFor(1_000n, 100)).toBe(990n);
    expect(minOutFor(999n, 1)).toBe(998n);
  });

  it('rejects out-of-range tolerances', () => {
    expect(() => minOutFor(1n, -1)).toThrow();
    expect(() => minOutFor(1n, 10_001)).toThrow();
    expect(() => minOutFor(1n, 0.5)).toThrow();
  });
});
