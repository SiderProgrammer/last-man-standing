import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  stringToHex,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem';
import { sameAddress } from '../util/address.js';
import { gameEscrowAbi, sessionKeyDelegateAbi } from './abis.js';

/**
 * The `SessionKeyDelegate` surface, shared by the server and the client.
 *
 * Calls are addressed to the *player's own address*, not to the delegate: under
 * EIP-7702 the delegate holds the code while the account holds the storage, so
 * every one of these functions reads and writes state belonging to the account
 * that delegated.
 */
export { sessionKeyDelegateAbi };


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

/**
 * What a session may do for the account, as the client asks the delegate to
 * grant it. Both caps are per grant, and the grant lasts no longer than the
 * key's login grant: a day.
 */
export const ONE_CLICK_CAPS = {
  /** Most one join may stake. */
  valueCap: 50_000_000_000_000_000n,
  /** Most the key may stake in total before the player grants it again. */
  spendCap: 250_000_000_000_000_000n,
} as const;

/** A call a session key signed, as it crosses the wire. Amounts in decimal wei. */
export interface RelayedCall {
  target: Address;
  value: string;
  data: Hex;
  nonce: string;
  signature: Hex;
}

/** The two calls a session key may make. */
export type SessionCallKind = 'join' | 'withdrawFor';

const JOIN_SELECTOR = toFunctionSelector('join(bytes32)');
const WITHDRAW_FOR_SELECTOR = toFunctionSelector('withdrawFor(address)');

/** `join(matchId)` with the stake, for a session key to sign. */
export function joinCall(escrow: Address, matchId: Hex, stake: bigint): Pick<SessionCallParams, 'target' | 'value' | 'data'> {
  return { target: escrow, value: stake, data: encodeFunctionData({ abi: gameEscrowAbi, functionName: 'join', args: [matchId] }) };
}

/** `withdrawFor(account)`, which pays the account its winnings. */
export function withdrawForCall(escrow: Address, account: Address): Pick<SessionCallParams, 'target' | 'value' | 'data'> {
  return {
    target: escrow,
    value: 0n,
    data: encodeFunctionData({ abi: gameEscrowAbi, functionName: 'withdrawFor', args: [account] }),
  };
}

/**
 * Which of the two permitted calls this is, or null when the delegate would
 * refuse it. Mirrors `SessionKeyDelegate._checkCall`, so a relayer turns a
 * call away before it pays to simulate it.
 */
export function sessionCallKind(
  call: Pick<SessionCallParams, 'target' | 'value' | 'data'>,
  scope: { escrow: Address; account: Address },
): SessionCallKind | null {
  if (!sameAddress(call.target, scope.escrow)) return null;
  // Four bytes of selector and one word of argument, as hex.
  if (call.data.length !== 2 + 2 * 36) return null;
  const selector = call.data.slice(0, 10).toLowerCase();
  if (selector === JOIN_SELECTOR) return 'join';
  if (selector === WITHDRAW_FOR_SELECTOR && call.value === 0n) {
    const named = decodeFunctionData({ abi: gameEscrowAbi, data: call.data });
    return named.functionName === 'withdrawFor' && sameAddress(named.args[0], scope.account) ? 'withdrawFor' : null;
  }
  return null;
}

/** The 23 bytes of code EIP-7702 gives an account that delegated to `delegate`. */
export function delegationCode(delegate: Address): Hex {
  return `0xef0100${delegate.slice(2).toLowerCase()}`;
}

/** True when `code` is a 7702 delegation to `delegate`. */
export function isDelegatedTo(code: Hex | undefined, delegate: Address): boolean {
  return (code ?? '0x').toLowerCase() === delegationCode(delegate);
}
