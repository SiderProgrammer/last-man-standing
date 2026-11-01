import { describe, expect, it, vi } from 'vitest';
import { getAddress, type Address } from 'viem';
import { JoinFailure } from '@lms/contracts';
import { type CrossChainEvent } from '@lms/api';
import { CrossChainWatcher, parseSpokes, type CrossChainLog, type CrossChainPort } from '@lms/server';

const HUB = 31337;
const SPOKE = 31338;
const PLAYER: Address = getAddress(`0x${'aa'.repeat(20)}`);
const MATCH = `0x${'cd'.repeat(32)}` as const;
const ROUTER = `0x${'ef'.repeat(20)}` as const;
const STAKE = 10n ** 16n;

/** A hub whose logs are queued per block range. */
class FakeHub implements CrossChainPort {
  head = 100n;
  pending: CrossChainLog[] = [];
  ranges: Array<[bigint, bigint]> = [];

  async blockNumber() {
    return this.head;
  }

  async logs(from: bigint, to: bigint) {
    this.ranges.push([from, to]);
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

function watcher(hub: FakeHub) {
  const told: Array<[Address, CrossChainEvent]> = [];
  const w = new CrossChainWatcher({
    port: hub,
    hubChainId: HUB,
    notify: (player, event) => told.push([player, event]),
  });
  return { w, told };
}

describe('CrossChainWatcher', () => {
  it('tells a spoke player their stake took a seat', async () => {
    const hub = new FakeHub();
    hub.pending = [{ kind: 'joined', matchId: MATCH, player: PLAYER, originChainId: SPOKE }];
    const { w, told } = watcher(hub);
    await w.tick();
    expect(told).toEqual([[PLAYER, { kind: 'seated', matchId: MATCH, chainId: SPOKE }]]);
  });

  it('stays quiet about joins made on the hub itself', async () => {
    const hub = new FakeHub();
    hub.pending = [{ kind: 'joined', matchId: MATCH, player: PLAYER, originChainId: 0 }];
    const { w, told } = watcher(hub);
    await w.tick();
    expect(told).toEqual([]);
  });

  it('reports a refund with its reason and amount', async () => {
    const hub = new FakeHub();
    hub.pending = [
      { kind: 'refunded', matchId: MATCH, player: PLAYER, amount: STAKE, reason: JoinFailure.LobbyFull },
    ];
    const { w, told } = watcher(hub);
    await w.tick();
    expect(told).toEqual([
      [PLAYER, { kind: 'refunded', matchId: MATCH, amount: STAKE.toString(), reason: JoinFailure.LobbyFull }],
    ]);
  });

  it('reads each block once, starting a short way behind the head', async () => {
    const hub = new FakeHub();
    hub.head = 10_000n;
    const { w } = watcher(hub);
    await w.tick();
    hub.head = 10_005n;
    await w.tick();
    expect(hub.ranges).toEqual([
      [5_000n, 10_000n],
      [10_001n, 10_005n],
    ]);
  });

  it('does not overlap ticks', async () => {
    const hub = new FakeHub();
    const logs = vi.spyOn(hub, 'logs');
    const { w } = watcher(hub);
    await Promise.all([w.tick(), w.tick()]);
    expect(logs).toHaveBeenCalledTimes(1);
  });
});

describe('parseSpokes', () => {
  it('reads one SpokeRouter per chain', () => {
    expect(parseSpokes(JSON.stringify([{ chainId: SPOKE, router: ROUTER }]), HUB)).toEqual([
      { chainId: SPOKE, router: ROUTER },
    ]);
  });

  it('is empty when unset', () => {
    expect(parseSpokes('', HUB)).toEqual([]);
  });

  it('drops malformed entries, the hub itself, and a second entry for one chain', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify([
      { chainId: SPOKE, router: ROUTER },
      { chainId: SPOKE, router: `0x${'01'.repeat(20)}` },
      { chainId: HUB, router: ROUTER },
      { chainId: 8453, router: 'nope' },
      { chainId: -1, router: ROUTER },
    ]);
    expect(parseSpokes(raw, HUB)).toEqual([{ chainId: SPOKE, router: ROUTER }]);
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });

  it('survives invalid JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseSpokes('{', HUB)).toEqual([]);
    warn.mockRestore();
  });
});
