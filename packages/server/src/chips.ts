import {
  addressKey,
  sameAddress,
  settleEliminationBook,
  type BookSnapshot,
  type EliminationBet,
} from '@lms/protocol';

/**
 * The play-money side of a room: who holds how many chips, and what is riding
 * on the current round.
 *
 * Split out of `Room` because it is a self-contained ledger with its own key
 * space and its own invariant — chips are conserved, every bet is escrowed the
 * moment it is placed — and none of that has anything to do with the match
 * state machine. The room keeps the rules that need to see the match (whether
 * the book is open, whether the target is still alive); this keeps the money.
 */
export class ChipLedger {
  private readonly stacks = new Map<string, number>();
  private bets: EliminationBet[] = [];

  constructor(private readonly startingChips: number) {}

  /** Opens a stack for an address that does not have one yet. */
  grant(address: `0x${string}`): void {
    const key = addressKey(address);
    if (!this.stacks.has(key)) this.stacks.set(key, this.startingChips);
  }

  balanceOf(address: `0x${string}` | null): number {
    if (!address) return 0;
    return this.stacks.get(addressKey(address)) ?? 0;
  }

  /**
   * Escrows `chips` against `target`.
   *
   * The caller has already checked the balance — see `Room.placeBet`, which
   * has to interleave this check with match-dependent ones to keep the error
   * a player sees stable.
   */
  place(address: `0x${string}`, target: number, chips: number): void {
    this.stacks.set(addressKey(address), this.balanceOf(address) - chips);
    // Stored with whatever casing the caller passed, which is what
    // `settleEliminationBook` then keys its payouts on. Deliberate: see
    // `docs/TODO.md` §3.4. `payBook` below re-normalises, so this is latent
    // rather than live.
    this.bets.push({ better: address, target, chips });
  }

  /** Pays out the round's book and clears it. */
  settle(eliminated: readonly number[]): void {
    const payouts = settleEliminationBook(this.bets, eliminated);
    for (const [better, amount] of payouts) {
      const key = addressKey(better);
      this.stacks.set(key, (this.stacks.get(key) ?? 0) + amount);
    }
    this.bets = [];
  }

  snapshot(round: number, address: `0x${string}` | null): BookSnapshot {
    const pots: Record<number, number> = {};
    const yours: Record<number, number> = {};
    for (const bet of this.bets) {
      pots[bet.target] = (pots[bet.target] ?? 0) + bet.chips;
      if (sameAddress(bet.better, address)) {
        yours[bet.target] = (yours[bet.target] ?? 0) + bet.chips;
      }
    }
    return { round, pots, yours };
  }
}
