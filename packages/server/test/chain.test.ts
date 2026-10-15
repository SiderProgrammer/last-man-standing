import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { MatchStatus } from '@lms/protocol';
import {
  ChainBridge,
  Lobby,
  MemoryArchive,
  nullRelayer,
  type EscrowMatch,
  type EscrowReader,
} from '@lms/server';
import { bytes32 } from './helpers.js';

const HUB = 11155111;
const ARBITRUM_SEPOLIA_EID = 40231;

function seat(n: number): Address {
  return `0x${(n + 0xa0).toString(16).padStart(40, '0')}` as Address;
}

function match(overrides: Partial<EscrowMatch> = {}): EscrowMatch {
  return {
    stake: 1_000n,
    minSeats: 4,
    maxSeats: 4,
    seatCount: 4,
    status: MatchStatus.Open,
    joinDeadline: 9_999_999_999n,
    seed: bytes32('seed'),
    settleDeadline: 0n,
    challengeDeadline: 0n,
    ...overrides,
  };
}

/** Records what the bridge asked for, so the tests can assert on the traffic. */
class FakeEscrow implements EscrowReader {
  block = 10_000n;
  created: `0x${string}`[] = [];
  joins: Array<{ matchId: `0x${string}`; player: Address; originChainId: number }> = [];
  matches = new Map<string, EscrowMatch>();
  seats = new Map<string, Address[]>();
  origins = new Map<string, number>();

  readonly ranges: Array<[bigint, bigint]> = [];
  readonly locked: `0x${string}`[] = [];
  seatOriginReads = 0;
  lockSucceeds = true;
  ranking = new Map<string, Address[]>();
  readonly finalized: Array<[`0x${string}`, readonly Address[]]> = [];

  async blockNumber(): Promise<bigint> {
    return this.block;
  }

  async matchCreatedLogs(from: bigint, to: bigint) {
    this.ranges.push([from, to]);
    return this.created.map((matchId) => ({ matchId }));
  }

  async playerJoinedLogs() {
    return this.joins;
  }

  async getMatch(matchId: `0x${string}`): Promise<EscrowMatch> {
    return this.matches.get(matchId) ?? match();
  }

  async getSeats(matchId: `0x${string}`): Promise<readonly Address[]> {
    return this.seats.get(matchId) ?? [];
  }

  async seatOrigin(_matchId: `0x${string}`, player: Address): Promise<number> {
    this.seatOriginReads += 1;
    return this.origins.get(player.toLowerCase()) ?? 0;
  }

  async lockMatch(matchId: `0x${string}`): Promise<boolean> {
    if (!this.lockSucceeds) return false;
    this.locked.push(matchId);
    return true;
  }

  readonly cancelled: `0x${string}`[] = [];

  async cancelMatch(matchId: `0x${string}`): Promise<boolean> {
    this.cancelled.push(matchId);
    return true;
  }

  async proposedRanking(matchId: `0x${string}`): Promise<readonly Address[] | null> {
    return this.ranking.get(matchId) ?? null;
  }

  async finalize(matchId: `0x${string}`, ranking: readonly Address[]): Promise<boolean> {
    this.finalized.push([matchId, ranking]);
    return true;
  }
}

function bridgeOver(
  reader: EscrowReader,
  now = () => 1_000_000,
  abort?: (matchId: `0x${string}`) => Promise<`0x${string}` | null>,
): { bridge: ChainBridge; lobby: Lobby } {
  const lobby = new Lobby({
    archive: new MemoryArchive(),
    relayer: nullRelayer,
    commitMs: 1_000,
    revealMs: 1_000,
  });
  return { bridge: new ChainBridge({ reader, lobby, chainId: HUB, now, ...(abort ? { abort } : {}) }), lobby };
}

