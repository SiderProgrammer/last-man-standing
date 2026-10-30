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
    { name: 'transcriptHash', type: 'bytes32' },
    { name: 'ranking', type: 'address[]' },
  ],
} as const;

/**
 * A result as the attestors sign it: the engine's result, plus the hash of
 * the archived transcript it came from (`hashTranscript`). Signing the hash
 * is what makes the archive part of the result: the escrow stores it, and a
 * transcript that does not hash to it is not this match's.
 */
export interface AttestedResult extends MatchResult {
  transcriptHash: `0x${string}`;
}

/**
 * What the attestor quorum signs to abort a live match the server can no
 * longer finish. `GameEscrow.abortMatch` refunds every seat on it.
 */
export const MATCH_ABORT_TYPES = {
  MatchAbort: [{ name: 'matchId', type: 'bytes32' }],
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
export function matchResultMessage(result: AttestedResult) {
  return {
    matchId: result.matchId,
    rounds: result.rounds,
    historyRoot: result.historyRoot,
    transcriptHash: result.transcriptHash,
    ranking: result.ranking,
  };
}
