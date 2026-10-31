import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { DEFAULT_RULES, LOCK_GRACE_SECONDS, MatchStatus, hashRules } from '@lms/protocol';
import { rankingHash } from '@lms/engine';
import {
  ChainBridge,
  chunkedLogs,
  confirmedHead,
  Lobby,
  MemoryArchive,
  MemoryJournal,
  nullRelayer,
  type ChainBridgeDeps,
  type EscrowMatch,
  type EscrowMatchRead,
  type EscrowReader,
} from '@lms/server';
import { bytes32 } from './helpers.js';

const HUB = 11155111;
const ARBITRUM_SEPOLIA = 421614;

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
    rulesHash: hashRules(DEFAULT_RULES),
    seed: bytes32('seed'),
    deadline: 9_999_999_999n,
    rankingHash: `0x${'00'.repeat(32)}`,
    matchmade: false,
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

  /** Through `getMatch` and `getSeats`, so a test can make either fail. */
  async getMatches(ids: readonly `0x${string}`[]): Promise<EscrowMatchRead[]> {
    this.batches += 1;
    return Promise.all(ids.map(async (id) => ({ match: await this.getMatch(id), seats: await this.getSeats(id) })));
  }
  batches = 0;

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
  extra: Partial<Pick<ChainBridgeDeps, 'fromBlock' | 'confirmations' | 'archive'>> = {},
): { bridge: ChainBridge; lobby: Lobby } {
  const lobby = new Lobby({
    archive: new MemoryArchive(),
    relayer: nullRelayer,
    commitMs: 1_000,
    revealMs: 1_000,
  });
  return { bridge: new ChainBridge({ reader, lobby, chainId: HUB, now, ...(abort ? { abort } : {}), ...extra }), lobby };
}

