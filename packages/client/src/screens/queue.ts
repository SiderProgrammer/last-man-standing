import { MatchPhase, sameAddress } from '@lms/consensus';
import type { LobbyInfo, ServerMessage } from '@lms/api';
import { app, dom, net, store } from '../context.js';
import { currentScreen, onScreenChange, showScreen } from '../ui/chrome.js';
import { askToNotify, notifyState } from '../ui/alerts.js';
import { fillSelect } from '../ui/dom.js';
import { clock, queuePanel, tierKey } from '../ui/views.js';

/**
 * The matchmaking queue: pick a tier, wait, and get `matched` with a lobby
 * the matchmaker opened for the players it put together. `lobby.ts` takes it
 * from there, where the matched lobby is the one row this wallet can stake into.
 *
 * The header's queue chip follows the queue on every screen, practice
 * included, and turns into "Table ready" once a table waits for the stake.
 */

export function wireQueueControls(): void {
  dom.joinQueue.onclick = joinQueue;
  dom.leaveQueue.onclick = () => net.send({ type: 'dequeue' });
  dom.queueChip.onclick = goToQueue;
  onScreenChange(renderChip);
  dom.notifyMe.onclick = () => void askToNotify().then(renderNotify);
  store.subscribe(['matchmaking', 'queue', 'wallet', 'terms', 'matched', 'lobbies'], renderQueue);
  // The chip's clock.
  setInterval(renderChip, 1_000);
}

function joinQueue(): void {
  const tier = app.matchmaking.find((entry) => tierKey(entry) === dom.queueTier.value);
  if (!tier) return;
  dom.joinQueue.disabled = true;
  net.send({ type: 'queue', stake: tier.stake, seats: tier.seats });
}

export function onQueued(message: Extract<ServerMessage, { type: 'queued' }>): void {
  store.set({
    queue: { stake: message.stake, seats: message.seats, waiting: message.waiting },
    queuedSince: app.queuedSince ?? Date.now(),
  });
}

/** Out of the queue: left it, or matched, which takes the wallet out of it too. */
export function onDequeued(): void {
  store.set({ queue: null, queuedSince: null });
}

/**
 * The table the queue put this wallet at that still waits for its stake:
 * open, its window not over, and no seat of this wallet's in it yet.
 */
function readyTable(): LobbyInfo | null {
  const now = Math.floor(Date.now() / 1000);
  return (
    app.lobbies.open.find(
      (lobby) =>
        app.matched.has(lobby.matchId.toLowerCase()) &&
        lobby.joinDeadline > now &&
        !lobby.players.some((player) => sameAddress(player.address, app.wallet?.address)),
    ) ?? null
  );
}

function renderQueue(): void {
  const table = readyTable();
  const ready = table
    ? { stake: table.stake, seats: table.maxSeats, closesIn: table.joinDeadline - Math.floor(Date.now() / 1000) }
    : null;
  const panel = queuePanel(app.matchmaking, Boolean(app.wallet), app.queue, app.terms, ready);
  dom.queuePanel.classList.toggle('hidden', !panel.visible);
  dom.queuePanel.classList.toggle('ready', ready !== null);
  fillSelect(dom.queueTier, panel.tiers);
  dom.queueTier.disabled = !panel.joinVisible;
  dom.queueState.textContent = panel.pill;
  dom.queueState.classList.toggle('chain-chip', app.queue !== null || ready !== null);
  dom.joinQueue.classList.toggle('hidden', !panel.joinVisible);
  dom.joinQueue.disabled = panel.joinDisabled;
  dom.leaveQueue.classList.toggle('hidden', !panel.leaveVisible);
  dom.queueStatus.textContent = panel.status;
  renderChip();
  renderNotify();
}

/** The offer to notify: made while queued, until the browser has been asked. */
function renderNotify(): void {
  const state = notifyState();
  dom.notifyMe.classList.toggle('hidden', state === 'unsupported' || state === 'blocked' || (state === 'ask' && !app.queue));
  dom.notifyMe.disabled = state === 'on';
  dom.notifyMe.textContent =
    state === 'on' ? 'Notifications on: you will hear about your table in another tab' : 'Notify me when a table is ready, even in another tab';
}

/**
 * "Queued 0:42", or "Table ready · Stake", in the header during a match:
 * practice included, where the status bar is not shown.
 */
function renderChip(): void {
  const ready = readyTable();
  let text: string | null = null;
  if (currentScreen() !== 'match') text = null;
  else if (ready) text = 'Table ready · Stake';
  else if (app.queue && app.queuedSince !== null) text = `Queued ${clock(Date.now() - app.queuedSince)}`;
  dom.queueChip.classList.toggle('hidden', text === null);
  dom.queueChip.classList.toggle('ready', ready !== null);
  if (text !== null && dom.queueChip.textContent !== text) dom.queueChip.textContent = text;
  dom.queueChip.title = ready ? 'Your table is ready: open the lobby to stake' : 'Open the matchmaking queue';
}

/**
 * Takes the player to the queue panel, or the table waiting for their stake.
 * From a running match it asks first: the seat keeps playing without them.
 */
function goToQueue(): void {
  const running = currentScreen() === 'match' && app.match !== null && app.match.phase !== MatchPhase.Finished && app.you !== null;
  if (running && !window.confirm('Leave this match for the lobby? Your seat keeps playing without you.')) return;
  showScreen('lobby');
  const ready = readyTable();
  const target = ready
    ? [...dom.lobbyList.querySelectorAll<HTMLElement>('[data-match]')].find((row) => row.dataset.match === ready.matchId.toLowerCase())
    : dom.queuePanel;
  target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
