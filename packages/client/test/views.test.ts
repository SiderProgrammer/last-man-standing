import { describe, expect, it } from 'vitest';
import {
  MatchPhase,
  ZERO_ADDRESS,
  type LobbySeat,
  type ZapInfo,
  type ZapToken,
} from '@lms/protocol';
import {
  avatarPanel,
  chainChipCounts,
  chainChips,
  formatTokenAmount,
  hubLabel,
  payWithOptions,
  planTokenJoin,
  stakeButtonLabel,
  targetOptions,
  type AvatarStatus,
} from '../src/ui/views.js';
import { describeDraft, formatCountdown, short } from '../src/ui/format.js';
import { stateWith } from './helpers.js';

const SEPOLIA = 11155111;
const BASE_SEPOLIA = 84532;

function seats(...chainIds: number[]): LobbySeat[] {
  return chainIds.map((chainId, index) => ({
    address: `0x${(index + 1).toString(16).padStart(40, '0')}` as `0x${string}`,
    chainId,
  }));
}

describe('target options', () => {
  const state = { ...stateWith(4, [], [2]), phase: MatchPhase.Commit };

  it('offers every living seat but your own as an attack target', () => {
    expect(targetOptions(state, 0)).toEqual([
      ['1', '#1'],
      ['3', '#3'],
    ]);
  });

  it('offers a spectator every living seat, unmarked', () => {
    expect(targetOptions(state, null).map(([value]) => value)).toEqual(['0', '1', '3']);
  });
});

describe('chain chips', () => {
  it('groups seats by chain, busiest first', () => {
    expect(chainChipCounts(seats(SEPOLIA, BASE_SEPOLIA, SEPOLIA))).toEqual([
      [SEPOLIA, 2],
      [BASE_SEPOLIA, 1],
    ]);
  });

  it('breaks a tie on the lower chain id, so the order is stable', () => {
    expect(chainChipCounts(seats(BASE_SEPOLIA, SEPOLIA))).toEqual([
      [BASE_SEPOLIA, 1],
      [SEPOLIA, 1],
    ]);
  });

  it('counts a chain only when more than one seat came from it', () => {
    const markup = chainChips(seats(SEPOLIA, SEPOLIA, BASE_SEPOLIA));
    expect(markup).toContain('SEP ×2');
    expect(markup).toContain('BASE<');
  });

  it('renders nothing for an empty lobby', () => {
    expect(chainChips([])).toBe('');
  });
});

describe('hub label', () => {
  it('names the hub when the wallet is on it', () => {
    const label = hubLabel(SEPOLIA, SEPOLIA, true);
    expect(label).toMatchObject({ text: 'Sepolia hub', mismatch: false });
  });

  it('says practice only when no escrow is configured', () => {
    expect(hubLabel(SEPOLIA, SEPOLIA, false).text).toBe('Sepolia · practice only');
  });

  it('warns when the wallet is pointed at another chain', () => {
    const label = hubLabel(SEPOLIA, BASE_SEPOLIA, true);
    expect(label.mismatch).toBe(true);
    expect(label.text).toBe('Sepolia hub · wallet on Base Sepolia');
  });

  it('does not warn before a wallet is connected', () => {
    expect(hubLabel(SEPOLIA, 0, true).mismatch).toBe(false);
  });
});

describe('avatar panel', () => {
  const collection = { chainId: SEPOLIA, address: `0x${'ab'.repeat(20)}` } as const;
  const status = (over: Partial<AvatarStatus> = {}): AvatarStatus => ({
    equipped: 0n,
    minted: false,
    totalMinted: 3n,
    maxSupply: 10n,
    ...over,
  });

  it('asks for a wallet first', () => {
    expect(avatarPanel(false, null, 0, 1, null).status).toBe('Connect a wallet to check.');
  });

  it('says when the server has no collection at all', () => {
    expect(avatarPanel(true, null, SEPOLIA, 0, null).status).toBe(
      'No avatar collection configured on this server.',
    );
  });

  it('points a wallet on the wrong chain at the right one', () => {
    expect(avatarPanel(true, null, BASE_SEPOLIA, 1, null).status).toBe(
      'No collection on Base Sepolia. Switch chains to mint.',
    );
  });

  it('offers a mint when the wallet owns nothing and supply remains', () => {
    expect(avatarPanel(true, collection, SEPOLIA, 1, status())).toEqual({
      mintDisabled: false,
      status: 'Free, one per wallet · 3/10 minted',
    });
  });

  it('shows what is being worn', () => {
    const panel = avatarPanel(true, collection, SEPOLIA, 1, status({ equipped: 7n, minted: true }));
    expect(panel).toEqual({ mintDisabled: true, status: 'Wearing #7 · 3/10 minted' });
  });

  it('distinguishes owning one from wearing one', () => {
    const panel = avatarPanel(true, collection, SEPOLIA, 1, status({ minted: true }));
    expect(panel.status).toBe('You own one but wear none · 3/10 minted');
  });

  it('reports a sold-out collection', () => {
    const panel = avatarPanel(true, collection, SEPOLIA, 1, status({ totalMinted: 10n }));
    expect(panel).toEqual({ mintDisabled: true, status: 'Sold out · 10/10 minted' });
  });
});

