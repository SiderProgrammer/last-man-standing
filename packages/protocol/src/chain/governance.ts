import { parseAbi } from 'viem';

/**
 * The fee-to-stakers path: `FeeRouter` turns escrow fees into LMS bought for
 * the `StakedLms` vault.
 *
 * Shared because the server's fee keeper drives the router today, and anything
 * that shows stakers their yield will read the same contracts.
 */

/** The `FeeRouter` surface. Errors are included so a failed simulation reads as its cause. */
export const feeRouterAbi = parseAbi([
  'function harvest() returns (uint256 amount)',
  'function buyback(uint256 amountIn, uint256 minLmsOut, uint256 deadline) returns (uint256 lmsOut)',
  'function pendingBuyback() view returns (uint256)',
  'function keeper() view returns (address)',
  'function escrow() view returns (address)',
  'function lms() view returns (address)',
  'function vault() view returns (address)',
  'function pool() view returns (uint24 fee, int24 tickSpacing, address hooks)',
  'event Harvested(uint256 amount, uint256 toStakers, uint256 toTreasury)',
  'event BoughtBack(uint256 ethIn, uint256 lmsOut)',
  'error NotKeeper(address caller)',
  'error DeadlinePassed(uint256 deadline)',
  'error InsufficientPending(uint256 requested, uint256 pending)',
  'error PartialFill(uint256 requested, uint256 paid)',
  'error SlippageExceeded(uint256 lmsOut, uint256 minLmsOut)',
  'error UnexpectedDelta(int128 amountIn)',
  'error NothingToWithdraw()',
]);

/**
 * v4-periphery's `V4Quoter`, single-pool exact input.
 *
 * Like the exact-output quote in `zap.ts`, it runs the swap and reverts with
 * the result, so it has to be simulated rather than read.
 */
export const v4QuoterExactInputAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);

/** Where `Deploy.s.sol` locks the vault's seed shares, which nobody can ever redeem. */
export const VAULT_SEED_HOLDER = '0x000000000000000000000000000000000000dEaD' as const;

/** How long a submitted buyback stays valid, in seconds. */
export const BUYBACK_DEADLINE_SECONDS = 5 * 60;

/**
 * The least LMS a buyback may return for a quote, rounded down.
 *
 * Rounded down so a zero tolerance still admits the quote itself.
 */
export function minOutFor(quote: bigint, slippageBps: number): bigint {
  if (quote < 0n) throw new Error('quote cannot be negative');
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error('slippage must be a whole number of basis points between 0 and 10000');
  }
  return (quote * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** What the client needs to show the staking panel, sent in `hello`. */
export interface StakingInfo {
  /** `StakedLms` on the hub chain. The LMS token is its `asset()`. */
  vault: `0x${string}`;
  /** `LmsAirdrop`, or null when there is no airdrop running. */
  airdrop: `0x${string}` | null;
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
  'error ZeroShares()',
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
