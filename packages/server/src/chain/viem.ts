import { createPublicClient, http, type Chain, type PublicClient } from 'viem';

/**
 * viem client construction for a chain known only by id and RPC URL.
 *
 * The server talks to whatever chain it is pointed at, so it cannot import a
 * chain definition from `viem/chains` — the hub may be an Anvil fork or a
 * testnet that viem has never heard of. It describes the chain from config
 * instead. This file is the one place that describes it.
 *
 * The description is deliberately minimal: viem needs an id for EIP-155
 * signing and an RPC URL to reach, and everything else here is filler it never
 * reads on these paths.
 */
export function rpcChain(chainId: number, rpcUrl: string): Chain {
  return {
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

/** Read-only client for a chain described by id and RPC URL. */
export function readClient(chainId: number, rpcUrl: string): PublicClient {
  return createPublicClient({ chain: rpcChain(chainId, rpcUrl), transport: http(rpcUrl) });
}
