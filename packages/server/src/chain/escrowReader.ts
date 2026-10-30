import type { Address } from 'viem';
import { errorMessage, gameEscrowAbi } from '@lms/protocol';
import { readClient, signerClients } from './viem.js';

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
   * Locks a lobby, or reports why it could not.
   *
   * Returns false rather than throwing when the call reverts: locking is
   * permissionless, so another caller winning the race is an ordinary outcome
   * and the next poll reads the truth either way.
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
  /** Funds the permissionless `lockMatch` call. Without it, nothing is locked here. */
  keeperKey?: `0x${string}`;
}

/** The production reader: viem against a real RPC. */
export function viemEscrowReader(options: ViemEscrowReaderOptions): EscrowReader {
  const signer = options.keeperKey
    ? signerClients(options.keeperKey, options.chainId, options.rpcUrl)
    : null;
  const client = signer?.publicClient ?? readClient(options.chainId, options.rpcUrl);
  const escrow = options.escrow;

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

    async cancelMatch(matchId) {
      if (!signer) return false;
      try {
        const { request } = await client.simulateContract({
          account: signer.account,
          address: escrow,
          abi: gameEscrowAbi,
          functionName: 'cancelMatch',
          args: [matchId],
        });
        await signer.walletClient.writeContract(request);
        return true;
      } catch (error) {
        console.warn('[chain] cancel skipped:', errorMessage(error));
        return false;
      }
    },

    async finalize(matchId, ranking) {
      if (!signer) return false;
      try {
        const { request } = await client.simulateContract({
          account: signer.account,
          address: escrow,
          abi: gameEscrowAbi,
          functionName: 'finalize',
          args: [matchId, [...ranking]],
        });
        await signer.walletClient.writeContract(request);
        return true;
      } catch (error) {
        console.warn('[chain] finalize skipped:', errorMessage(error));
        return false;
      }
    },

    async lockMatch(matchId) {
      if (!signer) return false;
      try {
        const { request } = await client.simulateContract({
          account: signer.account,
          address: escrow,
          abi: gameEscrowAbi,
          functionName: 'lockMatch',
          args: [matchId],
        });
        await signer.walletClient.writeContract(request);
        return true;
      } catch (error) {
        // Another caller may have locked it first; the next poll reads the truth.
        console.warn('[chain] lock skipped:', errorMessage(error));
        return false;
      }
    },
  };
}
