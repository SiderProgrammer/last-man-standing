import type { ServerMessage } from '@lms/api';
import { app, dom, net, store } from '../context.js';
import { fillSelect } from '../ui/dom.js';
import { queuePanel, tierKey } from '../ui/views.js';

/**
 * The matchmaking queue: pick a tier, wait, and get `matched` with a lobby
 * the matchmaker opened for the players it put together. `lobby.ts` takes it
 * from there, where the matched lobby is the one row this wallet can stake into.
 */

export function wireQueueControls(): void {
  dom.joinQueue.onclick = joinQueue;
  dom.leaveQueue.onclick = () => net.send({ type: 'dequeue' });
  store.subscribe(['matchmaking', 'queue', 'wallet'], renderQueue);
}

function joinQueue(): void {
  const tier = app.matchmaking.find((entry) => tierKey(entry) === dom.queueTier.value);
  if (!tier) return;
  dom.joinQueue.disabled = true;
  net.send({ type: 'queue', stake: tier.stake, seats: tier.seats });
}

export function onQueued(message: Extract<ServerMessage, { type: 'queued' }>): void {
  store.set({ queue: { stake: message.stake, seats: message.seats, waiting: message.waiting } });
}

/** Out of the queue: left it, or matched, which takes the wallet out of it too. */
export function onDequeued(): void {
  store.set({ queue: null });
}

function renderQueue(): void {
  const panel = queuePanel(app.matchmaking, Boolean(app.wallet), app.queue);
  dom.queuePanel.classList.toggle('hidden', !panel.visible);
  fillSelect(dom.queueTier, panel.tiers);
  dom.queueTier.disabled = !panel.joinVisible;
  dom.queueState.textContent = panel.pill;
  dom.queueState.classList.toggle('chain-chip', app.queue !== null);
  dom.joinQueue.classList.toggle('hidden', !panel.joinVisible);
  dom.joinQueue.disabled = panel.joinDisabled;
  dom.leaveQueue.classList.toggle('hidden', !panel.leaveVisible);
  dom.queueStatus.textContent = panel.status;
}
