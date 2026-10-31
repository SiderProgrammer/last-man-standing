import { parseAbi } from 'viem';
import { zapJoinAbi } from './abis.js';

/**
 * Joining a lobby with a token other than ETH, through `ZapJoin` and Uniswap v4.
 *
 * Shared because both sides handle the same route: the server reads it from
 * its configuration and advertises it in `hello`, and the client quotes it and
 * passes it to the contract unchanged.
 */

/** Room for the price to move between the quote and inclusion, in basis points. */
export const DEFAULT_ZAP_SLIPPAGE_BPS = 50;

/** How long a signed join stays valid, in seconds. The contract rejects it after. */
export const ZAP_DEADLINE_SECONDS = 10 * 60;

/**
 * The most a player agrees to pay for a quote, rounded up.
 *
 * Rounded up so a zero slippage allowance still admits the quote itself, and so
 * a tiny quote cannot round its allowance away to nothing.
 */
export function maxAmountInFor(quote: bigint, slippageBps: number = DEFAULT_ZAP_SLIPPAGE_BPS): bigint {
  if (quote < 0n) throw new Error('quote cannot be negative');
  if (!Number.isInteger(slippageBps) || slippageBps < 0) {
    throw new Error('slippage must be a non-negative whole number of basis points');
  }
  const scaled = quote * BigInt(10_000 + slippageBps);
  return (scaled + 9_999n) / 10_000n;
}

const PATH_KEY = 'struct PathKey { address intermediateCurrency; uint24 fee; int24 tickSpacing; address hooks; bytes hookData; }';

/** The `ZapJoin` surface. Errors are included so a failed simulation reads as its cause. */
export { zapJoinAbi };

/**
 * v4-periphery's `V4Quoter`, exact-output only.
 *
 * Not a `view` function: it runs the swap and reverts with the result, so it
 * has to be called through a simulation rather than a plain read.
 */
export const v4QuoterAbi = parseAbi([
  PATH_KEY,
  'struct QuoteExactParams { address exactCurrency; PathKey[] path; uint128 exactAmount; }',
  'function quoteExactOutput(QuoteExactParams params) returns (uint256 amountIn, uint256 gasEstimate)',
]);
