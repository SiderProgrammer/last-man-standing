import type { Address, TypedDataDomain } from 'viem';
import { EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION } from './result.js';

/**
 * A player's instruction to bridge their whole hub balance to a chain and
 * address of their choosing, which a relayer submits to
 * `BridgeJoinReceiver.withdrawToChainFor`.
 */
export interface ChainWithdrawal {
  player: Address;
  /** The hub's chain id: the domain has none, so it is a field instead. */
  hubChainId: bigint;
  destinationChainId: bigint;
  recipient: Address;
  /** WETH on the destination. */
  outputToken: Address;
  /** The most of the balance Across may take, in wei. */
  maxFee: bigint;
  nonce: bigint;
  deadline: bigint;
}

export const WITHDRAWAL_TYPES = {
  Withdrawal: [
    { name: 'player', type: 'address' },
    { name: 'hubChainId', type: 'uint256' },
    { name: 'destinationChainId', type: 'uint256' },
    { name: 'recipient', type: 'address' },
    { name: 'outputToken', type: 'address' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

/**
 * No chain id, like the session grant's: a wallet on a spoke must be able to
 * sign it. The receiver's address and `hubChainId` bind it instead.
 */
export function withdrawalDomain(receiver: Address): TypedDataDomain {
  return { name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, verifyingContract: receiver };
}

/** The typed data a player signs for `withdrawal`, to `receiver` on the hub. */
export function withdrawalTypedData(receiver: Address, withdrawal: ChainWithdrawal) {
  return {
    domain: withdrawalDomain(receiver),
    types: WITHDRAWAL_TYPES,
    primaryType: 'Withdrawal',
    message: withdrawal,
  } as const;
}
