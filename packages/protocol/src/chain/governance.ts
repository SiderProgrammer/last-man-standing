import { parseAbi } from 'viem';

/**
 * The fee-to-stakers path: `FeeRouter` passes the stakers' share of every fee
 * to `StakedLms` as ETH, and each staker claims theirs.
 *
 * Shared because the server's fee keeper harvests the router, and the client
 * shows and claims what a staker has earned.
 */

/** The `FeeRouter` surface. */
export const feeRouterAbi = parseAbi([
  'function harvest() returns (uint256 amount)',
  'function escrow() view returns (address)',
  'function vault() view returns (address)',
  'function stakerBps() view returns (uint16)',
  'event Harvested(uint256 amount, uint256 toStakers, uint256 toTreasury)',
  'error NothingToWithdraw()',
]);

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
export const rewardsDistributorAbi = parseAbi([
  'function firstEpoch() view returns (uint256)',
  'function epochLength() view returns (uint256)',
  'function PROGRAM_EPOCHS() view returns (uint256)',
  'function claimable(address player, uint256 fromEpoch, uint256 toEpoch) view returns (uint256 total, uint256[] epochs)',
  'function claim(address player, uint256[] epochs) returns (uint256 reward)',
  'function setMaxRewardPerEth(uint256 maxRewardPerEth)',
  'function sweep(address to) returns (uint256 amount)',
  'error EpochNotClaimable(uint256 epoch)',
  'error AlreadyClaimed(uint256 epoch)',
  'error NothingToClaim()',
  'error ClaimsClosed()',
  'error ClaimsStillOpen(uint256 closesAt)',
]);

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
export const stakedLmsAbi = parseAbi([
  'function asset() view returns (address)',
  'function balanceOf(address account) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function getVotes(address account) view returns (uint256)',
  'function delegates(address account) view returns (address)',
  'function delegate(address delegatee)',
  'function cooldown() view returns (uint64)',
  'function unstakeOf(address account) view returns (uint128 assets, uint64 unlockAt)',
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function depositWithPermit(uint256 assets, address receiver, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (uint256 shares)',
  'function requestUnstake(uint256 shares) returns (uint256 assets)',
  'function claim(address receiver) returns (uint256 assets)',
  'function earned(address account) view returns (uint256)',
  'function claimRewards(address to) returns (uint256 amount)',
  'error ZeroShares()',
  'error NothingToWithdraw()',
  'error NothingToClaim()',
  'error StillCoolingDown(uint64 unlockAt)',
]);

/** The parts of `LmsToken` an EIP-2612 permit needs. */
export const lmsTokenAbi = parseAbi([
  'function name() view returns (string)',
  'function nonces(address owner) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
]);

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