describe('chain bridge discovery', () => {
  it('backfills longer than a match lasts on the first poll, in chunks, then continues from the cursor', async () => {
    const reader = new FakeEscrow();
    reader.block = 200_000n;
    const { bridge } = bridgeOver(reader);

    await bridge.poll();
    expect(reader.ranges[0]).toEqual([100_000n, 109_999n]);
    expect(reader.ranges).toHaveLength(11);
    expect(reader.ranges[10]).toEqual([200_000n, 200_000n]);

    reader.block = 200_050n;
    await bridge.poll();
    // Resumes at the block after the last one scanned, with no gap and no overlap.
    expect(reader.ranges[11]).toEqual([200_001n, 200_050n]);
  });

  it('never scans before the deploy block, nor the newest blocks a reorg could still take', async () => {
    const reader = new FakeEscrow();
    reader.block = 10_000n;
    const { bridge } = bridgeOver(reader, undefined, undefined, { fromBlock: 9_000n, confirmations: 3 });

    await bridge.poll();
    expect(reader.ranges).toEqual([[9_000n, 9_997n]]);
    reader.block = 10_001n;
    await bridge.poll();
    expect(reader.ranges[1]).toEqual([9_998n, 9_998n]);
  });

  it('reads every tracked match in one batch a poll', async () => {
    const reader = new FakeEscrow();
    reader.created = [bytes32('a'), bytes32('b'), bytes32('c')];
    const { bridge } = bridgeOver(reader);
    await bridge.poll();
    // One for the start-up snapshot, one for the refresh.
    expect(reader.batches).toBe(2);
    await bridge.poll();
    expect(reader.batches).toBe(3);
  });

  it('drops a match whose creation was reorged away', async () => {
    const reader = new FakeEscrow();
    const id = bytes32('reorged');
    reader.created = [id];
    const { bridge } = bridgeOver(reader);
    await bridge.poll();
    expect(bridge.directory().open).toHaveLength(1);

    reader.created = [];
    reader.matches.set(id, match({ status: MatchStatus.None }));
    await bridge.poll();
    expect(bridge.directory().open).toHaveLength(0);
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
  it('takes an origin from the join log', async () => {
    const reader = new FakeEscrow();
    const id = bytes32('origins');
    reader.created = [id];
    reader.matches.set(id, match({ seatCount: 2 }));
    reader.seats.set(id, [seat(0), seat(1)]);
    reader.joins = [
      { matchId: id, player: seat(0), originChainId: 0 },
      { matchId: id, player: seat(1), originChainId: ARBITRUM_SEPOLIA },
    ];
    const { bridge } = bridgeOver(reader);

    await bridge.poll();

    const [lobby] = bridge.directory().open;
    // Origin 0 means the hub itself.
    expect(lobby?.players.map((p) => p.chainId)).toEqual([HUB, ARBITRUM_SEPOLIA]);
    expect(reader.seatOriginReads).toBe(0);
  });

  it('reads the escrow for a seat that joined before the backfill window, once', async () => {
    const reader = new FakeEscrow();
    const id = bytes32('backfill');
    reader.created = [id];
    reader.matches.set(id, match({ seatCount: 1 }));
    reader.seats.set(id, [seat(0)]);
    reader.origins.set(seat(0).toLowerCase(), ARBITRUM_SEPOLIA);
    const { bridge } = bridgeOver(reader);

    await bridge.poll();
    expect(bridge.directory().open[0]?.players[0]?.chainId).toBe(ARBITRUM_SEPOLIA);
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
    reader.matches.set(id, match({ status: MatchStatus.Proposed, deadline: 2_000n }));
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

describe('chain bridge and the rules a match was created under', () => {
  it('calls off a live match created under other rules instead of playing it under these', async () => {
    const reader = new FakeEscrow();
    const id = bytes32('old-rules');
    reader.created = [id];
    reader.matches.set(id, match({ status: MatchStatus.Pending, seatCount: 4 }));
    reader.seats.set(id, [seat(0), seat(1), seat(2), seat(3)]);
    const aborted: string[] = [];
    const { bridge, lobby } = bridgeOver(reader, () => 1_000_000, async (matchId) => {
      aborted.push(matchId);
      return `0x${'ab'.repeat(32)}`;
    });

    await bridge.poll();
    reader.matches.set(id, match({ status: MatchStatus.Live, seatCount: 4, rulesHash: bytes32('old rules') }));
    await bridge.poll();

    expect(aborted).toEqual([id]);
    expect(lobby.get(id)).toBeNull();
    expect(() => lobby.attach(id, { address: null, send: () => {} })).toThrow(/rules this server does not play/);
  });

  it('never locks an open lobby created under other rules', async () => {
    const reader = new FakeEscrow();
    const id = bytes32('old-rules-open');
    reader.created = [id];
    reader.matches.set(id, match({ status: MatchStatus.Open, seatCount: 4, rulesHash: bytes32('old rules') }));
    reader.seats.set(id, [seat(0), seat(1), seat(2), seat(3)]);
    const { bridge } = bridgeOver(reader);

    await bridge.poll();
    expect(reader.locked).toEqual([]);
  });
});

describe('chain bridge after a restart', () => {
  function liveBeforeBoot() {
    const reader = new FakeEscrow();
    const id = bytes32('live-before-restart');
    reader.created = [id];
    reader.matches.set(id, match({ status: MatchStatus.Live, seatCount: 4, deadline: 5_000n }));
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

  it('does nothing at all until it has read every match once', async () => {
    const { reader, id } = liveBeforeBoot();
    const open = bytes32('full-at-boot');
    reader.created = [id, open];
    reader.matches.set(open, match({ status: MatchStatus.Open, seatCount: 4, maxSeats: 4 }));
    const aborted: string[] = [];
    const { bridge } = bridgeOver(reader, () => 1_000_000, async (matchId) => {
      aborted.push(matchId);
      return null;
    });

    // The RPC fails partway through the first read of the open lobby.
    const getMatch = reader.getMatch.bind(reader);
    reader.getMatch = async (matchId) => {
      if (matchId === open) throw new Error('rpc down');
      return getMatch(matchId);
    };
    await bridge.poll();
    expect(aborted).toEqual([]);
    expect(reader.locked).toEqual([]);

    reader.getMatch = getMatch;
    await bridge.poll();
    expect(aborted).toEqual([id]);
    expect(reader.locked).toEqual([open]);
  });

  it('plays a match that goes live after it started, even when polls failed before', async () => {
    const { reader, id } = liveBeforeBoot();
    const later = bytes32('live-after-boot');
    reader.created = [id, later];
    reader.matches.set(later, match({ status: MatchStatus.Pending, seatCount: 4 }));
    reader.seats.set(later, [seat(0), seat(1), seat(2), seat(3)]);
    const { bridge, lobby } = bridgeOver(reader, () => 1_000_000, async () => null);
    await bridge.poll();

    // Polls fail after the snapshot, while the second match goes live.
    const getSeats = reader.getSeats.bind(reader);
    reader.getSeats = async () => {
      throw new Error('rpc down');
    };
    reader.matches.set(later, match({ status: MatchStatus.Live, seatCount: 4 }));
    await bridge.poll();
    reader.getSeats = getSeats;
    await bridge.poll();

    expect(lobby.get(later)).not.toBeNull();
    expect(lobby.get(id)).toBeNull();
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

describe('chain bridge keeper', () => {
  const id = bytes32('keeper');

  function tracked(reader: FakeEscrow, info: Partial<EscrowMatch>): void {
    reader.created = [id];
    reader.matches.set(id, match(info));
    reader.seats.set(id, [seat(0), seat(1)]);
  }

  it('cancels an open lobby whose join window closed short of seats', async () => {
    const reader = new FakeEscrow();
    tracked(reader, { status: MatchStatus.Open, seatCount: 2, minSeats: 4, joinDeadline: 500n });
    const { bridge } = bridgeOver(reader, () => 1_000_000);
    await bridge.poll();

    expect(reader.cancelled).toEqual([id]);
    expect(reader.locked).toEqual([]);
    // Still listed, so a seated player sees it can be cancelled.
    expect(bridge.directory().open[0]?.cancellableAt).toBe(500);
  });

  it('locks a quorate lobby past its deadline, and cancels it only once the lock grace has passed', async () => {
    const reader = new FakeEscrow();
    reader.lockSucceeds = false;
    tracked(reader, { status: MatchStatus.Open, seatCount: 4, maxSeats: 8, minSeats: 4, joinDeadline: 500n });
    let nowMs = 600_000;
    const { bridge } = bridgeOver(reader, () => nowMs);

    await bridge.poll();
    expect(reader.cancelled).toEqual([]);
    expect(bridge.directory().open[0]?.cancellableAt).toBe(500 + LOCK_GRACE_SECONDS);

    nowMs = (500 + LOCK_GRACE_SECONDS) * 1000;
    await bridge.poll();
    expect(reader.cancelled).toEqual([id]);
  });

  it('cancels a lobby the oracle never seeded, once its timeout has passed', async () => {
    const reader = new FakeEscrow();
    tracked(reader, { status: MatchStatus.Pending, deadline: 2_000n });
    let nowMs = 1_000_000;
    const { bridge } = bridgeOver(reader, () => nowMs);

    await bridge.poll();
    expect(reader.cancelled).toEqual([]);
    nowMs = 2_000_000;
    await bridge.poll();
    expect(reader.cancelled).toEqual([id]);
  });

  it('cancels a match it adopted but never settled, once the settle deadline has passed', async () => {
    const reader = new FakeEscrow();
    reader.created = [id];
    reader.matches.set(id, match({ status: MatchStatus.Open, seatCount: 4, maxSeats: 4 }));
    reader.seats.set(id, [seat(0), seat(1), seat(2), seat(3)]);
    let nowMs = 1_000_000;
    const { bridge, lobby } = bridgeOver(reader, () => nowMs);
    await bridge.poll();
    reader.matches.set(id, match({ status: MatchStatus.Live, seatCount: 4, deadline: 4_000n }));
    await bridge.poll();
    expect(lobby.get(id)).not.toBeNull();

    nowMs = 4_000_000;
    await bridge.poll();
    expect(reader.cancelled).toEqual([id]);
  });

  it('forgets a match nothing has cancelled an hour after it could have been', async () => {
    const reader = new FakeEscrow();
    // No keeper here: every cancel is refused.
    reader.cancelMatch = async () => false;
    tracked(reader, { status: MatchStatus.Open, seatCount: 2, minSeats: 4, joinDeadline: 500n });
    let nowMs = 1_000_000;
    const { bridge } = bridgeOver(reader, () => nowMs);

    await bridge.poll();
    expect(bridge.directory().open).toHaveLength(1);
    nowMs = (500 + 3_600) * 1000;
    await bridge.poll();
    expect(bridge.directory().open).toHaveLength(0);
    // Gone for good: not read again.
    reader.getMatch = async () => {
      throw new Error('read after it was forgotten');
    };
    await bridge.poll();
  });
});

describe('chain bridge finalising from the archive', () => {
  const id = bytes32('archived-result');
  const ranking = [seat(2), seat(0), seat(1), seat(3)];

  function proposed(reader: FakeEscrow, stored: readonly Address[]): void {
    reader.created = [id];
    reader.matches.set(id, match({ status: MatchStatus.Proposed, deadline: 500n, rankingHash: rankingHash(stored) }));
  }

  it('takes the ranking from the archive, without scanning a log', async () => {
    const reader = new FakeEscrow();
    proposed(reader, ranking);
    let scanned = 0;
    reader.proposedRanking = async () => {
      scanned += 1;
      return null;
    };
    const archive = { load: async () => ({ result: { matchId: id, rounds: 3, historyRoot: id, ranking } }) as never };
    await bridgeOver(reader, () => 1_000_000, undefined, { archive }).bridge.poll();

    expect(reader.finalized).toEqual([[id, ranking]]);
    expect(scanned).toBe(0);
  });

  it('falls back to the logs when the archive has none, or one that is not what was proposed', async () => {
    const reader = new FakeEscrow();
    proposed(reader, ranking);
    reader.ranking.set(id, ranking);
    const stale = { load: async () => ({ result: { matchId: id, rounds: 3, historyRoot: id, ranking: [...ranking].reverse() } }) as never };
    await bridgeOver(reader, () => 1_000_000, undefined, { archive: stale }).bridge.poll();

    expect(reader.finalized).toEqual([[id, ranking]]);
  });
});

describe('chain bridge and foreign rules', () => {
  it('does not list a lobby created under rules this server does not play', async () => {
    const reader = new FakeEscrow();
    const id = bytes32('foreign-open');
    reader.created = [id];
    reader.matches.set(id, match({ status: MatchStatus.Open, rulesHash: bytes32('other rules') }));
    const { bridge } = bridgeOver(reader);
    await bridge.poll();
    expect(bridge.directory().open).toEqual([]);
  });
});

describe('chunked log scans', () => {
  it('reads a range in chunks of at most the chunk size, in order, with no gap', async () => {
    const ranges: Array<[bigint, bigint]> = [];
    const logs = await chunkedLogs(5n, 27n, async (from, to) => {
      ranges.push([from, to]);
      return [from];
    }, 10n);
    expect(ranges).toEqual([[5n, 14n], [15n, 24n], [25n, 27n]]);
    expect(logs).toEqual([5n, 15n, 25n]);
    expect(await chunkedLogs(5n, 4n, async () => [1])).toEqual([]);
  });

  it('stops short of the newest blocks by the confirmation depth', () => {
    expect(confirmedHead(100n, 3)).toBe(97n);
    expect(confirmedHead(2n, 3)).toBeNull();
    expect(confirmedHead(100n, 0)).toBe(100n);
  });
});

describe('chain bridge and matchmade lobbies', () => {
  it('says which lobbies the matchmaker opened', async () => {
    const reader = new FakeEscrow();
    const matched = bytes32('matchmade');
    const open = bytes32('private');
    reader.created = [matched, open];
    reader.matches.set(matched, match({ status: MatchStatus.Open, seatCount: 1, matchmade: true }));
    reader.matches.set(open, match({ status: MatchStatus.Open, seatCount: 1 }));
    const { bridge } = bridgeOver(reader);
    await bridge.poll();
    const listed = new Map(bridge.directory().open.map((lobby) => [lobby.matchId, lobby.matchmade]));
    expect(listed).toEqual(new Map([[matched, true], [open, false]]));
  });
});

describe('chain bridge resuming after a restart', () => {
  it('resumes a match live at startup from its journal instead of refunding it', async () => {
    const reader = new FakeEscrow();
    const id = bytes32('journalled');
    const seats = [seat(0), seat(1), seat(2), seat(3)];
    reader.created = [id];
    reader.matches.set(id, match({ status: MatchStatus.Live, seatCount: 4 }));
    reader.seats.set(id, seats);
    const journal = new MemoryJournal();
    await journal.append(id, 0, { kind: 'open', at: 0 });

    const lobby = new Lobby({ archive: new MemoryArchive(), relayer: nullRelayer, commitMs: 1_000, revealMs: 1_000, journal });
    const aborted: string[] = [];
    const bridge = new ChainBridge({
      reader,
      lobby,
      chainId: HUB,
      now: () => 1_000_000,
      abort: async (matchId) => {
        aborted.push(matchId);
        return null;
      },
    });
    await bridge.poll();

    expect(aborted).toEqual([]);
    expect(lobby.get(id)?.match.seats.map((s) => s.address)).toEqual(seats);
    expect(bridge.directory().live.map((lobbyInfo) => lobbyInfo.matchId)).toEqual([id]);
  });
});
