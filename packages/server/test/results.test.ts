import { describe, expect, it } from 'vitest';
import type { MatchSummary } from '@lms/api';
import { ResultIndex, mergeHistory, type ProposedResult, type ResultReader } from '@lms/server';

const ME = `0x${'aa'.repeat(20)}` as const;
const OTHER = `0x${'bb'.repeat(20)}` as const;

function result(id: number, finishedAt: number, ranking: Array<`0x${string}`>, block: bigint): ProposedResult & { block: bigint } {
  return {
    matchId: `0x${id.toString(16).padStart(64, '0')}`,
    rounds: 9,
    ranking,
    seats: [OTHER, ME],
    finishedAt,
    tx: `0x${'cd'.repeat(32)}`,
    block,
  };
}

class FakeEscrow implements ResultReader {
  head = 100n;
  logs: Array<ProposedResult & { block: bigint }> = [];
  async blockNumber() {
    return this.head;
  }
  async resultLogs(from: bigint, to: bigint) {
    return this.logs.filter((log) => log.block >= from && log.block <= to);
  }
}

describe('ResultIndex', () => {
  it("rebuilds a player's staked history from the escrow, newest first, as rows that cannot be replayed", async () => {
    const escrow = new FakeEscrow();
    escrow.logs = [result(1, 1_000, [ME, OTHER], 10n), result(2, 2_000, [OTHER, ME], 20n), result(3, 3_000, [OTHER], 30n)];
    const index = new ResultIndex(escrow, 0n, 3);
    await index.poll();

    const rows = index.forPlayer(ME, 10);
    expect(rows.map((row) => [row.finishedAt, row.place, row.seat, row.staked, row.chainOnly])).toEqual([
      [2_000, 2, 1, true, true],
      [1_000, 1, 1, true, true],
    ]);
    expect(index.forPlayer(ME, 10, 2_000).map((row) => row.finishedAt)).toEqual([1_000]);
    expect(index.forPlayer(ME, 1)).toHaveLength(1);
  });

  it('reads only confirmed blocks, and picks up from where it stopped', async () => {
    const escrow = new FakeEscrow();
    escrow.head = 12n;
    escrow.logs = [result(1, 1_000, [ME], 10n)];
    const index = new ResultIndex(escrow, 0n, 3);
    await index.poll();
    expect(index.forPlayer(ME, 10)).toEqual([]);
    escrow.head = 20n;
    await index.poll();
    expect(index.forPlayer(ME, 10)).toHaveLength(1);
  });
});

describe('mergeHistory', () => {
  const row = (id: string, finishedAt: number, chainOnly = false): MatchSummary => ({
    matchId: id as `0x${string}`,
    finishedAt,
    rounds: 5,
    players: 4,
    seat: 0,
    place: 1,
    staked: true,
    settledTx: null,
    ...(chainOnly ? { chainOnly } : {}),
  });

  it('keeps the archive\'s row where both have the match, and adds what only the chain has', () => {
    const merged = mergeHistory([row('0xAB', 3_000), row('0x01', 1_000)], [row('0xab', 3_000, true), row('0x02', 2_000, true)]);
    expect(merged.map((match) => [match.matchId, match.chainOnly ?? false])).toEqual([
      ['0xAB', false],
      ['0x02', true],
      ['0x01', false],
    ]);
  });
});
