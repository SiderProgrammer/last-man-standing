import { describe, expect, it } from 'vitest';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DEFAULT_ZAP_SLIPPAGE_BPS, maxAmountInFor, v4QuoterAbi, zapJoinAbi } from '../src/index.js';

describe('maxAmountInFor', () => {
  it('adds the default half-percent allowance', () => {
    expect(DEFAULT_ZAP_SLIPPAGE_BPS).toBe(50);
    expect(maxAmountInFor(2_000_000_000n)).toBe(2_010_000_000n);
  });

  it('rounds up, so the allowance never rounds away', () => {
    expect(maxAmountInFor(1n, 50)).toBe(2n);
    expect(maxAmountInFor(199n, 50)).toBe(200n);
    expect(maxAmountInFor(200n, 50)).toBe(201n);
  });

  it('admits exactly the quote at zero slippage', () => {
    expect(maxAmountInFor(2_662_859_597n, 0)).toBe(2_662_859_597n);
    expect(maxAmountInFor(0n, 0)).toBe(0n);
  });

  it('rejects nonsense', () => {
    expect(() => maxAmountInFor(-1n)).toThrow();
    expect(() => maxAmountInFor(1n, -5)).toThrow();
    expect(() => maxAmountInFor(1n, 0.5)).toThrow();
  });
});

/**
 * Pinned against the contracts. `ZapJoin.joinWithToken` is ours; the quoter's
 * selector is v4-periphery's, and a mismatch there would only show up as every
 * quote reverting on a live chain.
 */
describe('zap ABIs', () => {
  it('matches ZapJoin.joinWithToken', () => {
    const item = zapJoinAbi.find((entry) => entry.type === 'function' && entry.name === 'joinWithToken');
    expect(item && toFunctionSelector(item)).toBe(
      toFunctionSelector(
        'function joinWithToken(bytes32,(address,uint24,int24,address,bytes)[],uint256,uint256)',
      ),
    );
  });

  it('matches V4Quoter.quoteExactOutput', () => {
    const data = encodeFunctionData({
      abi: v4QuoterAbi,
      functionName: 'quoteExactOutput',
      args: [{ exactCurrency: `0x${'00'.repeat(20)}`, path: [], exactAmount: 1n }],
    });
    expect(data.slice(0, 10)).toBe(
      toFunctionSelector(
        'function quoteExactOutput((address,(address,uint24,int24,address,bytes)[],uint128))',
      ),
    );
  });
});
