import type { Address, Hex } from 'viem';
import { gameEscrowAbi, sessionKeyDelegateAbi } from '@lms/protocol';
import { signerClients } from './viem.js';

/** One call a player's session key has authorised. */
export interface SessionCall {
  account: Address;
  target: Address;
  value: bigint;
  data: Hex;
  nonce: bigint;
  signature: Hex;
}

/**
 * Submits calls that players' session keys authorised.
 *
 * This is the piece that turns a session key into "no wallet prompt": the key
 * signs, somebody else pays the gas and sends the transaction. Deliberately an
 * interface with a null default, matching how the messenger and the randomness
 * oracle are handled in this codebase — a real deployment can put a 4337 bundler
 * or a dedicated relayer service behind it without the client noticing.
 *
 * The server is *not* trusted here. It cannot change the call, because the
 * signature covers the target, value, data and nonce; it cannot replay one,
 * because the delegate tracks a nonce per account; and it cannot exceed the
 * player's scope, because the delegate enforces the allowlist and spend cap
 * on-chain. The worst it can do is refuse to submit, which costs the player
 * nothing but the fallback of sending the transaction themselves.
 */
export interface SessionRelayer {
  readonly enabled: boolean;
  /** True when `collect` can push payouts; needs the escrow address. */
  readonly canCollect: boolean;
  submit(call: SessionCall): Promise<Hex>;
  /**
   * Pushes `account`'s escrow balance to `account` through `withdrawFor`.
   * No signature is needed: the escrow only ever pays the account itself, so
   * the worst a caller can do is pay a player early, at the relayer's expense.
   */
  collect(account: Address): Promise<Hex>;
}

/** Refuses everything, so the client falls back to the player's own wallet. */
export const nullSessionRelayer: SessionRelayer = {
  enabled: false,
  canCollect: false,
  submit() {
    return Promise.reject(new Error('session relaying is not enabled on this server'));
  },
  collect() {
    return Promise.reject(new Error('this server does not push payouts'));
  },
};

export interface ChainRelayerOptions {
  rpcUrl: string;
  chainId: number;
  /** Key that pays the gas. Holds no authority over any player's account. */
  relayerKey: Hex;
  /** Hub escrow, for `collect`. Omitted, payouts are left to the players. */
  escrow?: Address;
}

export function createSessionRelayer(options: ChainRelayerOptions): SessionRelayer {
  const { account, publicClient, walletClient: wallet } = signerClients(
    options.relayerKey,
    options.chainId,
    options.rpcUrl,
  );

  return {
    enabled: true,
    canCollect: options.escrow !== undefined,
    async collect(target) {
      const escrow = options.escrow;
      if (!escrow) throw new Error('this server does not push payouts');
      // Simulated first: an account with nothing owed reverts here with
      // `NothingToWithdraw`, so a spammed `collect` never costs any gas.
      const { request } = await publicClient.simulateContract({
        account,
        address: escrow,
        abi: gameEscrowAbi,
        functionName: 'withdrawFor',
        args: [target],
      });
      return wallet.writeContract(request);
    },
    async submit(call) {
      // Simulated first so a call outside the session's scope is rejected with
      // the delegate's own error, before any gas is spent on it.
      const { request } = await publicClient.simulateContract({
        account,
        address: call.account,
        abi: sessionKeyDelegateAbi,
        functionName: 'executeWithSession',
        args: [call.target, call.value, call.data, call.nonce, call.signature],
        // No value attached on purpose: the stake comes out of the player's own
        // account balance, which is what the session's spend cap meters. The
        // relayer pays gas and nothing else.
      });
      return wallet.writeContract(request);
    },
  };
}
