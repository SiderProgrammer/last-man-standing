import type { Address } from 'viem';
import { gameEscrowAbi } from '@lms/contracts';
import { errorMessage } from '@lms/api';
import { chunkedLogs } from './logs.js';
import type { ContractCall, TxSender } from './txSender.js';
import { readClient } from './viem.js';

/**
 * A match's on-chain state, as `ChainBridge` needs it: the escrow's `MatchInfo`
 * joined with the terms record the match was opened on.
 */
export interface EscrowMatch {
  stake: bigint;
  minSeats: number;
  maxSeats: number;
  seatCount: number;
  status: number;
  joinDeadline: bigint;
  /** Digest of the rule set the match was created under; see `hashRules`. */
  rulesHash: `0x${string}`;
  seed: `0x${string}`;
  /**
   * Unix seconds when the current phase ends: the seed's timeout while pending,
   * the settlement deadline while live, the challenge window while proposed.
   */
  deadline: bigint;
  /** `keccak256(abi.encode(ranking))` of a proposed result; zero before one. */
  rankingHash: `0x${string}`;
  /** Opened by the matchmaker: only its roster can join. */
  matchmade: boolean;
}

/** A match and who sits in it, as one batched read returns them. */
export interface EscrowMatchRead {
  match: EscrowMatch;
  seats: readonly Address[];
}

export interface MatchCreatedLog {
  matchId: `0x${string}`;
}

export interface PlayerJoinedLog {
  matchId: `0x${string}`;
  player: Address;
  originChainId: number;
}

/**
 * Everything `ChainBridge` needs from the hub, as an interface.
 *
 * The bridge used to build its own viem clients in its constructor, which made
 * it the one module in the package with no seam and — not coincidentally — the
 * one with no tests. The polling logic it contains is exactly the kind worth
 * testing: block-cursor arithmetic, deciding when a lobby may be locked, and
 * opening a room at most once. All of that is now reachable with a fake.
 */
export interface EscrowReader {
  blockNumber(): Promise<bigint>;
  matchCreatedLogs(from: bigint, to: bigint): Promise<MatchCreatedLog[]>;
  playerJoinedLogs(from: bigint, to: bigint): Promise<PlayerJoinedLog[]>;
  /** Every match in `ids`, with its seats, in order: one multicall where the chain has one. */
  getMatches(ids: readonly `0x${string}`[]): Promise<EscrowMatchRead[]>;
  seatOrigin(matchId: `0x${string}`, player: Address): Promise<number>;
  /**
   * Sends a lock for a lobby, or reports that it did not.
   *
   * True once the transaction is out; its receipt is the keeper's to follow.
   * False rather than throwing when the call would revert, or one for the
   * same lobby is still pending: locking is permissionless, so another caller
   * winning the race is an ordinary outcome and the next poll reads the
   * truth either way.
   */
  lockMatch(matchId: `0x${string}`): Promise<boolean>;
  /**
   * The ranking a proposed result would pay, from its `ResultProposed` event.
   * The fallback for a result this server's archive does not hold: a scan
   * from the deploy block.
   */
  proposedRanking(matchId: `0x${string}`): Promise<readonly Address[] | null>;
  /**
   * Pays out a proposed result whose challenge window has closed. Like
   * `lockMatch`, permissionless and reported rather than thrown.
   */
  finalize(matchId: `0x${string}`, ranking: readonly Address[]): Promise<boolean>;
  /** Refunds a match past its deadline. Permissionless; reported, not thrown. */
  cancelMatch(matchId: `0x${string}`): Promise<boolean>;
}

export interface ViemEscrowReaderOptions {
  rpcUrl: string;
  chainId: number;
  escrow: Address;
  /** Sends the permissionless keeper calls. Without it, nothing is locked, finalised or cancelled here. */
  keeper?: TxSender;
  /** The escrow's deploy block, from the registry: where a scan for a match's events starts. */
  fromBlock?: bigint;
}

/** Multicall3, at the same address on every chain that has it: Base, Base Sepolia, and any fork of them. */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

/** Calldata per multicall request, in bytes: about fifty matches, three calls each. */
const MULTICALL_BYTES = 16_384;

