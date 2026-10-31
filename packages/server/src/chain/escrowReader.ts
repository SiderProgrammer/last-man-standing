import type { Address } from 'viem';
import { errorMessage, gameEscrowAbi } from '@lms/protocol';
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
  getMatch(matchId: `0x${string}`): Promise<EscrowMatch>;
  getSeats(matchId: `0x${string}`): Promise<readonly Address[]>;
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
  /** The ranking a proposed result would pay, from its `ResultProposed` event. */
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
}

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

    async getMatch(matchId) {
      const [info, terms] = await Promise.all([
        client.readContract({ address: escrow, abi: gameEscrowAbi, functionName: 'getMatch', args: [matchId] }),
        client.readContract({ address: escrow, abi: gameEscrowAbi, functionName: 'getMatchTerms', args: [matchId] }),
      ]);
      return {
        stake: info.stake,
        minSeats: terms.minSeats,
        maxSeats: info.maxSeats,
        seatCount: info.seatCount,
        status: info.status,
        joinDeadline: BigInt(info.joinDeadline),
        rulesHash: terms.rulesHash,
        seed: info.seed,
        deadline: BigInt(info.deadline),
      };
    },

    async getSeats(matchId) {
      return client.readContract({
        address: escrow,
        abi: gameEscrowAbi,
        functionName: 'getSeats',
        args: [matchId],
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
      const logs = await client.getContractEvents({
        address: escrow,
        abi: gameEscrowAbi,
        eventName: 'ResultProposed',
        args: { matchId },
        fromBlock: 0n,
      });
      return logs[logs.length - 1]?.args.ranking ?? null;
    },

    cancelMatch: (matchId) => keep('cancelMatch', [matchId]),
    finalize: (matchId, ranking) => keep('finalize', [matchId, [...ranking]]),
    lockMatch: (matchId) => keep('lockMatch', [matchId]),
  };
}
