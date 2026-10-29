import { feeRouterAbi, rewardsDistributorAbi, stakedLmsAbi, lmsTokenAbi } from './abis.js';

/**
 * The fee-to-stakers path: `FeeRouter` passes the stakers' share of every fee
 * to `StakedLms` as ETH, and each staker claims theirs.
 *
 * Shared because the server's fee keeper harvests the router, and the client
 * shows and claims what a staker has earned.
 */

/** The `FeeRouter` surface. */
export { feeRouterAbi };

/** What the client needs to show the staking panel, sent in `hello`. */
export interface StakingInfo {
  /** `StakedLms` on the hub chain. The LMS token is its `asset()`. */
  vault: `0x${string}`;
  /** `LmsGovernor`, or null when this server indexes no proposals. */
  governor: `0x${string}` | null;
  /** `FeeRouter`, so proposals that change it are labelled. Null when there is none. */
  feeRouter: `0x${string}` | null;
  /**
   * `RewardsDistributor`, for claiming play-mining rewards. Optional for older
   * servers; absent or null hides the claim.
   */
  rewards?: `0x${string}` | null;
}

/**
 * The `RewardsDistributor` surface: play-mining, paid by fee epoch as sLMS.
 * `claimable` loops over a range on-chain, so it is meant for `eth_call`.
 */
export { rewardsDistributorAbi };

/**
 * The epochs worth asking `claimable` about at `chainTime`: from the program's
 * first to the last one that has ended, capped at the program's length.
 * Null when none has ended yet.
 */
export function claimableEpochRange(
  firstEpoch: bigint,
  epochLength: bigint,
  programEpochs: bigint,
  chainTime: bigint,
): { from: bigint; to: bigint } | null {
  if (epochLength === 0n || programEpochs === 0n) return null;
  const current = chainTime / epochLength;
  if (current <= firstEpoch) return null;
  const lastEnded = current - 1n;
  const lastInProgram = firstEpoch + programEpochs - 1n;
  return { from: firstEpoch, to: lastEnded < lastInProgram ? lastEnded : lastInProgram };
}

/** The `StakedLms` surface the client uses. Errors are included so a failed simulation reads as its cause. */
export { stakedLmsAbi };

/** The parts of `LmsToken` an EIP-2612 permit needs. */
export { lmsTokenAbi };

/**
 * sLMS to burn so that `amount` LMS leaves the vault.
 *
 * Rounded up so the request covers the amount asked for; an amount at or above
 * the whole position takes all of it, so "unstake everything" never leaves dust.
 */
export function sharesForUnstake(amount: bigint, shares: bigint, assets: bigint): bigint {
  if (amount <= 0n || shares === 0n || assets === 0n) return 0n;
  if (amount >= assets) return shares;
  const needed = (amount * shares + assets - 1n) / assets;
  return needed < shares ? needed : shares;
}
