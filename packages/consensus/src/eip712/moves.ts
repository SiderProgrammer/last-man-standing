import type { TypedDataDomain } from 'viem';
import { Action, type ActionValue } from '../game/types.js';
import { EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION } from './result.js';

/**
 * What players and the server sign about play itself, as opposed to what the
 * attestors sign about its result (`eip712.ts`).
 *
 * A player's wallet signs one `SessionGrant`, which names a key held in the
 * browser. That key then signs every commit and every reveal, so a move in the
 * transcript is one the player provably made: the server can drop a move, but
 * it cannot make one up or alter one. None of this is checked on-chain; the
 * server checks it as moves arrive, and the browser and the guardian check it
 * again from the archived transcript.
 */

/**
 * A grant. No chain id in the domain, on purpose: wallets refuse to sign typed
 * data whose domain names another chain than the one they are on, and a player
 * whose wallet sits on a spoke must still be able to log in. The chain is a
 * field of the grant instead, and the server checks it.
 */
export const GRANT_DOMAIN: TypedDataDomain = {
  name: EIP712_DOMAIN_NAME,
  version: EIP712_DOMAIN_VERSION,
};

/**
 * Commits, reveals and receipts. Signed by keys the browser and server hold
 * themselves, never by a wallet, so the chain id can be in the domain.
 */
export function playDomain(chainId: number): TypedDataDomain {
  return { name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, chainId };
}

/** The longest a grant may run. A leaked key is worth no more than this. */
export const MAX_GRANT_SECONDS = 7 * 24 * 60 * 60;

/** How far in the future a grant's `issuedAt` may be, for clocks that drift. */
export const GRANT_CLOCK_SKEW_SECONDS = 5 * 60;

/**
 * Shaped like a Sign-In with Ethereum message, so a wallet that understands
 * SIWE binds it to the site asking for it: `domain` and `uri` name the origin.
 */
