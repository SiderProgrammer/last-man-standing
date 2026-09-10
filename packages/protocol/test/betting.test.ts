import { describe, expect, it } from 'vitest';
import { settleEliminationBook, type EliminationBet } from '@lms/protocol';

const alice = '0x00000000000000000000000000000000000000a1' as const;
const bob = '0x00000000000000000000000000000000000000b0' as const;
const carol = '0x00000000000000000000000000000000000000c0' as const;

function bet(better: `0x${string}`, target: number, chips: number): EliminationBet {
  return { better, target, chips };
}

describe('elimination book', () => {
  it('splits the pot among tickets on eliminated seats', () => {
    const payouts = settleEliminationBook([bet(alice, 3, 100), bet(bob, 5, 300)], [3]);
    // Alice was the only winner, so she takes the whole 400-chip pot.
    expect(payouts.get(alice)).toBe(400);
    expect(payouts.get(bob)).toBeUndefined();
  });

  it('pays proportionally when several players backed a casualty', () => {
    const payouts = settleEliminationBook(
      [bet(alice, 2, 100), bet(bob, 2, 300), bet(carol, 7, 400)],
      [2],
    );
    expect(payouts.get(alice)).toBe(200);
    expect(payouts.get(bob)).toBe(600);
    expect((payouts.get(alice) ?? 0) + (payouts.get(bob) ?? 0)).toBeLessThanOrEqual(800);
  });

  it('never pays out more than the pot', () => {
    const bets = [bet(alice, 1, 33), bet(bob, 2, 67), bet(carol, 1, 5)];
    const pot = bets.reduce((sum, item) => sum + item.chips, 0);
    const payouts = settleEliminationBook(bets, [1, 2]);
    const paid = [...payouts.values()].reduce((sum, amount) => sum + amount, 0);
    expect(paid).toBeLessThanOrEqual(pot);
  });

  it('refunds everyone when no ticket hit', () => {
    const payouts = settleEliminationBook([bet(alice, 1, 50), bet(bob, 2, 70)], [6]);
    expect(payouts.get(alice)).toBe(50);
    expect(payouts.get(bob)).toBe(70);
  });

  it('returns nothing for an empty book', () => {
    expect(settleEliminationBook([], [1, 2]).size).toBe(0);
  });
});