describe('formatting', () => {
  it('shortens a hash to its ends', () => {
    expect(short(`0x${'ab'.repeat(20)}`)).toBe('0xabab…abab');
  });

  it('names an attack with its target and everything else by action', () => {
    expect(describeDraft({ action: 1, target: 5 })).toBe('attack #5');
    expect(describeDraft({ action: 2, target: 0 })).toBe('defend');
    expect(describeDraft({ action: 3, target: 0 })).toBe('hide');
  });

  it('counts down to the deadline, never past zero', () => {
    expect(formatCountdown(MatchPhase.Commit, 10_000, 4_500)).toBe('5.5s');
    expect(formatCountdown(MatchPhase.Commit, 10_000, 20_000)).toBe('0.0s');
  });

  it('shows no clock outside a live round', () => {
    expect(formatCountdown(null, 10_000, 0)).toBe('--');
    expect(formatCountdown(MatchPhase.Finished, 10_000, 0)).toBe('--');
  });
});

describe('token payment', () => {
  const usdc: ZapToken = {
    symbol: 'USDC',
    address: `0x${'0c'.repeat(20)}`,
    decimals: 6,
    path: [
      { intermediateCurrency: `0x${'0c'.repeat(20)}`, fee: 500, tickSpacing: 10, hooks: ZERO_ADDRESS, hookData: '0x' },
    ],
  };
  const zap: ZapInfo = { address: `0x${'2a'.repeat(20)}`, quoter: `0x${'3b'.repeat(20)}`, tokens: [usdc] };

  it('offers ETH first, then each routed token', () => {
    expect(payWithOptions(null)).toEqual([['ETH', 'ETH']]);
    expect(payWithOptions(zap)).toEqual([
      ['ETH', 'ETH'],
      [usdc.address, 'USDC'],
    ]);
  });

  it('labels the stake in ETH either way, naming the token paid with', () => {
    expect(stakeButtonLabel('1000000000000000', null)).toBe('Stake 0.001');
    expect(stakeButtonLabel('1000000000000000', usdc)).toBe('Stake 0.001 ETH in USDC');
  });

  it('rounds displayed amounts up, never down', () => {
    expect(formatTokenAmount(2_662_859_597n, 6)).toBe('2662.8596');
    expect(formatTokenAmount(2_662_859_500n, 6)).toBe('2662.8595');
    expect(formatTokenAmount(1n, 18)).toBe('0.0001');
    expect(formatTokenAmount(1_500n, 2)).toBe('15');
  });

  it('asks for the quote plus half a percent', () => {
    const plan = planTokenJoin(usdc, 2_000_000_000n, 5_000_000_000n);
    expect(plan).toEqual({ ok: true, maxAmountIn: 2_010_000_000n, label: 'Pay ≤ 2010 USDC' });
  });

  it('caps the ceiling at the balance', () => {
    const plan = planTokenJoin(usdc, 2_000_000_000n, 2_004_000_000n);
    expect(plan.ok && plan.maxAmountIn).toBe(2_004_000_000n);
  });

  it('refuses before any prompt when the balance cannot cover the quote', () => {
    const plan = planTokenJoin(usdc, 2_000_000_000n, 1_500_000_000n);
    expect(plan).toEqual({ ok: false, reason: 'This seat costs about 2000 USDC; you hold 1500 USDC.' });
  });
});
