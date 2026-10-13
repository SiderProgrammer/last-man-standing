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
  /** `LmsAirdrop`, or null when there is no airdrop running. */
  airdrop: `0x${string}` | null;
  /** `LmsGovernor`, or null when this server indexes no proposals. */
  governor: `0x${string}` | null;
  /** `FeeRouter`, so proposals that change it are labelled. Null when there is none. */
  feeRouter: `0x${string}` | null;
}

/** One address's airdrop allocation, as the server's `/airdrop/<address>` returns it. */
export interface AirdropAllocation {
  /** LMS in wei, as a decimal string so it survives JSON. */
  amount: string;
  proof: `0x${string}`[];
}

/** The `StakedLms` surface the client uses. Errors are included so a failed simulation reads as its cause. */
export const stakedLmsAbi = parseAbi([
  'function asset() view returns (address)',
  'function balanceOf(address account) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function getVotes(address account) view returns (uint256)',
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
