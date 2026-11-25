import { formatEther } from 'viem';
import { DEFAULT_RULES, MatchPhase, sameAddress } from '@lms/consensus';
import type { LobbyInfo, QueueRange, ServerMessage } from '@lms/api';
import { app, dom, net, store } from '../context.js';
import { currentScreen, onScreenChange, showScreen } from '../ui/chrome.js';
import { askToNotify, notifyState } from '../ui/alerts.js';
import { element } from '../ui/dom.js';
import {
  clock,
  parseQueueRange,
  queuePanel,
  queueRangeText,
  queueWinText,
  stakePresets,
  tapSeats,
  type QueueRangeInput,
  type StakePreset,
} from '../ui/views.js';
import { chainNow } from '../io/chainClock.js';
import { mayStake } from '../wallet/flows.js';

/**
 * The matchmaking queue: say what stakes and table sizes you will play,
 * wait, and get `matched` with a lobby in those ranges, opened by the
 * matchmaker or by a player. `lobby.ts` takes it from there, where the
 * matched lobby is the one row this wallet can stake into.
 *
 * The header's queue chip follows the queue on every screen, practice
 * included, and turns into "Table ready" once a table waits for the stake.
 */

/** Every table size a match can have: what "Any" picks. */
const ALL_SEATS = { minSeats: DEFAULT_RULES.minPlayers, maxSeats: DEFAULT_RULES.maxPlayers };

/**
 * What the form holds: a stake preset by its place in `stakePresets`, or
 * "custom" for the typed ends; and the seat range.
 */
const form: { stake: number | 'custom'; seats: { minSeats: number; maxSeats: number } } = {
  // The smallest stake to 10× it: "Any" is a choice to make, not a default.
  stake: 2,
  seats: { ...ALL_SEATS },
};

export function wireQueueControls(): void {
  buildSeatBar();
  dom.queueAnySeats.onclick = () => {
    form.seats = { ...ALL_SEATS };
    renderQueue();
  };
  for (const input of [dom.queueMinStake, dom.queueMaxStake]) input.oninput = renderQueue;
  dom.joinQueue.onclick = joinQueue;
  dom.leaveQueue.onclick = () => net.send({ type: 'dequeue' });
  dom.queueChip.onclick = goToQueue;
  onScreenChange(renderChip);
  dom.notifyMe.onclick = () => void askToNotify().then(renderNotify);
  store.subscribe(['matchmaking', 'queue', 'wallet', 'terms', 'matched', 'lobbies', 'escrowPaused'], renderQueue);
  // Drawn once now, not only on the first change: the stake choices are built here.
  renderQueue();
  // The chip's clock, and the search's.
  setInterval(() => {
    renderChip();
    renderWaiting();
  }, 1_000);
}

/** One button per table size, joined into a bar. */
function buildSeatBar(): void {
  const buttons = [];
  for (let seats = ALL_SEATS.minSeats; seats <= ALL_SEATS.maxSeats; seats += 1) {
    const button = element('button', '', String(seats));
    button.type = 'button';
    button.dataset.seats = String(seats);
    button.setAttribute('aria-label', `${seats} seats`);
    button.onclick = () => {
      form.seats = tapSeats(form.seats, seats, ALL_SEATS);
      renderQueue();
    };
    buttons.push(button);
  }
  dom.queueSeats.replaceChildren(...buttons);
}

/** The stake presets as buttons, rebuilt only when the terms change them, and "Custom". */
function renderStakeChoices(presets: readonly StakePreset[]): void {
  const key = presets.map((preset) => preset.label).join('|');
  if (dom.queueStakes.dataset.key !== key) {
    dom.queueStakes.dataset.key = key;
    const buttons = presets.map((preset, index) => {
      const button = element('button', 'choice', preset.label);
      button.type = 'button';
      button.onclick = () => {
        form.stake = index;
        renderQueue();
      };
      return button;
    });
    const custom = element('button', 'choice', 'Custom');
    custom.type = 'button';
    custom.dataset.custom = '1';
    custom.onclick = () => {
      if (form.stake !== 'custom') {
        const { minStake, maxStake } = customDefault();
        dom.queueMinStake.value = formatEther(minStake);
        dom.queueMaxStake.value = formatEther(maxStake);
        form.stake = 'custom';
      }
      renderQueue();
      dom.queueMinStake.focus();
    };
    dom.queueStakes.replaceChildren(...buttons, custom);
  }
  [...dom.queueStakes.children].forEach((button, index) => {
    const on = form.stake === 'custom' ? (button as HTMLElement).dataset.custom === '1' : index === form.stake;
    button.setAttribute('aria-pressed', String(on));
  });
  dom.queueCustom.classList.toggle('hidden', form.stake !== 'custom');
}

/**
 * What Custom opens on: 0.001 to 1 ETH, each end pulled inside the stakes
 * the config allows, so the form starts valid whatever the terms are.
 */
function customDefault(): { minStake: bigint; maxStake: bigint } {
  const terms = app.terms;
  let minStake = CUSTOM_FROM;
  let maxStake = CUSTOM_TO;
  if (terms) {
    if (minStake < terms.minStake) minStake = terms.minStake;
    if (maxStake > terms.maxStake) maxStake = terms.maxStake;
    if (minStake > maxStake) minStake = maxStake;
  }
  return { minStake, maxStake };
}

