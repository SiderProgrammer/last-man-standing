import { describe, expect, it } from 'vitest';
import { queuePanel, tierKey } from '../src/ui/views.js';

const TIERS = [
  { stake: '1000000000000000', seats: 4 },
  { stake: '10000000000000000', seats: 6 },
];

describe('matchmaking panel', () => {
  it('stays hidden on a server that runs no matchmaker', () => {
    expect(queuePanel([], true, null).visible).toBe(false);
  });

  it('lists each tier by stake and table size', () => {
    const panel = queuePanel(TIERS, true, null);
    expect(panel.visible).toBe(true);
    expect(panel.tiers).toEqual([
      ['1000000000000000:4', '0.001 ETH · 4 seats'],
      ['10000000000000000:6', '0.01 ETH · 6 seats'],
    ]);
    expect(tierKey(TIERS[1]!)).toBe('10000000000000000:6');
  });

  it('asks for a wallet before queueing', () => {
    const panel = queuePanel(TIERS, false, null);
    expect(panel.joinDisabled).toBe(true);
    expect(panel.status).toMatch(/connect a wallet/i);
  });

  it('offers to leave while queued, and counts the others waiting', () => {
    const panel = queuePanel(TIERS, true, { stake: TIERS[0]!.stake, seats: 4, waiting: 3 });
    expect(panel.pill).toBe('queued');
    expect(panel.joinVisible).toBe(false);
    expect(panel.leaveVisible).toBe(true);
    expect(panel.status).toBe('Waiting for a 4-seat table at 0.001 ETH · 2 others queued');
  });

  it('says so when this wallet is the only one waiting', () => {
    const panel = queuePanel(TIERS, true, { stake: TIERS[0]!.stake, seats: 4, waiting: 1 });
    expect(panel.status).toMatch(/nobody else queued yet$/);
  });
});
