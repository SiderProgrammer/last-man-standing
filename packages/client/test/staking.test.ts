import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { claimableEpochRange, type StakingInfo } from '@lms/protocol';
import {
  formatDuration,
  formatLms,
  httpOrigin,
  parseDelegatee,
  parseLms,
  stakingPanel,
  type StakingPanelInput,
  type StakingPosition,
} from '../src/ui/staking.js';

const E18 = 10n ** 18n;
const NOW = 1_700_000_000;
const INFO: StakingInfo = { vault: `0x${'5a'.repeat(20)}`, governor: null, feeRouter: null };

const ME = `0x${'aa'.repeat(20)}` as const;
const DELEGATE = `0x${'d1'.repeat(20)}` as const;

function position(overrides: Partial<StakingPosition> = {}): StakingPosition {
  return {
    lmsBalance: 500n * E18,
    staked: 1_000n * E18,
    votes: 1_000n * E18,
    self: ME,
    delegate: ME,
    earned: 0n,
    cooldown: 7 * 86_400,
    pending: { assets: 0n, unlockAt: 0 },
    chainTime: NOW,
    ...overrides,
  };
}

function input(overrides: Partial<StakingPanelInput> = {}): StakingPanelInput {
  return { info: INFO, connected: true, position: position(), nowSeconds: NOW, error: null, ...overrides };
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

  describe('delegation', () => {
    it('says the stake votes for itself, and offers a delegate', () => {
      const view = stakingPanel(input());
      expect(view.delegation).toMatch(/You vote with your own stake/);
      expect(view.delegateDisabled).toBe(false);
      expect(view.undelegateVisible).toBe(false);
    });

    it('names the delegate and offers the votes back', () => {
      const view = stakingPanel(input({ position: position({ delegate: DELEGATE, votes: 0n }) }));
      expect(view.delegation).toBe(`Your votes go to ${DELEGATE}. You keep the stake and its rewards.`);
      expect(view.undelegateVisible).toBe(true);
    });

    it('tells the self-delegation apart from case alone', () => {
      const upper = `0x${'AA'.repeat(20)}` as const;
      expect(stakingPanel(input({ position: position({ delegate: upper }) })).undelegateVisible).toBe(false);
    });

    it('has nothing to delegate without a stake', () => {
      const view = stakingPanel(input({ position: position({ staked: 0n, votes: 0n }) }));
      expect(view.delegation).toBe('');
      expect(view.delegateDisabled).toBe(true);
    });
  });

  describe('play-mining', () => {
    const WITH_REWARDS: StakingInfo = { ...INFO, rewards: `0x${'7e'.repeat(20)}` };

    it('is hidden without a distributor', () => {
      const view = stakingPanel(input({ playRewards: { claimable: 5n * E18, epochs: [1n] } }));
      expect(view.playRewards).toBe('');
      expect(view.claimPlayVisible).toBe(false);
    });

    it('explains how to earn when nothing is waiting', () => {
      const view = stakingPanel(input({ info: WITH_REWARDS, playRewards: { claimable: 0n, epochs: [] } }));
      expect(view.playRewards).toMatch(/Play staked matches to earn LMS/);
      expect(view.claimPlayVisible).toBe(false);
    });

    it('offers to claim what is waiting, staked', () => {
      const view = stakingPanel(
        input({ info: WITH_REWARDS, playRewards: { claimable: 1_250n * E18, epochs: [3n, 4n] } }),
      );
      expect(view.playRewards).toBe('1,250 LMS earned by playing, over 2 weeks · vests over six months once claimed');
      expect(view.claimPlayVisible).toBe(true);
    });
  });

  it('only offers what the wallet can do', () => {
    const empty = stakingPanel(input({ position: position({ staked: 0n, votes: 0n }) }));
    expect(empty.summary).toBe('Nothing staked yet · 500 LMS in wallet');
    expect(empty.unstakeDisabled).toBe(true);

    expect(stakingPanel(input({ position: position({ lmsBalance: 0n }) })).stakeDisabled).toBe(true);
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

describe('parseDelegatee', () => {
  it('takes an address, checksummed', () => {
    expect(parseDelegatee(`  ${DELEGATE}  `)).toEqual({ ok: true, address: getAddress(DELEGATE) });
  });

  it('refuses something that is not an address', () => {
    expect(parseDelegatee('vitalik.eth')).toEqual({ ok: false, error: 'Enter the address to delegate your votes to.' });
  });

  it('refuses the zero address, which would switch the votes off', () => {
    const result = parseDelegatee(`0x${'00'.repeat(20)}`);
    expect(result.ok).toBe(false);
  });
});

describe('claimableEpochRange', () => {
  const WEEK = 604_800n;

  it('is empty until the first epoch has ended', () => {
    expect(claimableEpochRange(10n, WEEK, 208n, 10n * WEEK + 5n)).toBeNull();
    expect(claimableEpochRange(10n, WEEK, 208n, 3n * WEEK)).toBeNull();
  });

  it('runs from the first epoch to the last that has ended', () => {
    expect(claimableEpochRange(10n, WEEK, 208n, 13n * WEEK + 1n)).toEqual({ from: 10n, to: 12n });
  });

  it('stops at the end of the program', () => {
    expect(claimableEpochRange(10n, WEEK, 208n, 900n * WEEK)).toEqual({ from: 10n, to: 217n });
  });
});
