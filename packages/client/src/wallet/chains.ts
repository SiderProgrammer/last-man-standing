import { defineChain, type Chain } from 'viem';
import { chainInfo } from '@lms/protocol';

/**
 * The viem chain for `chainId`, named as the rest of the client names it.
 *
 * Passed to every write, so viem checks the wallet is on that chain at the
 * moment it signs, and to `wallet_addEthereumChain` when a wallet has never
 * heard of it. Built rather than imported from `viem/chains`, which would put
 * every chain viem knows into the bundle for the handful this game uses.
 */
export function viemChain(chainId: number): Chain {
  const info = chainInfo(chainId);
  return defineChain({
    id: chainId,
    name: info.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: info.rpcUrl ? [info.rpcUrl] : [] } },
    testnet: info.testnet,
  });
}

/**
 * The wallet is on one chain and the action needs another, and it could not
 * be switched: the wallet cannot switch (a burner signs for one node), or the
 * player declined.
 */
export class WrongChainError extends Error {
  constructor(
    readonly current: number,
    readonly wanted: number,
    reason = 'Switch networks in your wallet and try again.',
  ) {
    super(`Your wallet is on ${chainInfo(current).name}; this needs ${chainInfo(wanted).name}. ${reason}`);
    this.name = 'WrongChainError';
  }
}
