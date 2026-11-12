import { Action, StrikeOutcome, type RoundRecord } from '@lms/consensus';

/**
 * What a resolved round says, in words: the History feed's lines, with the
 * damage each move did, and the one-line recap of the round from your seat.
 * Pure, so it is tested without a page.
 */

type Record = Pick<RoundRecord, 'moves' | 'strikes' | 'stallDamage' | 'eliminated'>;

/**
 * One line per seat that was alive, then the stall penalty. Eliminations are
 * left to the feed's own "eliminated" line, so none is listed twice.
 */
export function roundLines(record: Record): string[] {
  const lines = record.moves.map((move) => {
    if (!move.revealed) return `#${move.index} → no move`;
    if (move.action === Action.Strike) {
      const strike = record.strikes.find((entry) => entry.striker === move.index);
      return `#${move.index} → struck #${move.target}${strike ? strikeEffect(strike) : ''}`;
    }
    if (move.action === Action.Guard) return `#${move.index} → guarded`;
    if (move.action === Action.Charge) return `#${move.index} → charged`;
    return `#${move.index} → no move`;
  });
  if (record.stallDamage > 0) lines.push(`stall → everyone took ${record.stallDamage}`);
  return lines;
}

function strikeEffect(strike: RoundRecord['strikes'][number]): string {
  const loaded = strike.charged ? ', charged' : '';
  if (strike.outcome === StrikeOutcome.Guarded) return ` (blocked${loaded}: took −${strike.reflected})`;
  if (strike.outcome === StrikeOutcome.Void) return ' (missed)';
  const heal = strike.heal > 0 ? `, +${strike.heal} hp` : '';
  return ` (−${strike.damage}${loaded}${heal})`;
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
