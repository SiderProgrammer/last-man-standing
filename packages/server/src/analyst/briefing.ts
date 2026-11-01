import { Action, addressKey, type RoundRecord } from '@lms/consensus';
import type { StyleBook } from '../lobby/styles.js';
import type { ArchivedMatch } from '../lobby/store.js';
import { renderRound } from './prompt.js';

/**
 * Everything there is to say about one match, as one block of text for the
 * prompt: every round in full, what each seat did over the match and, when
 * the server keeps them, each seat's record in earlier matches. With all of
 * it in front of it the model answers in a single call.
 *
 * Earlier records are looked up by the seats' own wallets, so the prompt can
 * only ever name a wallet that sat at this table.
 *
 * @param you Whose perspective "you" means; null for a spectator.
 */
export async function briefMatch(match: ArchivedMatch, you: number | null, styles?: StyleBook): Promise<string> {
  const lines = ['Every round in full:'];
  for (const record of match.history) lines.push(...renderRound(record));
  lines.push('', 'What each seat did over the whole match:');
  for (const seat of match.seats) lines.push(describeSeat(match, seat.index, you));
  if (styles) {
    lines.push('', 'Earlier matches:');
    const records = await styles.lookup(match.seats.map((seat) => seat.address));
    for (const seat of match.seats) {
      const style = records.get(addressKey(seat.address));
      lines.push(
        !style || style.matches === 0
          ? `Seat #${seat.index} has no settled matches on record.`
          : `Seat #${seat.index} across ${style.matches} settled matches (this one included if it was staked): ${style.wins} won; ` +
              `${style.strikes} strikes, ${style.guards} guards, ${style.charges} charges, ${style.noShows} timeouts.`,
      );
    }
  }
  return lines.join('\n');
}

/** One line on what `seat` did over the match. */
function describeSeat(match: ArchivedMatch, seat: number, you: number | null): string {
  const read = tendencies(match.history, seat, you);
  const parts = [
    `Seat #${seat} over the whole match: ${read.strikes} strikes, ${read.guards} guards, ${read.charges} charges, ${read.noShows} timeouts.`,
    read.favourite === null ? 'Never struck.' : `Struck #${read.favourite} most often.`,
  ];
  if (you !== null && seat !== you) parts.push(`Struck #${you} (the player this analysis is for) ${read.againstYou} times.`);
  const fell = match.history.find((record) => record.eliminated.includes(seat));
  parts.push(fell ? `Eliminated in round ${fell.round}.` : 'Still standing at the end.');
  return parts.join(' ');
}

/**
 * What one seat did over the match: counts, its most frequent target, and how
 * often it struck `you`. Plain counts; spotting the pattern in them is the
 * model's job.
 */
function tendencies(history: readonly RoundRecord[], seat: number, you: number | null) {
  const read = { strikes: 0, guards: 0, charges: 0, noShows: 0, favourite: null as number | null, againstYou: 0 };
  const targets = new Map<number, number>();
  for (const record of history) {
    const move = record.moves.find((entry) => entry.index === seat);
    if (!move) continue;
    if (!move.revealed) read.noShows += 1;
    else if (move.action === Action.Guard) read.guards += 1;
    else if (move.action === Action.Charge) read.charges += 1;
    else if (move.action === Action.Strike) {
      read.strikes += 1;
      if (move.target === you) read.againstYou += 1;
      targets.set(move.target, (targets.get(move.target) ?? 0) + 1);
    }
  }
  const [best] = [...targets.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  if (best) read.favourite = best[0];
  return read;
}