describe('chain bridge discovery', () => {
  it('backfills a window on the first poll, then continues from the cursor', async () => {
    const reader = new FakeEscrow();
    const { bridge } = bridgeOver(reader);

    await bridge.poll();
    expect(reader.ranges[0]).toEqual([5_000n, 10_000n]);

    reader.block = 10_050n;
    await bridge.poll();
    // Resumes at the block after the last one scanned, with no gap and no overlap.
    expect(reader.ranges[1]).toEqual([10_001n, 10_050n]);
  });

  it('scans from genesis when the chain is younger than the backfill window', async () => {
    const reader = new FakeEscrow();
    reader.block = 42n;
    const { bridge } = bridgeOver(reader);

    await bridge.poll();
    expect(reader.ranges[0]).toEqual([0n, 42n]);
  });

  it('tracks a lobby once, however often it is seen', async () => {
    const reader = new FakeEscrow();
    const id = bytes32('dup');
    reader.created = [id, id];
    reader.matches.set(id, match({ seatCount: 1 }));
    const { bridge } = bridgeOver(reader);

    await bridge.poll();
    expect(bridge.directory().open).toHaveLength(1);
  });

  it('drops a match once it settles or cancels', async () => {
    const reader = new FakeEscrow();
    const id = bytes32('gone');
    reader.created = [id];
    reader.matches.set(id, match({ status: MatchStatus.Settled }));
    const { bridge } = bridgeOver(reader);

    await bridge.poll();
    expect(bridge.directory()).toEqual({ open: [], live: [] });
  });
});

describe('chain bridge seat origins', () => {
  it('takes an origin from the join log and maps it out of the messenger id space', async () => {
    const reader = new FakeEscrow();
    const id = bytes32('origins');
    reader.created = [id];
    reader.matches.set(id, match({ seatCount: 2 }));
    reader.seats.set(id, [seat(0), seat(1)]);
    reader.joins = [
      { matchId: id, player: seat(0), originChainId: 0 },
      { matchId: id, player: seat(1), originChainId: ARBITRUM_SEPOLIA_EID },
    ];
    const { bridge } = bridgeOver(reader);

    await bridge.poll();

    const [lobby] = bridge.directory().open;
    // Origin 0 means the hub itself; an endpoint id becomes its EVM chain id.
    expect(lobby?.players.map((p) => p.chainId)).toEqual([HUB, 421614]);
    expect(reader.seatOriginReads).toBe(0);
  });

  it('reads the escrow for a seat that joined before the backfill window, once', async () => {
    const reader = new FakeEscrow();
    const id = bytes32('backfill');
    reader.created = [id];
    reader.matches.set(id, match({ seatCount: 1 }));
    reader.seats.set(id, [seat(0)]);
    reader.origins.set(seat(0).toLowerCase(), ARBITRUM_SEPOLIA_EID);
    const { bridge } = bridgeOver(reader);

    await bridge.poll();
    expect(bridge.directory().open[0]?.players[0]?.chainId).toBe(421614);
    expect(reader.seatOriginReads).toBe(1);

    // Cached: an origin never changes, so a second poll must not read again.
    await bridge.poll();
    expect(reader.seatOriginReads).toBe(1);
  });
});

describe('chain bridge locking', () => {
  const id = bytes32('lock');

  function openLobby(reader: FakeEscrow, info: Partial<EscrowMatch>): void {
    reader.created = [id];
    reader.matches.set(id, match({ status: MatchStatus.Open, ...info }));
  }

  it('locks a full lobby', async () => {
    const reader = new FakeEscrow();
    openLobby(reader, { seatCount: 4, maxSeats: 4 });
    await bridgeOver(reader).bridge.poll();

    expect(reader.locked).toEqual([id]);
  });

  it('leaves a lobby that is neither full nor expired', async () => {
    const reader = new FakeEscrow();
    openLobby(reader, { seatCount: 2, maxSeats: 4, joinDeadline: 2_000n });
    await bridgeOver(reader, () => 1_000_000).bridge.poll();

    expect(reader.locked).toEqual([]);
  });

  it('locks an expired lobby that still has a quorum', async () => {
    const reader = new FakeEscrow();
    openLobby(reader, { seatCount: 4, maxSeats: 8, minSeats: 4, joinDeadline: 500n });
    await bridgeOver(reader, () => 1_000_000).bridge.poll();

    expect(reader.locked).toEqual([id]);
  });

  it('leaves an expired lobby that never reached a quorum', async () => {
    const reader = new FakeEscrow();
    openLobby(reader, { seatCount: 2, maxSeats: 8, minSeats: 4, joinDeadline: 500n });
    await bridgeOver(reader, () => 1_000_000).bridge.poll();

    expect(reader.locked).toEqual([]);
  });

  it('keeps going when the lock loses a race', async () => {
    const reader = new FakeEscrow();
    reader.lockSucceeds = false;
    openLobby(reader, { seatCount: 4, maxSeats: 4 });
    const { bridge } = bridgeOver(reader);

    await bridge.poll();
    expect(bridge.directory().open).toHaveLength(1);
  });
});

