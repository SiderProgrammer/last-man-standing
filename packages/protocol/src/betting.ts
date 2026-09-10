/** Off-chain spectator book settled from a round's elimination list. */

export interface EliminationBet {
  better: `0x${string}`;
  target: number;
  chips: number;
}

/**
 * Parimutuel payout over one round. Tickets on eliminated seats split the pot
 * proportional to stake. If nobody hit, every bet is refunded.
 */
export function settleEliminationBook(
  bets: readonly EliminationBet[],
  eliminated: readonly number[],
): Map<`0x${string}`, number> {
  const delta = new Map<`0x${string}`, number>();
  if (bets.length === 0) return delta;

  const bump = (who: `0x${string}`, amount: number) => {
    delta.set(who, (delta.get(who) ?? 0) + amount);
  };

  const eliminatedSet = new Set(eliminated);
  const winning = bets.filter((bet) => eliminatedSet.has(bet.target));
  const winningStake = winning.reduce((sum, bet) => sum + bet.chips, 0);
  const pot = bets.reduce((sum, bet) => sum + bet.chips, 0);

  if (winningStake === 0) {
    for (const bet of bets) bump(bet.better, bet.chips);
    return delta;
  }

  for (const bet of winning) {
    bump(bet.better, Math.floor((bet.chips * pot) / winningStake));
  }
  return delta;
}
