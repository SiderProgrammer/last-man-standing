import { hashTypedData, type Address, type Hex } from 'viem';

/**
 * The digest a session key signs to authorise one relayed call through
 * `SessionKeyDelegate`. Which calls a key may make, and how they are encoded,
 * is `@lms/contracts`' `session.ts`.
 */

/** One call a session key authorises a relayer to submit. */
export interface SessionCallParams {
  /** The delegating account. It is the EIP-712 verifying contract, not the delegate. */
  account: Address;
  chainId: number;
  target: Address;
  value: bigint;
  data: Hex;
  nonce: bigint;
}

/**
 * One relayed call, as arguments for `signTypedData`.
 *
 * The verifying contract is the *account*, never the delegate: under EIP-7702
 * the delegate's code runs as the account, so a digest naming the shared
 * implementation would be equally valid against every player who delegated to
 * it.
 */
export function sessionCallTypedData(params: SessionCallParams) {
  return {
    domain: {
      name: 'LastManStandingSession',
      version: '2',
      chainId: params.chainId,
      verifyingContract: params.account,
    },
    types: {
      SessionCall: [
        { name: 'target', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    primaryType: 'SessionCall' as const,
    message: { target: params.target, value: params.value, data: params.data, nonce: params.nonce },
  };
}

/**
 * The digest a session key signs to authorise one relayed call.
 *
 * Must match `SessionKeyDelegate._hashTypedData` byte for byte, and is pinned
 * against it by a frozen vector on both sides — the same arrangement the commit
 * hashes use. A drift here would not corrupt a match, but every relayed call
 * would silently fail to recover the session key and players would be sent back
 * to signing in their wallets with no explanation.
 */
export function sessionCallDigest(params: SessionCallParams): Hex {
  return hashTypedData(sessionCallTypedData(params));
}
