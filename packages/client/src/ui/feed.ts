import type { RoundRecord } from '@lms/consensus';
import { element } from './dom.js';
import { roundRows, type SeatRow } from './roundText.js';

/**
 * The History tab: one card per round, newest on top, with a row per seat
 * that was in it — the move, what it did, and the HP it left the seat on.
 * Seats keep their place from round to round, and your own row stands out.
 */

const ICON: Record<SeatRow['action'], string> = { strike: '⚔', guard: '🛡', charge: '⚡', none: '·' };
const VERB: Record<SeatRow['action'], string> = { strike: 'Strike', guard: 'Guard', charge: 'Charge', none: 'No move' };

export interface FeedContext {
  /** Your seat, or null when watching. */
  you: number | null;
  /** HP every seat starts on, for the bars. */
  maxHp: number;
}

/** A round's card. `hpBefore` is each seat's HP going in, by seat, when known. */
export function roundCard(record: RoundRecord, hpBefore: readonly number[] | undefined, context: FeedContext): HTMLLIElement {
  const card = element('li', 'feed-round');
  const head = element('div', 'feed-round-head');
  head.append(element('span', 'feed-round-no', `Round ${record.round}`));
  const tags = element('span', 'feed-tags');
  if (record.stallDamage > 0) tags.append(pill('stall', `Stall −${record.stallDamage}`, 'The table went quiet too long: every seat took this'));
  for (const seat of record.eliminated) tags.append(pill('out', `☠ ${seatName(seat, context.you)} out`));
  head.append(tags);

  const rows = element('ul', 'feed-rows');
  for (const row of roundRows(record, hpBefore)) rows.append(seatRow(row, context));
  card.append(head, rows);
  return card;
}

/** A line across the feed, for how the match ended. */
export function feedNote(text: string, tone: 'win' | 'end'): HTMLLIElement {
  return element('li', `feed-note ${tone}`, text);
}

function seatRow(row: SeatRow, { you, maxHp }: FeedContext): HTMLLIElement {
  const classes = ['feed-row', `act-${row.action}`];
  if (row.seat === you) classes.push('mine');
  if (row.out) classes.push('dead');
  if (you !== null && row.target === you) classes.push('at-you');
  const li = element('li', classes.join(' '));

  const chip = element('span', 'seat-chip', `#${row.seat}`);
  if (row.seat === you) chip.append(element('small', '', 'you'));

  const move = element('span', 'feed-move');
  move.append(element('span', 'act-icon', ICON[row.action]), element('span', 'act-verb', VERB[row.action]));
  if (row.target !== null) {
    move.append(element('span', 'act-arrow', '→'), element('span', row.target === you ? 'seat-ref you' : 'seat-ref', seatName(row.target, you)));
  }

  const result = element('span', 'feed-result');
  result.append(...outcomePills(row));

  li.append(chip, move, hpCell(row, maxHp), result);
  li.title = describe(row, you);
  return li;
}

function outcomePills(row: SeatRow): HTMLElement[] {
  const pills: HTMLElement[] = [];
  if (row.charged) pills.push(pill('charged', '⚡ Charged', 'This strike spent a loaded Charge'));
  switch (row.outcome) {
    case 'hit':
      pills.push(pill('hit', `−${row.dealt}`, `Hit for ${row.dealt}`));
      if (row.heal > 0) pills.push(pill('heal', `+${row.heal} hp`, `Healed ${row.heal}`));
      break;
    case 'blocked':
      pills.push(pill('blocked', 'Blocked'));
      if (row.recoil > 0) pills.push(pill('hit', `−${row.recoil} back`, `The guard reflected ${row.recoil} onto this seat`));
      break;
    case 'missed':
      pills.push(pill('muted', 'Missed', 'The target was already out'));
      break;
  }
  if (row.action === 'guard') {
    pills.push(
      row.blocked.length > 0
        ? pill('blocked', `Stopped ${row.blocked.map((seat) => `#${seat}`).join(', ')} · ↩ ${row.reflected}`)
        : pill('muted', 'Nothing to block'),
    );
  }
  if (row.action === 'charge') pills.push(pill('charged', 'Loaded', 'Next strike hits harder'));
  return pills;
}

/** The HP bar, with the change this round brought beside the number. */
function hpCell(row: SeatRow, maxHp: number): HTMLElement {
  const cell = element('span', 'feed-hp');
  if (row.hpAfter === null) return cell;
  const bar = element('span', 'hp-bar');
  const fill = element('i');
  const fraction = Math.max(0, Math.min(1, row.hpAfter / Math.max(1, maxHp)));
  fill.style.width = `${(fraction * 100).toFixed(1)}%`;
  fill.className = fraction > 0.5 ? 'ok' : fraction > 0.25 ? 'low' : 'critical';
  bar.append(fill);
  const value = element('span', 'hp-value', row.out ? 'out' : String(row.hpAfter));
  cell.append(bar, value);
  const change = row.hpBefore === null ? 0 : row.hpAfter - row.hpBefore;
  if (change !== 0) cell.append(element('span', change < 0 ? 'hp-change down' : 'hp-change up', change < 0 ? `−${-change}` : `+${change}`));
  return cell;
}

function pill(kind: string, text: string, title = ''): HTMLSpanElement {
  const node = element('span', `feed-pill ${kind}`, text);
  if (title) node.title = title;
  return node;
}

function seatName(seat: number, you: number | null): string {
  return seat === you ? 'you' : `#${seat}`;
}

/** The row in words, for its tooltip and screen readers. */
function describe(row: SeatRow, you: number | null): string {
  const who = row.seat === you ? 'You' : `Seat #${row.seat}`;
  const parts = [`${who}: ${VERB[row.action].toLowerCase()}${row.target !== null ? ` on ${seatName(row.target, you)}` : ''}`];
  if (row.taken > 0) parts.push(`took ${row.taken} from hits`);
  if (row.hpAfter !== null) parts.push(row.out ? 'eliminated' : `${row.hpAfter} hp left`);
  return parts.join(', ');
}
