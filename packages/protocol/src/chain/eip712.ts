import type { TypedDataDomain } from 'viem';
import type { MatchResult } from '../game/types.js';

export const EIP712_DOMAIN_NAME = 'LastManStanding';
export const EIP712_DOMAIN_VERSION = '1';

/**
 * Typed-data schema the attestor set signs to move an off-chain result
 * on-chain. Keep in sync with `GameEscrow`'s type hashes.
 */
export const MATCH_RESULT_TYPES = {
  MatchResult: [
    { name: 'matchId', type: 'bytes32' },
    { name: 'rounds', type: 'uint32' },
    { name: 'historyRoot', type: 'bytes32' },
    { name: 'ranking', type: 'address[]' },
  ],
} as const;

export function matchResultDomain(
  chainId: number,
  verifyingContract: `0x${string}`,
): TypedDataDomain {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  };
}

/** Payload shape expected by `signTypedData`. */
export function matchResultMessage(result: MatchResult) {
  return {
    matchId: result.matchId,
    rounds: result.rounds,
    historyRoot: result.historyRoot,
    ranking: result.ranking,
  };
}
