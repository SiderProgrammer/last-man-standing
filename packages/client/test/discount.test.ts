import { describe, expect, it } from 'vitest';
import { discountJoinLabel, discountStatus, type DiscountTerms } from '../src/ui/views.js';

const E18 = 10n ** 18n;
const TERMS: DiscountTerms = { token: `0x${'1c'.repeat(20)}`, rate: 20_000n * E18, balance: 150n * E18 };

describe('LMS fee discount', () => {
  it('states the rate and what the wallet holds', () => {
    expect(discountStatus(TERMS)).toEqual({
      text: '20000 LMS buys 1 ETH off a fee, up to half of each fee · you hold 150 LMS',
      enabled: true,
    });
  });

  it('cannot be ticked without LMS to spend', () => {
    const status = discountStatus({ ...TERMS, balance: 0n });
    expect(status.enabled).toBe(false);
    expect(status.text).toMatch(/you hold no LMS$/);
  });

  /** The ETH is exact; the LMS is rounded up, as a ceiling on what is spent. */
  it('prices a join as the ETH sent plus the LMS spent', () => {
    const label = discountJoinLabel('10000000000000000', { discount: 250_000_000_000_000n, lmsUsed: 5_000_000_000_000_000_001n });
    expect(label).toBe('Pay 0.00975 ETH + 5.01 LMS');
  });
});
