import type { Address } from 'viem';
import { addressKey } from '@lms/consensus';
import { gameEscrowAbi } from '@lms/contracts';
import { errorMessage, type MatchSummary } from '@lms/api';
import { chunkedLogs, confirmedHead } from './logs.js';
import { readClient } from './viem.js';
import { exclusive, repeat } from '../util/poll.js';

/** A staked match's result as the escrow recorded it, with what a history row needs. */
export interface ProposedResult {
  matchId: `0x${string}`;
  rounds: number;
  /** Winner first. */
  ranking: readonly Address[];
  /** The seats in stake order: a player's seat is their index here. */
  seats: readonly Address[];
  /** Unix milliseconds of the block that proposed it. */
  finishedAt: number;
  tx: `0x${string}`;
}

/** Everything the index needs from the chain, so the polling can be tested with a fake. */
export interface ResultReader {
  blockNumber(): Promise<bigint>;
  resultLogs(from: bigint, to: bigint): Promise<ProposedResult[]>;
}

/**
 * Every staked result the escrow has seen proposed, from `ResultProposed`.
 *
 * The match archive is where a finished match is kept in full, and a server
 * that keeps it in memory loses it on a restart. The chain does not forget:
 * this index rebuilds each player's staked history from it, so "Your
 * matches" still lists them, with place, rounds and the transaction, though
 * not the moves to replay. Practice matches never reach the chain and are
 * not here.
 */
export class ResultIndex {
  private readonly results = new Map<string, ProposedResult>();
  private cursor: bigint;
  private stopTimer: (() => void) | null = null;

  constructor(
    private readonly reader: ResultReader,
    fromBlock: bigint,
    private readonly confirmations = 0,
  ) {
    this.cursor = fromBlock;
  }

  static start(options: {
    rpcUrl: string;
    chainId: number;
    escrow: Address;
    fromBlock: bigint;
    confirmations?: number;
    pollMs?: number;
  }): ResultIndex {
    const index = new ResultIndex(viemResultReader(options), options.fromBlock, options.confirmations);
    index.stopTimer = repeat(() => void index.poll(), options.pollMs ?? 15_000);
    return index;
  }

  stop(): void {
    this.stopTimer?.();
    this.stopTimer = null;
  }

  /**
   * A wallet's staked matches, newest first, as history rows: at most
   * `limit`, and only those finished before `before` (unix ms) when given.
   */
  forPlayer(address: Address, limit: number, before?: number): MatchSummary[] {
    const key = addressKey(address);
    return [...this.results.values()]
      .filter((result) => result.ranking.some((player) => addressKey(player) === key))
      .filter((result) => before === undefined || result.finishedAt < before)
      .sort((a, b) => b.finishedAt - a.finishedAt)
      .slice(0, limit)
      .map((result) => summaryOf(result, key));
  }

  /** One poll; a poll while one runs does nothing. Never rejects: a failure is logged and retried next time. */
  readonly poll: () => Promise<void> = exclusive(async () => {
    try {
      const head = confirmedHead(await this.reader.blockNumber(), this.confirmations);
      if (head === null || this.cursor > head) return;
      await chunkedLogs(this.cursor, head, async (from, to) => {
        // A result proposed again after a veto replaces the earlier one.
        for (const result of await this.reader.resultLogs(from, to)) this.results.set(result.matchId.toLowerCase(), result);
        this.cursor = to + 1n;
        return [];
      });
    } catch (error) {
      console.error('[results] poll failed:', errorMessage(error));
    }
  });
}

function summaryOf(result: ProposedResult, key: string): MatchSummary {
  const place = result.ranking.findIndex((player) => addressKey(player) === key);
  const seat = result.seats.findIndex((player) => addressKey(player) === key);
  return {
    matchId: result.matchId,
    finishedAt: result.finishedAt,
    rounds: result.rounds,
    players: result.ranking.length,
    seat: seat < 0 ? null : seat,
    place: place + 1,
    staked: true,
    settledTx: result.tx,
    chainOnly: true,
  };
}

export function viemResultReader(options: { rpcUrl: string; chainId: number; escrow: Address }): ResultReader {
  const client = readClient(options.chainId, options.rpcUrl);
  const times = new Map<bigint, number>();
  const blockTime = async (block: bigint): Promise<number> => {
    const known = times.get(block);
    if (known !== undefined) return known;
    const time = Number((await client.getBlock({ blockNumber: block })).timestamp) * 1000;
    times.set(block, time);
    return time;
  };
  return {
    blockNumber: () => client.getBlockNumber(),
    async resultLogs(from, to) {
      const logs = await client.getContractEvents({
        address: options.escrow,
        abi: gameEscrowAbi,
        eventName: 'ResultProposed',
        fromBlock: from,
        toBlock: to,
      });
      const found = await Promise.all(
        logs.map(async ({ args, blockNumber, transactionHash }): Promise<ProposedResult | null> => {
          if (!args.matchId || !args.ranking || args.rounds === undefined || blockNumber === null || !transactionHash) return null;
          const [seats, finishedAt] = await Promise.all([
            client.readContract({ address: options.escrow, abi: gameEscrowAbi, functionName: 'getSeats', args: [args.matchId] }),
            blockTime(blockNumber),
          ]);
          return {
            matchId: args.matchId,
            rounds: Number(args.rounds),
            ranking: [...args.ranking],
            seats: [...seats],
            finishedAt,
            tx: transactionHash,
          };
        }),
      );
      return found.filter((result): result is ProposedResult => result !== null);
    },
  };
}
