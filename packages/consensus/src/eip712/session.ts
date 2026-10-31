import { encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from 'viem';

/**
 * The digest a session key signs to authorise one relayed call through
 * `SessionKeyDelegate`. Which calls a key may make, and how they are encoded,
 * is `@lms/contracts`' `session.ts`.
 */

const DOMAIN_TYPEHASH = keccak256(
  stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
);
const DOMAIN_NAME = keccak256(stringToHex('LastManStandingSession'));
const DOMAIN_VERSION = keccak256(stringToHex('2'));
const CALL_TYPEHASH = keccak256(
  stringToHex('SessionCall(address target,uint256 value,bytes data,uint256 nonce)'),
);

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
 * The digest a session key signs to authorise one relayed call.
 *
 * Mirrors `SessionKeyDelegate._hashTypedData` byte for byte, and is pinned
 * against it by a frozen vector on both sides — the same arrangement the commit
 * hashes use. A drift here would not corrupt a match, but every relayed call
 * would silently fail to recover the session key and players would be sent back
 * to signing in their wallets with no explanation.
 *
 * The verifying contract is the *account*, never the delegate: under EIP-7702
 * the delegate's code runs as the account, so a digest naming the shared
 * implementation would be equally valid against every player who delegated to
 * it.
 */
export function sessionCallDigest(params: SessionCallParams): Hex {
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [DOMAIN_TYPEHASH, DOMAIN_NAME, DOMAIN_VERSION, BigInt(params.chainId), params.account],
    ),
  );

  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'uint256' },
      ],
      [CALL_TYPEHASH, params.target, params.value, keccak256(params.data), params.nonce],
    ),
  );

  return keccak256(`0x1901${domainSeparator.slice(2)}${structHash.slice(2)}`);
}

/** The same call as `sessionCallDigest`, as arguments for `signTypedData`. */
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
