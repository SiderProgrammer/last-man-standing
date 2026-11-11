import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { MatchStatus } from '@lms/contracts';
import { lobbySeatsText, prizeFor, prizeLine, sortLobbies } from '../src/ui/views.js';
import { formatDuration } from '../src/ui/staking.js';

const NOW = 1_700_000_000;

describe('prizeFor', () => {
  // Four seats at 0.01 ETH, a 5% fee, 70/30 to the top two.
  const terms = { stake: parseEther('0.01'), seatCount: 4, feeBps: 500, payoutBps: [7_000, 3_000] };

  it('pays each place its share of the pool less the fee, as the escrow does', () => {
    expect(prizeFor(terms, 0)).toBe(parseEther('0.0266'));
    expect(prizeFor(terms, 1)).toBe(parseEther('0.0114'));
  });

  it('pays nothing to a place the schedule leaves out, or to no place at all', () => {
    expect(prizeFor(terms, 2)).toBe(0n);
    expect(prizeFor(terms, -1)).toBe(0n);
  });
});

describe('prizeLine', () => {
  const at = (status: number, deadline = NOW + 3_600) => ({ status, deadline, chainTime: NOW });

  it('says nothing for a place that won nothing', () => {
    expect(prizeLine(0n, at(MatchStatus.Proposed), formatDuration)).toBeNull();
  });

  it('counts down the challenge window of a proposed result', () => {
    expect(prizeLine(parseEther('0.0266'), at(MatchStatus.Proposed), formatDuration)).toBe(
      'You won 0.0266 ETH. Collectable once the challenge window closes, in 1h.',
    );
  });

  it('waits for settlement while the match is still live on-chain', () => {
    expect(prizeLine(parseEther('0.01'), at(MatchStatus.Live), formatDuration)).toMatch(/once the result is settled/);
  });

  it('sends a settled prize to the collect button', () => {
    expect(prizeLine(parseEther('0.01'), at(MatchStatus.Settled), formatDuration)).toMatch(/in your balance/);
  });
});

describe('lobby list', () => {
  const lobby = (id: string, seatCount: number, maxSeats = 4) => ({ id, seatCount, maxSeats });

  it("puts the player's own tables first, then the fullest", () => {
    const sorted = sortLobbies([lobby('a', 1), lobby('b', 3), lobby('mine', 0), lobby('c', 2)], (l) => l.id === 'mine');
    expect(sorted.map((l) => l.id)).toEqual(['mine', 'b', 'c', 'a']);
  });

  it('says how full an open lobby is, what it needs to start, and how long it stays open', () => {
    const open = { seatCount: 1, maxSeats: 4, minSeats: 2, status: 'open' as const, joinDeadline: NOW + 600 };
    expect(lobbySeatsText(open, NOW)).toBe('1/4 seats · needs 1 more to start · closes in 10m');
    expect(lobbySeatsText({ ...open, seatCount: 2 }, NOW)).toBe('2/4 seats · closes in 10m');
    expect(lobbySeatsText(open, NOW + 601)).toBe('1/4 seats · join window closed');
    expect(lobbySeatsText({ ...open, status: 'live' }, NOW)).toBe('1/4 seats');
  });
});