describe('chain bridge adoption', () => {
  it('opens a room for a match that goes live while it runs, exactly once', async () => {
    const reader = new FakeEscrow();
    const id = bytes32('live');
    reader.created = [id];
    reader.matches.set(id, match({ status: MatchStatus.Pending, seatCount: 4 }));
    reader.seats.set(id, [seat(0), seat(1), seat(2), seat(3)]);
    const { bridge, lobby } = bridgeOver(reader);

    await bridge.poll();
    reader.matches.set(id, match({ status: MatchStatus.Live, seatCount: 4 }));
    await bridge.poll();
    expect(lobby.get(id)).not.toBeNull();
    expect(lobby.size).toBe(1);

    await bridge.poll();
    expect(lobby.size).toBe(1);
  });

  it('does not open a room while the match is still waiting on the oracle', async () => {
    const reader = new FakeEscrow();
    const id = bytes32('pending');
    reader.created = [id];
    reader.matches.set(id, match({ status: MatchStatus.Pending, seatCount: 4 }));
    reader.seats.set(id, [seat(0), seat(1), seat(2), seat(3)]);
    const { bridge, lobby } = bridgeOver(reader);

    await bridge.poll();
    // A room before the seed exists would let the server pick moves against
    // rolls it already knows.
    expect(lobby.size).toBe(0);
    expect(bridge.directory().live).toHaveLength(1);
  });

  it('finalises a proposed result once its challenge window has closed, and not before', async () => {
    const reader = new FakeEscrow();
    const id = bytes32('proposed');
    reader.created = [id];
    reader.matches.set(id, match({ status: MatchStatus.Proposed, challengeDeadline: 2_000n }));
    reader.ranking.set(id, [seat(2), seat(1), seat(3), seat(0)]);

    let nowMs = 1_000_000; // 1 000 s: inside the window
    const { bridge } = bridgeOver(reader, () => nowMs);
    await bridge.poll();
    expect(reader.finalized).toEqual([]);
    // A proposed result is no longer a lobby anyone can join or watch.
    expect(bridge.directory()).toEqual({ open: [], live: [] });

    nowMs = 2_000_000;
    await bridge.poll();
    expect(reader.finalized).toEqual([[id, [seat(2), seat(1), seat(3), seat(0)]]]);
  });
});

describe('chain bridge after a restart', () => {
  function liveBeforeBoot() {
    const reader = new FakeEscrow();
    const id = bytes32('live-before-restart');
    reader.created = [id];
    reader.matches.set(id, match({ status: MatchStatus.Live, seatCount: 4, settleDeadline: 5_000n }));
    reader.seats.set(id, [seat(0), seat(1), seat(2), seat(3)]);
    return { reader, id };
  }

  it('aborts a match that was already live instead of replaying it from round one', async () => {
    const { reader, id } = liveBeforeBoot();
    const aborted: string[] = [];
    const { bridge, lobby } = bridgeOver(reader, () => 1_000_000, async (matchId) => {
      aborted.push(matchId);
      return `0x${'ab'.repeat(32)}`;
    });

    await bridge.poll();
    expect(aborted).toEqual([id]);
    expect(lobby.get(id)).toBeNull();
    expect(bridge.directory()).toEqual({ open: [], live: [] });
    // A player reconnecting to it is told what happened rather than "unknown match".
    expect(() => lobby.attach(id, { address: null, send: () => {} })).toThrow(/cancelled after a server restart/);

    // Still `Live` on the next poll while the abort is in flight: no second abort, no room.
    await bridge.poll();
    expect(aborted).toEqual([id]);
    expect(lobby.size).toBe(0);
  });

  it('falls back to the permissionless refund at the deadline when it cannot abort', async () => {
    const { reader, id } = liveBeforeBoot();
    let nowMs = 1_000_000; // 1 000 s: before the 5 000 s deadline
    const { bridge, lobby } = bridgeOver(reader, () => nowMs, async () => null);

    await bridge.poll();
    expect(reader.cancelled).toEqual([]);
    expect(lobby.size).toBe(0);

    nowMs = 5_000_000;
    await bridge.poll();
    expect(reader.cancelled).toEqual([id]);
  });
});
