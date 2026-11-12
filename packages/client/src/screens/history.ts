import type { MatchSummary, ServerMessage } from '@lms/api';
import { app, dom, net, store } from '../context.js';
import { reviewOf } from '../game/review.js';
import { element } from '../ui/dom.js';
import { placeLabel, short } from '../ui/format.js';
import { txLink } from '../ui/links.js';
import { showReview } from './match.js';
import { onSettled } from './result.js';

/**
 * The lobby's "Your matches" panel: the logged-in wallet's finished matches,
 * newest first, each of which reopens in the match screen.
 *
 * The server answers for the authenticated wallet only, so there is nothing
 * here to choose whose history it is.
 */

/** Every page received since the last refresh, newest first. */
let shown: MatchSummary[] = [];

export function wireHistoryControls(): void {
  dom.refreshHistory.onclick = () => requestHistory();
  dom.historyMore.onclick = () => {
    const before = shown.at(-1)?.finishedAt;
    if (before !== null && before !== undefined) requestHistory(before);
  };
  // A match just played is archived by the time its player is back in the lobby.
  dom.resultBack.addEventListener('click', () => requestHistory());
}

/** The newest page, or the page older than `before`. Queued until the socket is logged in. */
export function requestHistory(before?: number): void {
  dom.historyMore.disabled = true;
  net.send(before === undefined ? { type: 'history' } : { type: 'history', before });
}

export function onHistory(message: Extract<ServerMessage, { type: 'history' }>): void {
  shown = message.before === null ? message.matches : [...shown, ...message.matches];
  // Winnings reads the recent staked ones for prizes still on their way.
  store.set({ history: shown });
  dom.historyMore.classList.toggle('hidden', !message.more);
  dom.historyMore.disabled = false;
  renderHistory();
}

export function onReview(message: Extract<ServerMessage, { type: 'review' }>): void {
  const { match } = message;
  showReview(reviewOf(match, app.wallet?.address ?? null), match.result);
  // Staked matches went on-chain: show the transaction and check the stored root, as live.
  if (match.staked) void onSettled({ type: 'settled', matchId: match.result.matchId, tx: match.settledTx });
}

function renderHistory(): void {
  if (shown.length === 0) {
    dom.historyList.replaceChildren(element('li', 'muted small', 'No finished matches yet. Play one above.'));
    return;
  }
  dom.historyList.replaceChildren(...shown.map(historyRow));
}

function historyRow(match: MatchSummary): HTMLLIElement {
  const li = element('li', match.place === 1 ? 'won' : '');
  const place = element('strong', 'history-place', placeLabel(match.place, match.players));
  const detail = element(
    'span',
    'muted small',
    [match.staked ? 'Staked' : 'Practice', `${match.rounds} rounds`, formatWhen(match.finishedAt)].join(' · '),
  );
  if (match.settledTx) detail.append(' · ', txLink(match.settledTx, app.chainId));

  const label = element('span', 'history-label');
  label.append(place, detail);

  const open = element('button', '', 'Open');
  open.onclick = () => net.send({ type: 'review', matchId: match.matchId });

  li.append(label, open);
  return li;
}

/** In English whatever the browser's locale, as the rest of the page is. */
function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
