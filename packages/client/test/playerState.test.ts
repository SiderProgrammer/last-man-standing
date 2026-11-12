import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { MatchStatus } from '@lms/contracts';
import type { LobbyInfo } from '@lms/api';
import { clock, discountSavingText, formatNet, historyStats, netResult, statusItems, type StatusInput } from '../src/ui/views.js';
import { ringSlot, seatScale } from '../src/arena/layout.js';

const ME = `0x${'aa'.repeat(20)}` as const;
const OTHER = `0x${'bb'.repeat(20)}` as const;
const NOW = 1_700_000_000;

const lobby = (id: string, overrides: Partial<LobbyInfo> = {}): LobbyInfo => ({
  matchId: `0x${id.padStart(64, '0')}`,
  stake: parseEther('0.001').toString(),
  seatCount: 1,
  maxSeats: 4,
  minSeats: 4,
  joinDeadline: NOW + 600,
  status: 'open',
  players: [],
  cancellableAt: NOW + 600,
  matchmade: false,
  ...overrides,
});

const input = (overrides: Partial<StatusInput> = {}): StatusInput => ({
  wallet: ME,
  lobbies: { open: [], live: [] },
  matched: new Set(),
  inTransit: new Set(),
  queue: null,
  queuedSince: null,
  watching: null,
  nowMs: NOW * 1000,
  ...overrides,
});

describe('the status bar', () => {
  it('is empty when the player is in nothing', () => {
    expect(statusItems(input())).toEqual([]);
  });

  it('offers to rejoin a match being played, unless it is on screen', () => {
    const live = lobby('1', { status: 'live', players: [{ address: ME, chainId: 1 }] });
    const items = statusItems(input({ lobbies: { open: [], live: [live] } }));
    expect(items.map((item) => [item.kind, item.action])).toEqual([['match', 'Rejoin']]);
    expect(statusItems(input({ lobbies: { open: [], live: [live] }, watching: live.matchId }))).toEqual([]);
  });

  it('says a full table waits for its seed', () => {
    const pending = lobby('2', { status: 'pending', players: [{ address: ME, chainId: 1 }] });
    expect(statusItems(input({ lobbies: { open: [], live: [pending] } }))[0]?.kind).toBe('seeding');
  });

  it('shows a seat waiting for players, and a refund once the lobby cannot start', () => {
    const seated = lobby('3', { players: [{ address: ME, chainId: 1 }] });
    expect(statusItems(input({ lobbies: { open: [seated], live: [] } }))[0]).toMatchObject({
      kind: 'waiting',
      text: 'Seated at 0.001 ETH · 1/4 seats · closes in 10m',
      action: 'Invite',
    });
    const dead = { ...seated, cancellableAt: NOW - 1 };
    expect(statusItems(input({ lobbies: { open: [dead], live: [] } }))[0]).toMatchObject({ kind: 'refund', action: 'Cancel & refund' });
  });

  it('points at a table the queue set for the player, with its clock', () => {
    const table = lobby('4', { matchmade: true, players: [{ address: OTHER, chainId: 1 }], joinDeadline: NOW + 130 });
    const items = statusItems(input({ lobbies: { open: [table], live: [] }, matched: new Set([table.matchId.toLowerCase()]) }));
    expect(items[0]).toMatchObject({ kind: 'ready', text: 'Table ready · stake 0.001 ETH · 2:10 left', action: 'Stake' });
  });

  it('shows a stake crossing chains and a queue place', () => {
    const target = lobby('5');
    const items = statusItems(
      input({
        lobbies: { open: [target], live: [] },
        inTransit: new Set([target.matchId.toLowerCase()]),
        queue: { stake: parseEther('0.001').toString(), seats: 4, waiting: 2 },
        queuedSince: NOW * 1000 - 42_000,
      }),
    );
    expect(items.map((item) => item.kind)).toEqual(['transit', 'queue']);
    expect(items[1]?.text).toBe('Queued for 4 seats at 0.001 ETH · 0:42');
  });

  it('formats a wait as a clock', () => {
    expect(clock(42_000)).toBe('0:42');
    expect(clock(725_000)).toBe('12:05');
    expect(clock(-5)).toBe('0:00');
  });
});

describe('history money', () => {
  const payout = { stake: parseEther('0.001'), seatCount: 4, feeBps: 500, payoutBps: [6_000, 2_500, 1_500] };

  it('nets the prize against the stake, once the result is on-chain', () => {
    expect(netResult({ ...payout, status: MatchStatus.Settled }, 1)).toBe(parseEther('0.00128'));
    expect(netResult({ ...payout, status: MatchStatus.Proposed }, 4)).toBe(-parseEther('0.001'));
    expect(netResult({ ...payout, status: MatchStatus.Cancelled }, 2)).toBe(0n);
    expect(netResult({ ...payout, status: MatchStatus.Live }, 1)).toBeNull();
  });

  it('signs the amount', () => {
    expect(formatNet(parseEther('0.00095'))).toBe('+0.00095 ETH');
    expect(formatNet(-parseEther('0.001'))).toBe('−0.001 ETH');
    expect(formatNet(0n)).toBe('±0 ETH');
  });

  it('sums up the list and the week', () => {
    const now = NOW * 1000;
    const matches = [
      { matchId: '0xA', place: 1, staked: true, finishedAt: now - 3_600_000 },
      { matchId: '0xB', place: 3, staked: true, finishedAt: now - 7_200_000 },
      { matchId: '0xC', place: 2, staked: false, finishedAt: now - 60_000 },
    ];
    const nets = new Map([['0xa', parseEther('0.00128')], ['0xb', -parseEther('0.001')]]);
    expect(historyStats(matches, nets, now)).toBe('3 matches · 1 won · average place 2.0 · +0.00028 ETH this week');
    expect(historyStats([], nets, now)).toBe('');
  });
});

describe('the LMS discount on the join step', () => {
  it('says what the LMS buys', () => {
    expect(discountSavingText({ discount: parseEther('0.000025'), lmsUsed: parseEther('0.5') })).toBe(
      'Pay 0.5 LMS to save 0.000025 ETH on this join.',
    );
  });
});

describe('the seat ring', () => {
  it('turns so your seat is at the bottom', () => {
    // Four seats: slot 2 of 4 is the bottom.
    expect(ringSlot(1, 1, 4)).toBe(2);
    expect(ringSlot(0, 1, 4)).toBe(1);
    expect(ringSlot(3, 1, 4)).toBe(0);
    // A spectator sees seat #0 at the top.
    expect(ringSlot(2, -1, 4)).toBe(2);
  });

  it('shrinks a crowded ring on a narrow screen, never below 55%', () => {
    expect(seatScale(4, 1200, 800)).toBe(1);
    expect(seatScale(8, 375, 340)).toBeLessThan(0.8);
    expect(seatScale(8, 200, 200)).toBe(0.55);
  });
});