export const SESSION_GRANT_TYPES = {
  SessionGrant: [
    { name: 'wallet', type: 'address' },
    { name: 'sessionKey', type: 'address' },
    { name: 'domain', type: 'string' },
    { name: 'uri', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export interface SessionGrant {
  /** The account that stakes, and whose seat the key plays. */
  wallet: `0x${string}`;
  /** The browser-held key that signs logins and moves. */
  sessionKey: `0x${string}`;
  /** Host of the page that asked for the grant, e.g. `play.example.com`. */
  domain: string;
  /** Origin of that page, e.g. `https://play.example.com`. */
  uri: string;
  /** The hub chain. */
  chainId: number;
  /** Unix seconds. */
  issuedAt: number;
  /** Unix seconds. */
  expiresAt: number;
  /** Random, so two grants for the same key never collide. */
  nonce: `0x${string}`;
}

export interface SignedGrant {
  grant: SessionGrant;
  /** The wallet's signature over `grantTypedData(grant)`. */
  signature: `0x${string}`;
}

/** Arguments for `signTypedData` / `verifyTypedData` over a grant. */
export function grantTypedData(grant: SessionGrant) {
  return {
    domain: GRANT_DOMAIN,
    types: SESSION_GRANT_TYPES,
    primaryType: 'SessionGrant' as const,
    message: {
      wallet: grant.wallet,
      sessionKey: grant.sessionKey,
      domain: grant.domain,
      uri: grant.uri,
      chainId: BigInt(grant.chainId),
      issuedAt: BigInt(grant.issuedAt),
      expiresAt: BigInt(grant.expiresAt),
      nonce: grant.nonce,
    },
  };
}

/**
 * Why a grant cannot be used now, or null if it can. Covers everything but
 * the signature, which needs a verifier.
 *
 * @param origins Origins the grant may name. Empty accepts any, as a server
 *        with no `ALLOWED_ORIGINS` accepts any connection.
 */
export function grantProblem(
  grant: SessionGrant,
  expected: { chainId: number; now: number; origins?: readonly string[] },
): string | null {
  if (grant.chainId !== expected.chainId) return `the grant is for chain ${grant.chainId}, not ${expected.chainId}`;
  if (grant.issuedAt > expected.now + GRANT_CLOCK_SKEW_SECONDS) return 'the grant is issued in the future';
  if (grant.expiresAt <= expected.now) return 'the grant has expired';
  if (grant.expiresAt - grant.issuedAt > MAX_GRANT_SECONDS) return 'the grant runs for longer than a week';
  const origins = expected.origins ?? [];
  if (origins.length > 0 && !origins.includes(grant.uri)) return `the grant names an origin this server does not serve: ${grant.uri}`;
  if (!grantDomainMatches(grant)) return 'the grant\'s domain is not the host of its uri';
  return null;
}

function grantDomainMatches(grant: SessionGrant): boolean {
  try {
    return new URL(grant.uri).host === grant.domain;
  } catch {
    return false;
  }
}

export const COMMIT_TYPES = {
  Commit: [
    { name: 'matchId', type: 'bytes32' },
    { name: 'round', type: 'uint32' },
    { name: 'seat', type: 'uint8' },
    { name: 'commitment', type: 'bytes32' },
  ],
} as const;

export const REVEAL_TYPES = {
  Reveal: [
    { name: 'matchId', type: 'bytes32' },
    { name: 'round', type: 'uint32' },
    { name: 'seat', type: 'uint8' },
    { name: 'action', type: 'uint8' },
    { name: 'target', type: 'uint8' },
    { name: 'salt', type: 'bytes32' },
  ],
} as const;

/** Which match, round and seat a signed move is for. */
export interface MovePlace {
  matchId: `0x${string}`;
  round: number;
  seat: number;
}

/** Arguments for `signTypedData` / `verifyTypedData` over a commit. */
export function commitTypedData(chainId: number, place: MovePlace, commitment: `0x${string}`) {
  return {
    domain: playDomain(chainId),
    types: COMMIT_TYPES,
    primaryType: 'Commit' as const,
    message: { matchId: place.matchId, round: place.round, seat: place.seat, commitment },
  };
}

/**
 * Arguments for `signTypedData` / `verifyTypedData` over a reveal. The target
 * is zero for every action but Strike, as in the commitment.
 */
export function revealTypedData(
  chainId: number,
  place: MovePlace,
  move: { action: ActionValue; target: number; salt: `0x${string}` },
) {
  return {
    domain: playDomain(chainId),
    types: REVEAL_TYPES,
    primaryType: 'Reveal' as const,
    message: {
      matchId: place.matchId,
      round: place.round,
      seat: place.seat,
      action: move.action,
      target: move.action === Action.Strike ? move.target : 0,
      salt: move.salt,
    },
  };
}

export const COMMIT_RECEIPT_TYPES = {
  CommitReceipt: [
    { name: 'matchId', type: 'bytes32' },
    { name: 'round', type: 'uint32' },
    { name: 'seat', type: 'uint8' },
    { name: 'commitment', type: 'bytes32' },
    { name: 'receivedAt', type: 'uint64' },
  ],
} as const;

/**
 * The server's word that it took a commitment, and when. A player holding
 * one can prove the server had their move: if the transcript then leaves the
 * commitment out, or records the seat as not revealing when it did, the
 * receipt is the evidence for a dispute.
 */
export interface CommitReceipt extends MovePlace {
  commitment: `0x${string}`;
  /** Unix milliseconds, by the server's clock. */
  receivedAt: number;
}

/** Arguments for `signTypedData` / `verifyTypedData` over a receipt. */
export function receiptTypedData(chainId: number, receipt: CommitReceipt) {
  return {
    domain: playDomain(chainId),
    types: COMMIT_RECEIPT_TYPES,
    primaryType: 'CommitReceipt' as const,
    message: {
      matchId: receipt.matchId,
      round: receipt.round,
      seat: receipt.seat,
      commitment: receipt.commitment,
      receivedAt: BigInt(receipt.receivedAt),
    },
  };
}

/**
 * Signatures behind one seat's play in one round. Not part of the round hash:
 * each signs data the hash already covers, and the transcript hash covers
 * them in turn.
 */
export interface SeatProof {
  index: number;
  /** The seat's session key over `Commit`. Null for a house bot, or a seat that did not commit. */
  commitSignature: `0x${string}` | null;
  /** The seat's session key over `Reveal`. Null for a house bot, or a seat that did not reveal. */
  revealSignature: `0x${string}` | null;
  /**
   * When the server took the commit, as its receipt says. With the seat's
   * commitment it is the whole receipt, so a receipt a player holds can be
   * matched to this entry. Null for a house bot, or a seat that did not commit.
   */
  receivedAt: number | null;
}
