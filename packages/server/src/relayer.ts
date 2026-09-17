import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sessionKeyDelegateAbi } from '@lms/protocol';

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
  submit(call: SessionCall): Promise<Hex>;
}

/** Refuses everything, so the client falls back to the player's own wallet. */
export const nullSessionRelayer: SessionRelayer = {
  enabled: false,
  submit() {
    return Promise.reject(new Error('session relaying is not enabled on this server'));
  },
};

export interface ChainRelayerOptions {
  rpcUrl: string;
  chainId: number;
  /** Key that pays the gas. Holds no authority over any player's account. */
  relayerKey: Hex;
}

export function createSessionRelayer(options: ChainRelayerOptions): SessionRelayer {
  const chain = {
    id: options.chainId,
    name: `chain-${options.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [options.rpcUrl] } },
  } as const;

  const account = privateKeyToAccount(options.relayerKey);
  const publicClient: PublicClient = createPublicClient({ chain, transport: http(options.rpcUrl) });
  const wallet: WalletClient = createWalletClient({ account, chain, transport: http(options.rpcUrl) });

  return {
    enabled: true,
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