/** The production reader: viem against a real RPC. */
export function viemEscrowReader(options: ViemEscrowReaderOptions): EscrowReader {
  const client = readClient(options.chainId, options.rpcUrl);
  const { escrow, keeper } = options;

  /** Sends `functionName(matchId, ...)` under its own in-flight key. */
  const keep = async (functionName: string, args: readonly unknown[]): Promise<boolean> => {
    if (!keeper) return false;
    const call: ContractCall = { address: escrow, abi: gameEscrowAbi, functionName, args };
    try {
      return (await keeper.send(`${functionName}:${String(args[0]).toLowerCase()}`, call)) !== null;
    } catch (error) {
      console.warn(`[chain] ${functionName} skipped:`, errorMessage(error));
      return false;
    }
  };

  let multicall: Promise<boolean> | null = null;
  const hasMulticall = () =>
    (multicall ??= client.getCode({ address: MULTICALL3 }).then(
      (code) => code !== undefined && code !== '0x',
      () => false,
    ));

  return {
    blockNumber: () => client.getBlockNumber(),

    async matchCreatedLogs(from, to) {
      const logs = await client.getContractEvents({
        address: escrow,
        abi: gameEscrowAbi,
        eventName: 'MatchCreated',
        fromBlock: from,
        toBlock: to,
      });
      return logs.flatMap((log) => (log.args.matchId ? [{ matchId: log.args.matchId }] : []));
    },

    async playerJoinedLogs(from, to) {
      const logs = await client.getContractEvents({
        address: escrow,
        abi: gameEscrowAbi,
        eventName: 'PlayerJoined',
        fromBlock: from,
        toBlock: to,
      });
      return logs.flatMap(({ args }) =>
        args.matchId && args.player && args.originChainId !== undefined
          ? [{ matchId: args.matchId, player: args.player, originChainId: Number(args.originChainId) }]
          : [],
      );
    },

    async getMatches(ids) {
      if (ids.length === 0) return [];
      const calls = ids.flatMap((matchId) => [
        { address: escrow, abi: gameEscrowAbi, functionName: 'getMatch', args: [matchId] } as const,
        { address: escrow, abi: gameEscrowAbi, functionName: 'getMatchTerms', args: [matchId] } as const,
        { address: escrow, abi: gameEscrowAbi, functionName: 'getSeats', args: [matchId] } as const,
      ]);
      // A chain without Multicall3 (a bare local anvil) is read call by call.
      const results: unknown[] = (await hasMulticall())
        ? await client.multicall({ contracts: calls, allowFailure: false, multicallAddress: MULTICALL3, batchSize: MULTICALL_BYTES })
        : await Promise.all(calls.map((call) => client.readContract(call as Parameters<typeof client.readContract>[0])));
      return ids.map((_, i) => {
        const info = results[i * 3] as MatchInfoRead;
        const terms = results[i * 3 + 1] as { minSeats: number; rulesHash: `0x${string}` };
        return {
          match: {
            stake: info.stake,
            minSeats: terms.minSeats,
            maxSeats: info.maxSeats,
            seatCount: info.seatCount,
            status: info.status,
            joinDeadline: BigInt(info.joinDeadline),
            rulesHash: terms.rulesHash,
            seed: info.seed,
            deadline: BigInt(info.deadline),
            rankingHash: info.rankingHash,
            matchmade: info.matchmade,
          },
          seats: results[i * 3 + 2] as readonly Address[],
        };
      });
    },

    async seatOrigin(matchId, player) {
      const origin = await client.readContract({
        address: escrow,
        abi: gameEscrowAbi,
        functionName: 'seatOrigin',
        args: [matchId, player],
      });
      return Number(origin);
    },

    async proposedRanking(matchId) {
      const head = await client.getBlockNumber();
      const logs = await chunkedLogs(options.fromBlock ?? 0n, head, (fromBlock, toBlock) =>
        client.getContractEvents({ address: escrow, abi: gameEscrowAbi, eventName: 'ResultProposed', args: { matchId }, fromBlock, toBlock }),
      );
      return logs[logs.length - 1]?.args.ranking ?? null;
    },

    cancelMatch: (matchId) => keep('cancelMatch', [matchId]),
    finalize: (matchId, ranking) => keep('finalize', [matchId, [...ranking]]),
    lockMatch: (matchId) => keep('lockMatch', [matchId]),
  };
}

/** The `getMatch` fields read here. */
interface MatchInfoRead {
  stake: bigint;
  maxSeats: number;
  seatCount: number;
  status: number;
  joinDeadline: number;
  seed: `0x${string}`;
  deadline: number;
  rankingHash: `0x${string}`;
  matchmade: boolean;
}
