import { describe, expect, it } from 'vitest';
import { sharesForUnstake, type StakingInfo } from '@lms/protocol';
import {
  formatDuration,
  formatLms,
  httpOrigin,
  parseLms,
  stakingPanel,
  type StakingPanelInput,
  type StakingPosition,
} from '../src/ui/staking.js';

const E18 = 10n ** 18n;
const NOW = 1_700_000_000;
const INFO: StakingInfo = { vault: `0x${'5a'.repeat(20)}`, airdrop: `0x${'ad'.repeat(20)}`, governor: null, feeRouter: null };

function position(overrides: Partial<StakingPosition> = {}): StakingPosition {
  return {
    lmsBalance: 500n * E18,
    shares: 1_000n * E18,
    value: 1_000n * E18,
    votes: 1_000n * E18,
    earned: 0n,
    cooldown: 7 * 86_400,
    pending: { assets: 0n, unlockAt: 0 },
    chainTime: NOW,
    ...overrides,
  };
}

function input(overrides: Partial<StakingPanelInput> = {}): StakingPanelInput {
  return { info: INFO, connected: true, position: position(), airdrop: null, nowSeconds: NOW, error: null, ...overrides };
}

describe('stakingPanel', () => {
  it('is hidden when the server offers no staking', () => {
    expect(stakingPanel(input({ info: null })).visible).toBe(false);
  });

  it('asks for a wallet before reading anything', () => {
    const view = stakingPanel(input({ connected: false, position: null }));
    expect(view.visible).toBe(true);
    expect(view.stakeDisabled).toBe(true);
    expect(view.status).toBe('Connect a wallet to see your stake.');
  });

  it('shows a failed read in place of the position', () => {
    const view = stakingPanel(input({ position: null, error: 'Could not read your stake: wrong chain' }));
    expect(view.status).toBe('Could not read your stake: wrong chain');
    expect(view.unstakeDisabled).toBe(true);
  });

  it('summarises a position', () => {
    const view = stakingPanel(input());

    expect(view.summary).toBe('Staked 1,000 LMS · 1,000 votes · 500 LMS in wallet');
    expect(view.stakeDisabled).toBe(false);
    expect(view.unstakeDisabled).toBe(false);
    expect(view.status).toBe('Unstaking takes 7d. Your vote stops the moment you request it.');
  });

  it('shows earned ETH and offers to claim it only when there is some', () => {
    const nothing = stakingPanel(input());
    expect(nothing.rewards).toBe('0 ETH earned');
    expect(nothing.claimRewardsVisible).toBe(false);

    const some = stakingPanel(input({ position: position({ earned: 1_234_567_000_000_000n }) }));
    expect(some.rewards).toBe('0.001234 ETH earned');
    expect(some.claimRewardsVisible).toBe(true);
  });

  it('only offers what the wallet can do', () => {
    const empty = stakingPanel(input({ position: position({ shares: 0n, value: 0n, votes: 0n }) }));
    expect(empty.summary).toBe('Nothing staked yet · 500 LMS in wallet');
    expect(empty.unstakeDisabled).toBe(true);

    expect(stakingPanel(input({ position: position({ lmsBalance: 0n }) })).stakeDisabled).toBe(true);
  });

  it('offers an unclaimed airdrop, and hides it once claimed', () => {
    const offered = stakingPanel(input({ airdrop: { amount: 250n * E18, claimed: false } }));
    expect(offered.airdrop).toEqual({ visible: true, text: 'You earned 250 LMS from the match fees you paid.' });

    expect(stakingPanel(input({ airdrop: { amount: 250n * E18, claimed: true } })).airdrop.visible).toBe(false);
  });

  it('counts down a pending unstake, then offers the withdrawal', () => {
    const unlockAt = NOW + 2 * 86_400 + 3 * 3_600;
    const cooling = stakingPanel(input({ position: position({ pending: { assets: 42n * E18, unlockAt } }) }));
    expect(cooling.pending).toEqual({ text: '42 LMS unlocking in 2d 3h.', withdrawVisible: false });

    const ready = stakingPanel(input({ position: position({ pending: { assets: 42n * E18, unlockAt }, chainTime: unlockAt }) }));
    expect(ready.pending).toEqual({ text: '42 LMS ready to withdraw.', withdrawVisible: true });
  });

  it("unlocks on the chain's clock, not the browser's", () => {
    const unlockAt = NOW + 86_400;
    const view = stakingPanel(
      input({
        position: position({ pending: { assets: 42n * E18, unlockAt }, chainTime: unlockAt }),
        nowSeconds: NOW, // the browser thinks a day is left
      }),
    );
    expect(view.pending.withdrawVisible).toBe(true);
  });
});

describe('formatting', () => {
  it('formats LMS with separators and at most the requested decimals', () => {
    expect(formatLms(1_234_567n * E18)).toBe('1,234,567');
    expect(formatLms(1_500_000_000_000_000_000n)).toBe('1.5');
    expect(formatLms(1_234_567_890_000_000_000n, 4)).toBe('1.2345');
    expect(formatLms(1n)).toBe('0');
  });

  it('formats a countdown in its two largest units', () => {
    expect(formatDuration(30)).toBe('under a minute');
    expect(formatDuration(5 * 60)).toBe('5m');
    expect(formatDuration(3_600 + 120)).toBe('1h 2m');
    expect(formatDuration(7 * 86_400)).toBe('7d');
    expect(formatDuration(86_400 + 3_600 * 5 + 59)).toBe('1d 5h');
  });

  it('parses only positive, well-formed amounts', () => {
    expect(parseLms(' 12.5 ')).toBe(12_500_000_000_000_000_000n);
    expect(parseLms('0')).toBeNull();
    expect(parseLms('')).toBeNull();
    expect(parseLms('-1')).toBeNull();
    expect(parseLms('1e18')).toBeNull();
    expect(parseLms('1.0000000000000000001')).toBeNull();
  });

  it('derives the server origin from its socket URL', () => {
    expect(httpOrigin('ws://localhost:8787')).toBe('http://localhost:8787');
    expect(httpOrigin('wss://play.example.com/socket')).toBe('https://play.example.com');
  });
});

describe('sharesForUnstake', () => {
  it('rounds up so the request covers the amount, and takes everything at or above the position', () => {
    expect(sharesForUnstake(110n, 100n, 110n)).toBe(100n);
    expect(sharesForUnstake(500n, 100n, 110n)).toBe(100n);
    expect(sharesForUnstake(55n, 100n, 110n)).toBe(50n);
    expect(sharesForUnstake(56n, 100n, 110n)).toBe(51n);
  });

  it('is zero when there is nothing to unstake', () => {
    expect(sharesForUnstake(0n, 100n, 110n)).toBe(0n);
    expect(sharesForUnstake(5n, 0n, 0n)).toBe(0n);
  });
});
