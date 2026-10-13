import { describe, expect, it } from 'vitest';
import { DEFAULT_FEE_KEEPER_POLICY, FeeKeeper, feeKeeperPolicy, loadConfig, type FeeRouterPort } from '@lms/server';

const ETH = 10n ** 18n;

/** A router that records each harvest. */
class FakeRouter implements FeeRouterPort {
  creditedWei = 0n;
  harvests = 0;
  failNext = false;

  async credited() {
    return this.creditedWei;
  }

  async harvest() {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('NothingToWithdraw');
    }
    this.harvests += 1;
    this.creditedWei = 0n;
  }
}

describe('FeeKeeper', () => {
  it('waits until enough has built up to be worth the gas', async () => {
    const router = new FakeRouter();
    router.creditedWei = ETH / 100n;

    expect(await new FeeKeeper(router, { minHarvest: ETH / 10n }).tick()).toBeNull();
    expect(router.harvests).toBe(0);
  });

  it('harvests once over the threshold', async () => {
    const router = new FakeRouter();
    router.creditedWei = ETH;

    expect(await new FeeKeeper(router, { minHarvest: ETH / 10n }).tick()).toBe(ETH);
    expect(router.harvests).toBe(1);
    expect(router.creditedWei).toBe(0n);
  });

  it('does nothing when nothing is credited, whatever the threshold', async () => {
    const router = new FakeRouter();
    expect(await new FeeKeeper(router, { minHarvest: 0n }).tick()).toBeNull();
    expect(router.harvests).toBe(0);
  });

  it('never runs two ticks at once', async () => {
    const router = new FakeRouter();
    router.creditedWei = ETH;
    const keeper = new FeeKeeper(router, { minHarvest: 1n });

    const [first, second] = await Promise.all([keeper.tick(), keeper.tick()]);

    expect(first).toBe(ETH);
    expect(second).toBeUndefined();
    expect(router.harvests).toBe(1);
  });

  it('surfaces a failed harvest to the caller and recovers on the next tick', async () => {
    const router = new FakeRouter();
    router.creditedWei = ETH;
    router.failNext = true;
    const keeper = new FeeKeeper(router, { minHarvest: 1n });

    await expect(keeper.tick()).rejects.toThrow('NothingToWithdraw');
    expect(await keeper.tick()).toBe(ETH);
  });
});

describe('fee keeper configuration', () => {
  it('is off, with the default policy, on an empty environment', () => {
    const config = loadConfig({});

    expect(config.feeRouter).toBe('0x0000000000000000000000000000000000000000');
    expect(feeKeeperPolicy(config.feeKeeper)).toEqual(DEFAULT_FEE_KEEPER_POLICY);
  });

  it('applies an override, and rejects one that is not an integer', () => {
    expect(feeKeeperPolicy(loadConfig({ HARVEST_MIN_WEI: '5' }).feeKeeper)).toEqual({ minHarvest: 5n });
    expect(() => loadConfig({ HARVEST_MIN_WEI: '0.5' })).toThrow();
  });
});
