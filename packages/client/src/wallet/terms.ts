import type { Address } from 'viem';
import { gameEscrowAbi, protocolConfigAbi } from '@lms/contracts';
import type { ProtocolTerms } from '../ui/views.js';
import type { Wallet } from './wallet.js';

/**
 * What a new lobby is opened on, read from `ProtocolConfig` through the
 * escrow: the fee, the payout schedule, the stakes allowed and the challenge
 * window. Each lobby keeps the terms it opened with, so these describe the
 * next one (the matchmaker's tables, the create form), not every open one.
 */
export async function protocolTerms(wallet: Wallet, escrow: Address): Promise<ProtocolTerms> {
  const config = await wallet.rpc.readContract({ address: escrow, abi: gameEscrowAbi, functionName: 'config' });
  const at = { address: config, abi: protocolConfigAbi } as const;
  const [params, schedule, challengeWindow] = await Promise.all([
    wallet.rpc.readContract({ ...at, functionName: 'getParams' }),
    wallet.rpc.readContract({ ...at, functionName: 'getPayoutSchedule' }),
    wallet.rpc.readContract({ ...at, functionName: 'challengeWindow' }),
  ]);
  return {
    feeBps: params.feeBps,
    payoutBps: [...schedule],
    minStake: params.minStake,
    maxStake: params.maxStake,
    challengeWindow: Number(challengeWindow),
  };
}
