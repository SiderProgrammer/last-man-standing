import { MatchPhase } from '@lms/consensus';
import { app, dom, net, store } from '../context.js';
import { currentScreen, onScreenChange, showScreen } from '../ui/chrome.js';
import { element } from '../ui/dom.js';
import { statusItems, type StatusItem } from '../ui/views.js';
import { chainNowMs } from '../io/chainClock.js';

/**
 * The bar under the header that says what the player is in: a running
 * match to rejoin, a table waiting for their stake or for players, a refund
 * to take, a stake crossing chains, a queue place. It is rebuilt from the
 * server's directory and the queue, so it survives a reload or a dropped
 * socket. Hidden on the match screen, which is the thing it points at.
 */

/** What was drawn last, so the clock tick only touches the page when the text moved. */
let drawn = '';

export function wireStatusBar(): void {
  store.subscribe(['wallet', 'lobbies', 'matched', 'inTransit', 'queue', 'queuedSince', 'match'], renderStatusBar);
  onScreenChange(renderStatusBar);
  // The clocks in it.
  setInterval(renderStatusBar, 1_000);
}

function renderStatusBar(): void {
  const running = app.match && app.match.phase !== MatchPhase.Finished && currentScreen() === 'match' ? app.match.matchId : null;
  const items = app.wallet
    ? statusItems({
        wallet: app.wallet.address,
        lobbies: app.lobbies,
        matched: app.matched,
        inTransit: app.inTransit,
        queue: app.queue,
        queuedSince: app.queuedSince,
        watching: running,
        nowMs: Date.now(),
        chainNowMs: chainNowMs(),
      })
    : [];
  const hidden = items.length === 0 || currentScreen() === 'match';
  const key = hidden ? '' : items.map((item) => `${item.kind}|${item.text}|${item.action}`).join('\n');
  if (key === drawn) return;
  drawn = key;
  dom.statusBar.classList.toggle('hidden', hidden);
  dom.statusBar.replaceChildren(...(hidden ? [] : items.map(itemNode)));
}

function itemNode(item: StatusItem): HTMLElement {
  const node = element('div', `status-item ${item.kind}`);
  node.append(element('span', 'status-text', item.text));
  if (item.action) {
    const button = element('button', item.kind === 'ready' || item.kind === 'match' || item.kind === 'refund' ? 'primary' : 'ghost', item.action);
    button.type = 'button';
    button.onclick = () => act(item);
    node.append(button);
  }
  return node;
}

function act(item: StatusItem): void {
  switch (item.kind) {
    case 'match':
      if (!item.matchId) return;
      if (app.leftMatch === item.matchId) store.set({ leftMatch: null });
      net.send({ type: 'watch', matchId: item.matchId });
      showScreen('match');
      return;
    case 'queue':
      net.send({ type: 'dequeue' });
      return;
    default:
      // The lobby row has the full action: the price, the payment choice, the refund.
      showScreen('lobby');
      if (item.matchId) showLobbyRow(item.matchId);
  }
}

/** Scrolls the lobby list to a row and flashes it. */
export function showLobbyRow(matchId: string): void {
  const row = [...dom.lobbyList.querySelectorAll<HTMLElement>('[data-match]')].find((node) => node.dataset.match === matchId.toLowerCase());
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.classList.remove('flash');
  void row.offsetWidth;
  row.classList.add('flash');
}
