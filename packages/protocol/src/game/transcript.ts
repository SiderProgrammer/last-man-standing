import { keccak256, stringToHex } from 'viem';
import type { SeatProof, SignedGrant } from '../chain/moves.js';
import type { Rules } from './rules.js';
import type { MatchResult, RoundRecord, Seat } from './types.js';

/**
 * Everything needed to check a finished match without trusting the server:
 * the setup, every round as resolved, every signature behind every move, and
 * the grants that tie those signatures to the seated wallets.
 *
 * The server archives it before it settles, and `settle` carries its hash, so
 * the attestors sign over it and the escrow stores it. Anyone can then fetch
 * the transcript by that hash, check it hashes to it, and replay the match.
 */
export interface Transcript {
  version: typeof TRANSCRIPT_VERSION;
  matchId: `0x${string}`;
  /** The hub chain: the domain every move and receipt was signed under. */
  chainId: number;
  seed: `0x${string}`;
  rules: Rules;
  seats: Seat[];
  /** Seats the server's own bots played. Their moves are unsigned. Empty in a staked match. */
  botSeats: number[];
  /** The key that signed this match's commit receipts, or null if none were issued. */
  receiptSigner: `0x${string}` | null;
  /** Every grant a seat's moves were signed under. */
  grants: SignedGrant[];
  rounds: TranscriptRound[];
  /** The result the rounds produce, as the attestors signed it. */
  result: MatchResult;
}

export interface TranscriptRound {
  record: RoundRecord;
  /** The signatures behind every seat's commit and reveal, and when each commit was received. */
  proofs: SeatProof[];
}

export const TRANSCRIPT_VERSION = 1;

/**
 * JSON with object keys sorted at every level and no whitespace, so the same
 * transcript always serialises to the same bytes, whatever order a database
 * or a parser handed its keys back in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('canonical JSON has no non-finite numbers');
    if (value === undefined || typeof value === 'bigint' || typeof value === 'function') {
      throw new Error(`canonical JSON cannot hold a ${typeof value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => field !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`).join(',')}}`;
}

/** keccak256 of the canonical JSON: what `settle` carries and the escrow stores. */
export function hashTranscript(transcript: Transcript): `0x${string}` {
  return keccak256(stringToHex(canonicalJson(transcript)));
}
