import { Action, StrikeOutcome, type RoundRecord } from '@lms/consensus';

/**
 * What a resolved round says: each seat's part in it, for the History tab,
 * and the one-line recap of the round from your seat.
 * Pure, so it is tested without a page.
 */

type Record = Pick<RoundRecord, 'moves' | 'strikes' | 'stallDamage' | 'eliminated'>;

/** One seat's part in a round, as the History tab lays it out. */
export interface SeatRow {
  seat: number;
  action: 'strike' | 'guard' | 'charge' | 'none';
  /** The seat a strike was aimed at. */
  target: number | null;
  /** What the strike did; null for anything but a strike. */
  outcome: 'hit' | 'blocked' | 'missed' | null;
  /** The strike spent a loaded Charge. */
  charged: boolean;
  /** Damage the strike did to its target. */
  dealt: number;
  /** HP the strike drew back. */
  heal: number;
  /** Damage a guard sent back onto this striker. */
  recoil: number;
  /** Strikers this seat's guard stopped. */
  blocked: number[];
  /** Damage this seat's guard sent back, in all. */
  reflected: number;
  /** Damage hits on this seat did, in all. */
  taken: number;
  hpBefore: number | null;
  hpAfter: number | null;
  /** Eliminated this round. */
  out: boolean;
}

/**
 * Every seat that was in the round, one row each, in seat order so a seat sits
 * in the same place round after round. `hpBefore` is each seat's HP going in,
 * indexed by seat, when it is known.
 */
export function roundRows(
  record: Record & { hpAfter?: readonly number[] },
  hpBefore?: readonly number[],
): SeatRow[] {
  return [...record.moves]
    .sort((a, b) => a.index - b.index)
    .map((move) => {
      const seat = move.index;
      const action = !move.revealed
        ? 'none'
        : move.action === Action.Strike
          ? 'strike'
          : move.action === Action.Guard
            ? 'guard'
            : move.action === Action.Charge
              ? 'charge'
              : 'none';
      const own = action === 'strike' ? record.strikes.find((strike) => strike.striker === seat) : undefined;
      const stopped = record.strikes.filter((strike) => strike.target === seat && strike.outcome === StrikeOutcome.Guarded);
      const outcome =
        action !== 'strike'
          ? null
          : own?.outcome === StrikeOutcome.Hit
            ? 'hit'
            : own?.outcome === StrikeOutcome.Guarded
              ? 'blocked'
              : 'missed';
      return {
        seat,
        action,
        target: action === 'strike' ? move.target : null,
        outcome,
        charged: own?.charged ?? false,
        dealt: own?.damage ?? 0,
        heal: own?.heal ?? 0,
        recoil: own?.outcome === StrikeOutcome.Guarded ? own.reflected : 0,
        blocked: action === 'guard' ? stopped.map((strike) => strike.striker) : [],
        reflected: action === 'guard' ? stopped.reduce((sum, strike) => sum + strike.reflected, 0) : 0,
        taken: record.strikes
          .filter((strike) => strike.target === seat && strike.outcome === StrikeOutcome.Hit)
          .reduce((sum, strike) => sum + strike.damage, 0),
        hpBefore: hpBefore?.[seat] ?? null,
        hpAfter: record.hpAfter?.[seat] ?? null,
        out: record.eliminated.includes(seat),
      };
    });
}

/**
 * The round from your seat, in one line: what you did, what was done to you,
 * and anything you missed. Null for a seat that was not in the round.
 */
export function roundRecap(record: Record, you: number | null): string | null {
  if (you === null) return null;
  const mine = record.moves.find((move) => move.index === you);
  if (!mine) return null;
  const parts: string[] = [];
  const own = record.strikes.find((strike) => strike.striker === you);
  const incoming = record.strikes.filter((strike) => strike.target === you);
  const taken = incoming.filter((strike) => strike.outcome === StrikeOutcome.Hit).reduce((sum, strike) => sum + strike.damage, 0);
  const blocked = incoming.filter((strike) => strike.outcome === StrikeOutcome.Guarded);

  if (!mine.revealed || mine.action === Action.None) {
    parts.push(incoming.length > 0 ? 'You did not lock in: every strike on you hit' : 'You did not lock in a move');
  } else if (mine.action === Action.Strike && own) {
    if (own.outcome === StrikeOutcome.Hit) parts.push(`You hit #${own.target} for ${own.damage}${own.heal > 0 ? ` and healed ${own.heal}` : ''}`);
    else if (own.outcome === StrikeOutcome.Guarded) parts.push(`#${own.target} guarded your strike and reflected ${own.reflected}`);
    else parts.push(`Your strike on #${own.target} missed`);
  } else if (mine.action === Action.Guard) {
    parts.push(
      blocked.length > 0
        ? `Your guard blocked #${blocked[0]!.striker} and reflected ${blocked[0]!.reflected}`
        : 'You guarded, and nobody struck you',
    );
  } else if (mine.action === Action.Charge) {
    parts.push('You are charged: your next strike hits harder');
  }

  if (taken > 0) parts.push(`you took ${taken} from ${incoming.filter((s) => s.outcome === StrikeOutcome.Hit).map((s) => `#${s.striker}`).join(', ')}`);
  if (record.stallDamage > 0) parts.push(`the stall cost everyone ${record.stallDamage}`);
  if (record.eliminated.includes(you)) parts.push('you are out');
  const text = parts.join(' · ');
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}.` : null;
}

/** True when `you` sat in the round and locked in nothing, so the warning stands out. */
export function missedRound(record: Record, you: number | null): boolean {
  const mine = you === null ? undefined : record.moves.find((move) => move.index === you);
  return Boolean(mine && (!mine.revealed || mine.action === Action.None));
}
