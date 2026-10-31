import { describe, expect, it } from 'vitest';
import { collectHomePlan } from '../src/ui/views.js';

const MILLI = 10n ** 15n;

describe('collecting winnings to a spoke', () => {
  it('shows what arrives, and what the bridge takes from the balance', () => {
    expect(collectHomePlan(20n * MILLI, MILLI, 199n * MILLI / 10n, 42161, 8453)).toEqual({
      ok: true,
      label: 'Receive 0.0199 ETH on Arbitrum',
      detail: '0.02 ETH on Base, less 0.0001 ETH to the bridge. Click again to sign.',
    });
  });

  it('has nothing to do with nothing held', () => {
    expect(collectHomePlan(0n, MILLI, 0n, 42161, 8453)).toEqual({ ok: false, reason: 'Nothing waiting for you on Base.' });
  });

  /** The receiver refuses less than the escrow's relayed minimum; the hub is where that is collected. */
  it('sends a balance under the minimum back to the hub', () => {
    const plan = collectHomePlan(MILLI / 2n, MILLI, MILLI / 2n, 42161, 8453);
    expect(plan).toEqual({
      ok: false,
      reason: '0.0005 ETH is under the 0.001 ETH that can be bridged; switch to Base to collect it there.',
    });
  });
});
