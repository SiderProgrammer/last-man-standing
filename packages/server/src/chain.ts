import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { DEFAULT_RULES, type Seat } from '@lms/protocol';
import type { MatchSetup } from '@lms/engine';
import { gameEscrowAbi } from './abi.js';
import type { Lobby } from './lobby.js';

export interface ChainWatcherOptions {
  rpcUrl: string;
  chainId: number;
  escrow: Address;
  lobby: Lobby;
}

/**
 * Bridges the escrow to the game server.
 *
 * A room is only opened once `MatchStarted` fires, which is the moment the
 * randomness oracle has delivered a seed for a locked seat list. The seat
 * order on-chain is the seat order in the engine, so the ranking the server
 * signs can be checked against `getSeats` without any extra mapping.
 */
export function watchChain(options: ChainWatcherOptions): () => void {
  const chain = {
    id: options.chainId,
    name: `chain-${options.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [options.rpcUrl] } },
  } as const;

  const client: PublicClient = createPublicClient({ chain, transport: http(options.rpcUrl) });

  return client.watchContractEvent({
    address: options.escrow,
    abi: gameEscrowAbi,
    eventName: 'MatchStarted',
    onLogs: (logs) => {
      for (const log of logs) {
        const matchId = log.args.matchId;
        const seed = log.args.seed;
        if (!matchId || !seed) continue;
        void openRoom(client, options, matchId, seed).catch((error: unknown) => {
          console.error('[chain] failed to open room', matchId, describe(error));
        });
      }
    },
  });
}

async function openRoom(
  client: PublicClient,
  options: ChainWatcherOptions,
  matchId: `0x${string}`,
  seed: `0x${string}`,
): Promise<void> {
  const addresses = await client.readContract({
    address: options.escrow,
    abi: gameEscrowAbi,
    functionName: 'getSeats',
    args: [matchId],
  });

  const seats: Seat[] = await Promise.all(
    addresses.map(async (address, index) => {
      const origin = await client.readContract({
        address: options.escrow,
        abi: gameEscrowAbi,
        functionName: 'seatOrigin',
        args: [matchId, address],
      });
      // Origin zero means the player staked on the hub chain itself.
      return { index, address, chainId: origin === 0 ? options.chainId : Number(origin) };
    }),
  );

  const setup: MatchSetup = { matchId, seats, seed, rules: DEFAULT_RULES };
  options.lobby.adopt(setup);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
