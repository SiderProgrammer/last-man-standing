import { describe, expect, it } from 'vitest';
import type { ProposalSummary } from '@lms/protocol';
import { ProposalIndex, proposalsResponse, type ProposalReader } from '@lms/server';

function proposal(id: number, block: number): ProposalSummary {
  return {
    id: String(id),
    proposer: `0x${'aa'.repeat(20)}`,
    targets: [`0x${'bb'.repeat(20)}`],
    values: ['0'],
    calldatas: ['0x'],
    description: `Proposal ${id}`,
    voteStart: 1_000,
    voteEnd: 2_000,
    block,
  };
}

class FakeGovernor implements ProposalReader {
  head = 25_000n;
  logs: ProposalSummary[] = [];
  failNext = false;
  readonly ranges: Array<[bigint, bigint]> = [];

  async blockNumber() {
    return this.head;
  }

  async proposalCreatedLogs(from: bigint, to: bigint) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('rate limited');
    }
    this.ranges.push([from, to]);
    return this.logs.filter((log) => BigInt(log.block) >= from && BigInt(log.block) <= to);
  }
}

describe('ProposalIndex', () => {
  it('scans from the governor deployment in 10k-block chunks, newest proposal first', async () => {
    const reader = new FakeGovernor();
    reader.logs = [proposal(1, 5_100), proposal(2, 21_000)];
    const index = new ProposalIndex(reader, 5_000n);

    await index.poll();

    expect(reader.ranges).toEqual([
      [5_000n, 14_999n],
      [15_000n, 24_999n],
      [25_000n, 25_000n],
    ]);
    expect(index.list().map((p) => p.id)).toEqual(['2', '1']);
  });

  it('only reads new blocks on later polls', async () => {
    const reader = new FakeGovernor();
    const index = new ProposalIndex(reader, 24_990n);
    await index.poll();

    reader.head = 25_010n;
    reader.logs = [proposal(3, 25_005)];
    await index.poll();

    expect(reader.ranges.at(-1)).toEqual([25_001n, 25_010n]);
    expect(index.list().map((p) => p.id)).toEqual(['3']);
  });

  it('retries a failed range from the same block', async () => {
    const reader = new FakeGovernor();
    reader.logs = [proposal(4, 24_000)];
    reader.failNext = true;
    const index = new ProposalIndex(reader, 20_000n);

    await index.poll();
    expect(index.list()).toEqual([]);

    await index.poll();
    expect(index.list().map((p) => p.id)).toEqual(['4']);
  });
});

describe('proposalsResponse', () => {
  it('serves the list, 404s without a governor, and ignores other paths', async () => {
    const reader = new FakeGovernor();
    reader.logs = [proposal(1, 25_000)];
    const index = new ProposalIndex(reader, 25_000n);
    await index.poll();

    const response = proposalsResponse(index, '/proposals');
    expect(response?.status).toBe(200);
    expect(JSON.parse(response!.body)).toHaveLength(1);

    expect(proposalsResponse(null, '/proposals')?.status).toBe(404);
    expect(proposalsResponse(index, '/health')).toBeNull();
  });
});
