import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { parseQueueRange, queuePanel, queueRangeText, queueWinText, stakePresets, tapSeats } from '../src/ui/views.js';

const TERMS = { minStake: parseEther('0.001'), maxStake: parseEther('1') };
const PAYOUT = { feeBps: 500, payoutBps: [6000, 2500, 1500] };
const SPOT = {
  minStake: parseEther('0.001').toString(),
  maxStake: parseEther('0.01').toString(),
  minSeats: 4,
  maxSeats: 8,
};
const ALL = { minSeats: 4, maxSeats: 8 };

describe('matchmaking panel', () => {
  it('stays hidden on a server that runs no matchmaker', () => {
    expect(queuePanel(false, true, null).visible).toBe(false);
  });

  it('shows the form while idle, the search while queued, and the table once ready', () => {
    expect(queuePanel(true, true, null).mode).toBe('form');
    expect(queuePanel(true, true, { ...SPOT, waiting: 1 }).mode).toBe('waiting');
    expect(queuePanel(true, true, null, { stake: SPOT.minStake, seats: 4, closesIn: 60 }).mode).toBe('ready');
  });

  it('asks for a wallet before queueing', () => {
    const panel = queuePanel(true, false, null);
    expect(panel.joinDisabled).toBe(true);
    expect(panel.status).toMatch(/connect a wallet/i);
  });

  it('offers to leave while queued, and counts the others in range', () => {
    const panel = queuePanel(true, true, { ...SPOT, waiting: 3 });
    expect(panel.pill).toBe('searching');
    expect(panel.joinVisible).toBe(false);
    expect(panel.leaveVisible).toBe(true);
    expect(panel.status).toBe('2 others in your range');
    expect(queuePanel(true, true, { ...SPOT, waiting: 1 }).status).toBe('Nobody else in your range yet');
  });
});

describe('queue ranges', () => {
  it('reads both stakes and both seat counts', () => {
    expect(parseQueueRange('0.001', '0,01', 4, 6, TERMS)).toEqual({
      ok: true,
      range: { minStake: parseEther('0.001').toString(), maxStake: parseEther('0.01').toString(), minSeats: 4, maxSeats: 6 },
    });
  });

  it('says which end is wrong, and refuses a range turned around', () => {
    expect(parseQueueRange('', '0.01', 4, 8, TERMS)).toMatchObject({ ok: false, error: expect.stringMatching(/^Lowest stake/) });
    expect(parseQueueRange('0.001', '5', 4, 8, TERMS)).toMatchObject({ ok: false, error: expect.stringMatching(/^Highest stake/) });
    expect(parseQueueRange('0.01', '0.001', 4, 8, TERMS)).toEqual({ ok: false, error: 'The lowest stake is above the highest.' });
    expect(parseQueueRange('0.001', '0.01', 8, 4, TERMS)).toEqual({ ok: false, error: 'The fewest seats are more than the most.' });
  });

  it('names a range in words, collapsing an end that is one value', () => {
    expect(queueRangeText(SPOT)).toBe('0.001 – 0.01 ETH · 4 – 8 seats');
    expect(queueRangeText({ ...SPOT, maxStake: SPOT.minStake, maxSeats: 4 })).toBe('0.001 ETH · 4 seats');
  });

  it('says what 1st place takes across the range', () => {
    expect(queueWinText(SPOT, PAYOUT)).toBe('1st place takes 0.00228 – 0.0456 ETH');
    expect(queueWinText({ ...SPOT, maxStake: SPOT.minStake, maxSeats: 4 }, PAYOUT)).toBe('1st place takes 0.00228 ETH');
    expect(queueWinText(SPOT, null)).toBeNull();
  });
});

describe('stake presets', () => {
  it('offers any stake, the smallest, up to 10×, and 10× to 100×', () => {
    expect(stakePresets(TERMS).map((preset) => preset.label)).toEqual(['Any', '0.001', '0.001 – 0.01', '0.01 – 0.1']);
    expect(stakePresets(TERMS)[0]).toEqual({ minStake: TERMS.minStake, maxStake: TERMS.maxStake, label: 'Any' });
  });

  it('cuts the presets at the largest stake allowed, and drops one that is "Any" again', () => {
    const tight = { minStake: parseEther('0.001'), maxStake: parseEther('0.005') };
    expect(stakePresets(tight).map((preset) => preset.label)).toEqual(['Any', '0.001']);
    const wider = { minStake: parseEther('0.001'), maxStake: parseEther('0.05') };
    expect(stakePresets(wider).map((preset) => preset.label)).toEqual(['Any', '0.001', '0.001 – 0.01', '0.01 – 0.05']);
  });

  it('stands in 0.001 ETH before the terms are read', () => {
    expect(stakePresets(null)[0]?.minStake).toBe(parseEther('0.001'));
  });
});

describe('seat taps', () => {
  it('picks one size from every size, then widens to a range on a second tap', () => {
    const one = tapSeats(ALL, 6, ALL);
    expect(one).toEqual({ minSeats: 6, maxSeats: 6 });
    expect(tapSeats(one, 4, ALL)).toEqual({ minSeats: 4, maxSeats: 6 });
    expect(tapSeats(one, 8, ALL)).toEqual({ minSeats: 6, maxSeats: 8 });
  });

  it('starts over from a range, and keeps a size tapped twice', () => {
    expect(tapSeats({ minSeats: 4, maxSeats: 6 }, 8, ALL)).toEqual({ minSeats: 8, maxSeats: 8 });
    expect(tapSeats({ minSeats: 6, maxSeats: 6 }, 6, ALL)).toEqual({ minSeats: 6, maxSeats: 6 });
  });
});
