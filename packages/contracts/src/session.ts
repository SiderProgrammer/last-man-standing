import { decodeFunctionData, encodeFunctionData, toFunctionSelector, type Address, type Hex } from 'viem';
import { sameAddress, type SessionCallParams } from '@lms/consensus';
import { gameEscrowAbi, sessionKeyDelegateAbi } from './abis.js';

/**
 * The `SessionKeyDelegate` surface, shared by the server and the client.
 *
 * Calls are addressed to the *player's own address*, not to the delegate: under
 * EIP-7702 the delegate holds the code while the account holds the storage, so
 * every one of these functions reads and writes state belonging to the account
 * that delegated. The digest a session key signs is `@lms/consensus`'s
 * `sessionCallDigest`.
 */
export { sessionKeyDelegateAbi };

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
