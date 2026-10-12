import {
  encodeAbiParameters,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';

/**
 * The `SessionKeyDelegate` surface, shared by the server and the client.
 *
 * Calls are addressed to the *player's own address*, not to the delegate: under
 * EIP-7702 the delegate holds the code while the account holds the storage, so
 * every one of these functions reads and writes state belonging to the account
 * that delegated.
 */
export const sessionKeyDelegateAbi = parseAbi([
  'function grantSession(address sessionKey, uint48 validUntil, uint128 spendCap, address[] targets, bytes4[] selectors)',
  'function revokeSession(address sessionKey)',
  'function sessionActive(address sessionKey) view returns (bool)',
  'function sessions(address sessionKey) view returns (uint48 validUntil, uint128 spendCap, uint128 spent)',
  'function sessionNonce() view returns (uint256)',
  'function permitted(address sessionKey, address target, bytes4 selector) view returns (bool)',
  'function callDigest(address target, uint256 value, bytes data, uint256 nonce) view returns (bytes32)',
  'function executeWithSession(address target, uint256 value, bytes data, uint256 nonce, bytes signature) payable returns (bytes)',
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
  'event SessionGranted(address indexed sessionKey, uint48 validUntil, uint128 spendCap)',
  'event SessionRevoked(address indexed sessionKey)',
]);


const DOMAIN_TYPEHASH = keccak256(
  stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
);
const DOMAIN_NAME = keccak256(stringToHex('LastManStandingSession'));
const DOMAIN_VERSION = keccak256(stringToHex('1'));
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
