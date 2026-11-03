import { addressKey } from '@lms/consensus';
import { favouriteTarget, tallySeat } from '@lms/api';
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
  // Plain counts; spotting the pattern in them is the model's job.
  const tally = tallySeat(match.history, seat);
  const favourite = favouriteTarget(tally.targets);
  const parts = [
    `Seat #${seat} over the whole match: ${tally.strikes} strikes, ${tally.guards} guards, ${tally.charges} charges, ${tally.noShows} timeouts.`,
    favourite === null ? 'Never struck.' : `Struck #${favourite.seat} most often.`,
  ];
  if (you !== null && seat !== you) {
    parts.push(`Struck #${you} (the player this analysis is for) ${tally.targets.get(you) ?? 0} times.`);
  }
  const fell = match.history.find((record) => record.eliminated.includes(seat));
  parts.push(fell ? `Eliminated in round ${fell.round}.` : 'Still standing at the end.');
  return parts.join(' ');
}
