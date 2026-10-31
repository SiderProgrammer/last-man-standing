import type { Address } from 'viem';
import { errorMessage, lmsGovernorAbi, type ProposalSummary } from '@lms/protocol';
import { chunkedLogs, confirmedHead } from './logs.js';
import { readClient } from './viem.js';

/** Everything the index needs from the chain, so the polling can be tested with a fake. */
export interface ProposalReader {
  blockNumber(): Promise<bigint>;
  proposalCreatedLogs(from: bigint, to: bigint): Promise<ProposalSummary[]>;
}

/**
 * Every proposal made to the governor, discovered from `ProposalCreated`.
 *
 * The governor cannot enumerate its own proposals, so something has to watch
 * for them; this is that something. It keeps only what the event says —
 * which never changes — and leaves everything that does (state, tallies) to
 * be read live by whoever displays it.
 *
 * One cursor, advanced only after a range has been read in full, so a failed
 * poll is simply retried from the same block next time.
 */
export class ProposalIndex {
  private readonly proposals = new Map<string, ProposalSummary>();
  private cursor: bigint;
  private polling = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly reader: ProposalReader,
    fromBlock: bigint,
    /** Blocks behind the head a scan stops at, as the chain bridge does. */
    private readonly confirmations = 0,
  ) {
    this.cursor = fromBlock;
  }

  static start(options: {
    rpcUrl: string;
    chainId: number;
    governor: Address;
    fromBlock: bigint;
    confirmations?: number;
    pollMs?: number;
  }) {
    const index = new ProposalIndex(viemProposalReader(options), options.fromBlock, options.confirmations);
    void index.poll();
    index.timer = setInterval(() => void index.poll(), options.pollMs ?? 15_000);
    index.timer.unref?.();
    return index;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Newest first. */
  list(): ProposalSummary[] {
    return [...this.proposals.values()].sort((a, b) => b.block - a.block || (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const head = confirmedHead(await this.reader.blockNumber(), this.confirmations);
      if (head === null || this.cursor > head) return;
      // Chunk by chunk, advancing the cursor as each lands, so a failure
      // part way resumes from the chunk that failed.
      await chunkedLogs(this.cursor, head, async (from, to) => {
        for (const proposal of await this.reader.proposalCreatedLogs(from, to)) this.proposals.set(proposal.id, proposal);
        this.cursor = to + 1n;
        return [];
      });
    } catch (error) {
      console.error('[governance] poll failed:', errorMessage(error));
    } finally {
      this.polling = false;
    }
  }
}

export function viemProposalReader(options: { rpcUrl: string; chainId: number; governor: Address }): ProposalReader {
  const client = readClient(options.chainId, options.rpcUrl);
  return {
    blockNumber: () => client.getBlockNumber(),
    async proposalCreatedLogs(from, to) {
      const logs = await client.getContractEvents({
        address: options.governor,
        abi: lmsGovernorAbi,
        eventName: 'ProposalCreated',
        fromBlock: from,
        toBlock: to,
      });
      return logs.flatMap(({ args, blockNumber }) =>
        args.proposalId !== undefined && args.proposer && args.targets && args.values && args.calldatas
          ? [
              {
                id: args.proposalId.toString(),
                proposer: args.proposer,
                targets: [...args.targets],
                values: args.values.map(String),
                calldatas: [...args.calldatas],
                description: args.description ?? '',
                voteStart: Number(args.voteStart ?? 0n),
                voteEnd: Number(args.voteEnd ?? 0n),
                block: Number(blockNumber ?? 0n),
              },
            ]
          : [],
      );
    },
  };
}

/** Answers `GET /proposals`, or returns null for any other path. */
export function proposalsResponse(
  index: ProposalIndex | null,
  path: string,
): { status: number; body: string } | null {
  if ((path.split('?')[0] ?? '').replace(/\/$/, '') !== '/proposals') return null;
  if (!index) return { status: 404, body: JSON.stringify({ error: 'no governor' }) };
  return { status: 200, body: JSON.stringify(index.list()) };
}
