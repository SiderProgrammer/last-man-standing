import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, getAddress, type Address, type Hex } from 'viem';
import { JoinFailure, type CrossChainEvent } from '@lms/protocol';
import {
  CrossChainWatcher,
  decodeJoin,
  parseSpokes,
  type CrossChainLog,
  type CrossChainPort,
  type ParkedDelivery,
} from '@lms/server';

const HUB = 31337;
const SPOKE = 31338;
const PLAYER: Address = getAddress(`0x${'aa'.repeat(20)}`);
const MATCH = `0x${'cd'.repeat(32)}` as const;
const ESCROW = `0x${'ef'.repeat(20)}` as const;
const STAKE = 10n ** 16n;

/** A hub whose logs are queued per block range, and whose retries succeed once `accepting`. */
class FakeHub implements CrossChainPort {
  head = 100n;
  pending: CrossChainLog[] = [];
  accepting = false;
  retried: Hex[] = [];
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

  async retry(delivery: ParkedDelivery) {
    if (!this.accepting) return false;
    this.retried.push(delivery.guid);
    return true;
  }
}

function delivery(guid = `0x${'11'.repeat(32)}` as Hex): ParkedDelivery {
  return {
    guid,
    srcChainId: SPOKE,
    srcApp: `0x${'00'.repeat(12)}${'22'.repeat(20)}`,
    payload: encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }], [MATCH, PLAYER]),
    value: STAKE,
  };
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

  it('tells the player a parked stake is waiting, and retries it once the hub accepts it', async () => {
    const hub = new FakeHub();
    hub.pending = [{ kind: 'parked', delivery: delivery() }];
    const { w, told } = watcher(hub);

    await w.tick();
    expect(told).toEqual([[PLAYER, { kind: 'parked', matchId: MATCH, amount: STAKE.toString() }]]);
    expect(w.parked.size).toBe(1);
    expect(hub.retried).toEqual([]);

    // Governance registers the route; the next tick sends the retry.
    hub.accepting = true;
    await w.tick();
    expect(hub.retried).toEqual([delivery().guid]);
    expect(w.parked.size).toBe(0);

    // And never again.
    await w.tick();
    expect(hub.retried).toHaveLength(1);
  });

  it('forgets a delivery someone else retried', async () => {
    const hub = new FakeHub();
    hub.pending = [{ kind: 'parked', delivery: delivery() }];
    const { w } = watcher(hub);
    await w.tick();

    hub.head += 1n;
    hub.pending = [{ kind: 'retried', guid: delivery().guid }];
    hub.accepting = true;
    await w.tick();
    expect(w.parked.size).toBe(0);
    expect(hub.retried).toEqual([]);
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

describe('decodeJoin', () => {
  it('reads the match and player a spoke join carries', () => {
    expect(decodeJoin(delivery().payload)).toEqual({ matchId: MATCH, player: PLAYER });
  });

  it('returns null for anything else', () => {
    expect(decodeJoin('0x1234')).toBeNull();
  });
});

describe('parseSpokes', () => {
  it('reads one SpokeEscrow per chain', () => {
    expect(parseSpokes(JSON.stringify([{ chainId: SPOKE, escrow: ESCROW }]), HUB)).toEqual([
      { chainId: SPOKE, escrow: ESCROW },
    ]);
  });

  it('is empty when unset', () => {
    expect(parseSpokes('', HUB)).toEqual([]);
  });

  it('drops malformed entries, the hub itself, and a second entry for one chain', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify([
      { chainId: SPOKE, escrow: ESCROW },
      { chainId: SPOKE, escrow: `0x${'01'.repeat(20)}` },
      { chainId: HUB, escrow: ESCROW },
      { chainId: 8453, escrow: 'nope' },
      { chainId: -1, escrow: ESCROW },
    ]);
    expect(parseSpokes(raw, HUB)).toEqual([{ chainId: SPOKE, escrow: ESCROW }]);
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });

  it('survives invalid JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseSpokes('{', HUB)).toEqual([]);
    warn.mockRestore();
  });
});
