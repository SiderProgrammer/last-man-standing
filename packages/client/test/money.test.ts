import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import {
  explorerTxUrl,
  formatEth,
  parseStakeInput,
  pendingPrizesText,
  prizeBreakdown,
  prizeSummary,
  queuePanel,
  stakeRangeText,
  winningsBadge,
} from '../src/ui/views.js';
import { stakesSheet } from '../src/ui/rules.js';
import { formatDuration } from '../src/ui/staking.js';

const TERMS = { feeBps: 500, payoutBps: [6_000, 2_500, 1_500], minStake: parseEther('0.001'), maxStake: parseEther('1') };

describe('formatEth', () => {
  it('rounds half up instead of cutting, and drops trailing zeros', () => {
    expect(formatEth(parseEther('0.99999999'))).toBe('1');
    expect(formatEth(parseEther('0.0022800004'))).toBe('0.00228');
    expect(formatEth(0n)).toBe('0');
  });

  it('shows dust as less than the smallest step, not as 0', () => {
    expect(formatEth(1n)).toBe('<0.000001');
  });
});

describe('what a table pays', () => {
  it('shows the pot and the top prize of a full table, as the escrow splits it', () => {
    // 4 × 0.001 = 0.004; less 5% = 0.0038; 60% of that = 0.00228.
    expect(prizeSummary(parseEther('0.001'), 4, TERMS)).toBe('Pot 0.004 · 1st 0.00228');
  });

  it('says nothing without terms to work from', () => {
    expect(prizeSummary(parseEther('0.001'), 4, null)).toBeNull();
    expect(prizeSummary(parseEther('0.001'), 4, { feeBps: 0, payoutBps: [] })).toBeNull();
  });

  it('lists every paying place and the fee in the long form', () => {
    expect(prizeBreakdown(parseEther('0.001'), 4, TERMS)).toBe(
      'With all 4 seats taken: 1st 0.00228 ETH · 2nd 0.00095 ETH · 3rd 0.00057 ETH · 5% fee',
    );
  });

  it('adds the prize to each matchmaking tier once the terms are known', () => {
    const tiers = [{ stake: parseEther('0.001').toString(), seats: 4 }];
    expect(queuePanel(tiers, true, null).tiers[0]?.[1]).toBe('0.001 ETH · 4 seats');
    expect(queuePanel(tiers, true, null, TERMS).tiers[0]?.[1]).toBe('0.001 ETH · 4 seats · Pot 0.004 · 1st 0.00228');
  });

  it('turns the queue panel into "table ready" while a matched table waits for the stake', () => {
    const tiers = [{ stake: parseEther('0.001').toString(), seats: 4 }];
    const panel = queuePanel(tiers, true, null, TERMS, { stake: parseEther('0.001').toString(), seats: 4, closesIn: 130 });
    expect(panel.pill).toBe('table ready');
    expect(panel.joinVisible).toBe(false);
    expect(panel.status).toBe('Your 4-seat table is ready. Stake 0.001 ETH in its row below to take your seat · 2m left.');
  });
});

describe('the create form stake', () => {
  it('takes a decimal comma as readily as a point', () => {
    expect(parseStakeInput('0,005', TERMS)).toEqual({ ok: true, wei: parseEther('0.005') });
    expect(parseStakeInput(' 0.005 ', TERMS)).toEqual({ ok: true, wei: parseEther('0.005') });
  });

  it('says what is wrong in words, not a library error', () => {
    expect(parseStakeInput('', TERMS)).toEqual({ ok: false, error: 'Enter a stake in ETH, e.g. 0.001.' });
    expect(parseStakeInput('-1', TERMS)).toEqual({ ok: false, error: '"-1" is not an amount of ETH.' });
    expect(parseStakeInput('0', TERMS)).toEqual({ ok: false, error: 'The stake must be more than 0.' });
  });

  it('checks the range the config allows', () => {
    expect(stakeRangeText(TERMS)).toBe('0.001 – 1 ETH');
    expect(parseStakeInput('0.0005', TERMS)).toEqual({ ok: false, error: 'Stakes run from 0.001 – 1 ETH.' });
    expect(parseStakeInput('100000', TERMS)).toEqual({ ok: false, error: 'Stakes run from 0.001 – 1 ETH.' });
    // Without the terms read yet, any positive amount goes to the contract.
    expect(parseStakeInput('100000', null).ok).toBe(true);
  });
});

describe('winnings on their way', () => {
  const prize = (amount: string, unlocksIn: number) => ({ matchId: '0x01' as const, amount: parseEther(amount), unlocksIn });

  it('says what is coming and when the first of it unlocks', () => {
    expect(pendingPrizesText([], formatDuration)).toBe('');
    expect(pendingPrizesText([prize('0.00095', 42 * 60)], formatDuration)).toBe('0.00095 ETH on its way, unlocking in 42m.');
    expect(pendingPrizesText([prize('0.001', 3_600), prize('0.002', 600)], formatDuration)).toBe(
      '0.003 ETH on its way from 2 matches, the first unlocking in 10m.',
    );
    expect(pendingPrizesText([prize('0.001', 0)], formatDuration)).toBe('0.001 ETH on its way, paying out once it is finalised.');
  });

  it('puts what can be collected in the header badge first, then what is coming', () => {
    expect(winningsBadge(parseEther('0.00095'), [])).toBe('0.00095 ETH to collect');
    expect(winningsBadge(0n, [prize('0.001', 60)])).toBe('0.001 ETH unlocking');
    expect(winningsBadge(0n, [])).toBeNull();
  });
});

describe('explorer links', () => {
  it('links a transaction on a chain with a public explorer, and nowhere else', () => {
    expect(explorerTxUrl(8453, '0xabc')).toBe('https://basescan.org/tx/0xabc');
    expect(explorerTxUrl(421614, '0xabc')).toBe('https://sepolia.arbiscan.io/tx/0xabc');
    expect(explorerTxUrl(31337, '0xabc')).toBeNull();
  });
});

describe('stakes and payouts help', () => {
  it('states the fee, the split and the challenge window from the terms', () => {
    const text = stakesSheet({ ...TERMS, challengeWindow: 3_600 }, formatDuration)
      .flatMap((section) => section.lines)
      .join('\n');
    expect(text).toContain('keeps 5% of it as a fee');
    expect(text).toContain('1st 60% · 2nd 25% · 3rd 15%');
    expect(text).toContain('once the 1h challenge window closes');
  });

  it('still explains it in general words before the terms are read', () => {
    const titles = stakesSheet(null, formatDuration).map((section) => section.title);
    expect(titles).toEqual(['The pot', 'The challenge window', 'Collecting', 'Refunds']);
  });
});
