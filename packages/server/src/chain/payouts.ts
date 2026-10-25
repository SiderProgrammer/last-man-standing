import type { Address, Hex } from 'viem';
import { gameEscrowAbi } from '@lms/protocol';
import { signerClients } from './viem.js';

/**
 * Pushes a player's escrow balance to them, paying the gas.
 *
 * The one transaction the server still sends on a player's behalf. Joins,
 * mints and every other call are the player's own: the hub is Ethereum L1,
 * and relaying them would mean the server paying L1 gas for each one. A payout
 * is the exception because a player who staked from a spoke may hold no gas on
 * the hub at all, and `withdrawFor` is cheap and bounded — it only ever pays
 * the account itself, and only what it is owed, so each credit can be pushed
 * once and a repeat costs nothing but a failed simulation.
 *
 * An interface with a null default, matching how the messenger and the
 * randomness oracle are handled in this codebase.
 */
export interface PayoutPusher {
  readonly enabled: boolean;
  /**
   * Pushes `account`'s escrow balance to `account` through `withdrawFor`.
   * No signature is needed: the escrow only ever pays the account itself, so
   * the worst a caller can do is pay a player early, at the server's expense.
   */
  collect(account: Address): Promise<Hex>;
}

/** Refuses, so players withdraw through their own wallet. */
export const nullPayoutPusher: PayoutPusher = {
  enabled: false,
  collect() {
    return Promise.reject(new Error('this server does not push payouts'));
  },
};

export interface PayoutPusherOptions {
  rpcUrl: string;
  chainId: number;
  /** Key that pays the gas. Holds no authority over any player's account. */
  keeperKey: Hex;
  escrow: Address;
}

export function createPayoutPusher(options: PayoutPusherOptions): PayoutPusher {
  const { account, publicClient, walletClient: wallet } = signerClients(
    options.keeperKey,
    options.chainId,
    options.rpcUrl,
  );

  return {
    enabled: true,
    async collect(target) {
      // Simulated first: an account with nothing owed reverts here with
      // `NothingToWithdraw`, so a spammed `collect` never costs any gas.
      const { request } = await publicClient.simulateContract({
        account,
        address: options.escrow,
        abi: gameEscrowAbi,
        functionName: 'withdrawFor',
        args: [target],
      });
      return wallet.writeContract(request);
    },
  };
}
