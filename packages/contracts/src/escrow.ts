import { gameEscrowAbi } from './abis.js';

/**
 * The `GameEscrow` surface shared by the server and the browser client.
 *
 * Both sides have to agree with the deployed contract exactly, so there is
 * one copy of the interface and not one per consumer.
 */
export { gameEscrowAbi };

/** Mirrors `GameEscrow.MatchStatus`. */
export const MatchStatus = {
  None: 0,
  Open: 1,
  Pending: 2,
  Live: 3,
  /** Signed and published; pays out once the challenge window closes unvetoed. */
  Proposed: 4,
  Settled: 5,
  Cancelled: 6,
} as const;

export type MatchStatusValue = (typeof MatchStatus)[keyof typeof MatchStatus];

/**
 * Mirrors `Constants.sol`'s `LOCK_GRACE`, in seconds: how long past its join
 * deadline a lobby with enough seats can still only be locked, not cancelled.
 */
export const LOCK_GRACE_SECONDS = 10 * 60;
