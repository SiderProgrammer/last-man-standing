import type { MatchSummary, ServerMessage } from '@lms/api';
import { app, dom, net, store } from '../context.js';
import { reviewOf } from '../game/review.js';
import { element } from '../ui/dom.js';
import { placeLabel } from '../ui/format.js';
import { formatNet, historyStats, netResult, outcomeTag } from '../ui/views.js';
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

type Filter = 'all' | 'staked' | 'practice';
let filter: Filter = 'all';

/**
 * What each staked match came to, prize less stake, by lowercased id: read
 * from the escrow once and kept. Null while its result is not on-chain.
 */
const nets = new Map<string, bigint | null>();
/** What happened to a staked match beyond its place: vetoed, disputed, cancelled. */
const tags = new Map<string, string | null>();
/** Ids being read now, so a redraw does not ask twice. */
const reading = new Set<string>();

export function wireHistoryControls(): void {
  dom.refreshHistory.onclick = () => requestHistory();
  dom.historyMore.onclick = () => {
    const before = shown.at(-1)?.finishedAt;
    if (before !== null && before !== undefined) requestHistory(before);
  };
  // A match just played is archived by the time its player is back in the lobby.
  dom.resultBack.addEventListener('click', () => requestHistory());
  // Reaching the hub is what lets the money on each row be read.
  store.subscribe(['wallet', 'walletChainId', 'escrow'], () => {
    if (shown.length > 0) renderHistory();
  });
  dom.historyFilter.onclick = (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-filter]');
    if (!button) return;
    filter = button.dataset.filter as Filter;
    for (const option of dom.historyFilter.querySelectorAll<HTMLButtonElement>('button')) {
      const on = option === button;
      option.classList.toggle('active', on);
      option.setAttribute('aria-pressed', String(on));
    }
    renderHistory();
  };
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
  const list = shown.filter((match) => filter === 'all' || (filter === 'staked') === match.staked);
  dom.historyStats.textContent = historyStats(list, nets, Date.now());
  if (list.length === 0) {
    const empty = shown.length === 0 ? 'No finished matches yet. Play one above.' : `No ${filter} matches among these.`;
    dom.historyList.replaceChildren(element('li', 'muted small', empty));
    return;
  }
  dom.historyList.replaceChildren(...list.map(historyRow));
  readNets(list);
}

/**
 * Reads what the staked matches on screen came to, from the escrow through
 * the wallet's own node, and redraws once they are in. Only on the hub,
 * where the escrow is.
 */
function readNets(list: readonly MatchSummary[]): void {
  const { wallet, escrow } = app;
  if (!wallet || !escrow || wallet.chainId !== app.chainId) return;
  const wanted = list.filter((match) => {
    const id = match.matchId.toLowerCase();
    return match.staked && match.place >= 1 && !reading.has(id) && (!nets.has(id) || nets.get(id) === null);
  });
  if (wanted.length === 0) return;
  for (const match of wanted) reading.add(match.matchId.toLowerCase());
  let changed = false;
  void Promise.all(
    wanted.map(async (match) => {
      const id = match.matchId.toLowerCase();
      try {
        const payout = await wallet.matchPayout(escrow, match.matchId);
        nets.set(id, netResult(payout, match.place));
        const tag = outcomeTag(payout);
        if ((tags.get(id) ?? null) !== tag) changed = true;
        tags.set(id, tag);
      } catch {
        nets.set(id, null);
      }
    }),
  ).then(() => {
    for (const match of wanted) reading.delete(match.matchId.toLowerCase());
    // Only redraw for what is now known, or this would read again forever.
    if (changed || wanted.some((match) => typeof nets.get(match.matchId.toLowerCase()) === 'bigint')) renderHistory();
  });
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
  const result = nets.get(match.matchId.toLowerCase());
  if (match.staked && typeof result === 'bigint') {
    place.append(' ', element('span', `history-net ${result > 0n ? 'gain' : result < 0n ? 'loss' : ''}`, formatNet(result)));
  }
  // A vetoed match refunded everyone: its place paid nothing.
  const tag = tags.get(match.matchId.toLowerCase());
  if (match.staked && tag) place.append(' ', element('span', 'pill lobby-tag', tag));

  const open = element('button', '', 'Open');
  open.onclick = () => net.send({ type: 'review', matchId: match.matchId });
  // Read back from the chain after the server lost its copy: the result and
  // its transaction are there, the moves to replay are not.
  if (match.chainOnly) {
    open.disabled = true;
    open.textContent = 'From chain';
    open.title = 'The server no longer keeps the moves of this match, so it cannot be replayed. Its result is on-chain.';
  }

  li.append(label, open);
  return li;
}

/** In English whatever the browser's locale, as the rest of the page is. */
function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