const CUSTOM_FROM = 10n ** 15n; // 0.001 ETH
const CUSTOM_TO = 10n ** 18n; // 1 ETH

/** The seat bar lit between the ends of the range, and "Any" when it is every size. */
function renderSeatChoices(): void {
  const { minSeats, maxSeats } = form.seats;
  const any = minSeats === ALL_SEATS.minSeats && maxSeats === ALL_SEATS.maxSeats;
  dom.queueAnySeats.setAttribute('aria-pressed', String(any));
  for (const button of dom.queueSeats.querySelectorAll<HTMLButtonElement>('button')) {
    const seats = Number(button.dataset.seats);
    const inRange = !any && seats >= minSeats && seats <= maxSeats;
    button.classList.toggle('in-range', inRange);
    button.classList.toggle('edge', inRange && (seats === minSeats || seats === maxSeats));
    button.setAttribute('aria-pressed', String(inRange));
  }
}

/** The ranges in the form now, or why they are not ones. */
function formRange(): QueueRangeInput {
  const { minSeats, maxSeats } = form.seats;
  if (form.stake === 'custom') {
    return parseQueueRange(dom.queueMinStake.value, dom.queueMaxStake.value, minSeats, maxSeats, app.terms);
  }
  const presets = stakePresets(app.terms);
  const preset = presets[Math.min(form.stake, presets.length - 1)];
  if (!preset) return { ok: false, error: 'Pick a stake.' };
  return { ok: true, range: { minStake: preset.minStake.toString(), maxStake: preset.maxStake.toString(), minSeats, maxSeats } };
}

/** The ranges this page last queued with. */
let lastQueued: QueueRange | null = null;

/**
 * The ranges the player last queued with, or has in the form now: what
 * "Find another match" queues for. Null when the form holds no valid range.
 */
export function chosenRange(): QueueRange | null {
  if (lastQueued) return lastQueued;
  const parsed = formRange();
  return parsed.ok ? parsed.range : null;
}

/** Queues for `range`: the form's, or "Find another match"'s. */
export async function queueFor(range: QueueRange): Promise<void> {
  lastQueued = range;
  if (await mayStake()) net.send({ type: 'queue', ...range });
  else renderQueue();
}

function joinQueue(): void {
  const parsed = formRange();
  if (!parsed.ok) return;
  dom.joinQueue.disabled = true;
  void queueFor(parsed.range);
}

export function onQueued(message: Extract<ServerMessage, { type: 'queued' }>): void {
  const { minStake, maxStake, minSeats, maxSeats, waiting } = message;
  store.set({
    queue: { minStake, maxStake, minSeats, maxSeats, waiting },
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
  const now = chainNow();
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
    ? { stake: table.stake, seats: table.maxSeats, closesIn: table.joinDeadline - chainNow() }
    : null;
  // A guest cannot stake, so it is not put at a table it could not take.
  const panel = queuePanel(app.matchmaking, Boolean(app.wallet && !app.wallet.isGuest), app.queue, ready);
  dom.queuePanel.classList.toggle('hidden', !panel.visible);
  // No matchmaking on this server: no hero button to a panel that is not there.
  dom.goQueue.classList.toggle('hidden', !panel.visible);
  dom.queuePanel.classList.toggle('ready', ready !== null);
  dom.queueState.textContent = panel.pill;
  dom.queueState.classList.toggle('chain-chip', panel.mode !== 'form');
  dom.queueForm.classList.toggle('hidden', panel.mode !== 'form');
  dom.queueWaiting.classList.toggle('hidden', panel.mode !== 'waiting');
  dom.joinQueue.classList.toggle('hidden', !panel.joinVisible);
  dom.leaveQueue.classList.toggle('hidden', !panel.leaveVisible);

  renderStakeChoices(stakePresets(app.terms));
  renderSeatChoices();
  const parsed = formRange();
  dom.queueSummaryRange.textContent = parsed.ok ? queueRangeText(parsed.range) : parsed.error;
  dom.queueSummaryRange.classList.toggle('warn-text', !parsed.ok);
  dom.queueSummaryWin.textContent = parsed.ok ? (queueWinText(parsed.range, app.terms) ?? '') : '';
  // Paused, a table could not be opened for anyone queued.
  const paused = app.escrowPaused && panel.mode === 'form';
  dom.joinQueue.disabled = panel.joinDisabled || paused || !parsed.ok;
  dom.queueStatus.textContent = paused
    ? 'Staked play is paused: the queue reopens when it resumes.'
    : panel.mode === 'waiting'
      ? ''
      : panel.status;
  renderWaiting();
  renderChip();
  renderNotify();
}

/** The search under way: what for, how long, and how many could sit with this wallet. */
function renderWaiting(): void {
  const spot = app.queue;
  if (!spot || dom.queueWaiting.classList.contains('hidden')) return;
  const others = spot.waiting - 1;
  const company = others <= 0 ? 'nobody else in your range yet' : `${others} other${others === 1 ? '' : 's'} in your range`;
  const since = app.queuedSince !== null ? `${clock(Date.now() - app.queuedSince)} · ` : '';
  dom.queueWaitingRange.textContent = `Searching for ${queueRangeText(spot)}`;
  const meta = `${since}${company}`;
  if (dom.queueWaitingMeta.textContent !== meta) dom.queueWaitingMeta.textContent = meta;
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
