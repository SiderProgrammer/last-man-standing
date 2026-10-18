import {
  Action,
  commitMove,
  type ActionValue,
  type PublicMatchState,
  type ServerMessage,
} from '@lms/protocol';
import { Arena } from '../arena/arena.js';
import { app, dom, net } from '../context.js';
import { phasePlan } from '../game/phase.js';
import { readOpponents } from '../game/reads.js';
import { forgetMatch, freshSalt, recallMove, rememberMove } from '../game/salts.js';
import { readRaw, writeRaw } from '../io/storage.js';
import { showMatchScreen } from '../ui/chrome.js';
import { fillSelect } from '../ui/dom.js';
import { describeDraft, formatCountdown } from '../ui/format.js';
import { readsTable, targetOptions } from '../ui/views.js';
import { hideResult, showResult } from './result.js';

/**
 * The match screen: the commit-reveal handshake, the panels around the arena,
 * the replay hold between rounds, and the history feed.
 */

let arena: Arena | null = null;
/** Ends the current replay hold. Owned here, not by the renderer, so the
 *  controls still unlock if the canvas never managed to mount. */
let replayTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------- server feed

export function onRound(message: Extract<ServerMessage, { type: 'round' }>): void {
  appendRound(message.lines, message.record.round, message.record.eliminated);
  // Before the post-round snapshot lands, which follows within
  // milliseconds: the replay starts from the HP still on screen.
  arena?.showRound(message.record);
  startReplay(message.replayMs);
}

export function onFinished(message: Extract<ServerMessage, { type: 'finished' }>): void {
  if (app.replaying) app.pendingFinish = message;
  else showFinished(message);
}

export function onDossier(message: Extract<ServerMessage, { type: 'dossier' }>): void {
  if (message.matchId !== app.match?.matchId) return;
  app.dossier = new Map(message.entries.map((entry) => [entry.address.toLowerCase(), entry.style]));
  renderReads(app.match, app.you);
}

export function onAvatars(message: Extract<ServerMessage, { type: 'avatars' }>): void {
  // Late by design: the match is already running by the time these resolve.
  if (message.matchId !== app.match?.matchId) return;
  app.avatars = message.entries;
  arena?.setAvatars(message.entries);
}

function startReplay(replayMs: number): void {
  if (replayTimer) clearTimeout(replayTimer);
  // A server with no hold configured still gets the animation, just without
  // the controls closing for it.
  if (replayMs <= 0) {
    endReplay();
    return;
  }
  app.replaying = true;
  if (app.match) syncPhase(app.match);
  replayTimer = setTimeout(endReplay, replayMs);
}

/**
 * Re-runs the phase plan when the hold ends. Nothing else would: the next
 * snapshot arrived back when the round resolved, so without this the controls
 * would stay closed until something unrelated pushed a state.
 */
function endReplay(): void {
  replayTimer = null;
  app.replaying = false;
  if (app.match) syncPhase(app.match);

  const finished = app.pendingFinish;
  app.pendingFinish = null;
  if (finished) showFinished(finished);
}

function showFinished(message: Extract<ServerMessage, { type: 'finished' }>): void {
  const winner = message.ranking[0];
  const youWon = winner !== undefined && winner === app.you;
  appendLine(
    youWon
      ? `You are the last one standing after ${message.result.rounds} rounds.`
      : `Match over — seat #${winner ?? '?'} took it after ${message.result.rounds} rounds.`,
    'round-head',
  );
  if (winner !== undefined) arena?.showWinner(winner);
  forgetMatch(message.result.matchId);
  lockControls('Match finished.');
  if (app.match?.matchId === message.result.matchId) showResult(app.match, message);
}

export function onState(
  state: PublicMatchState,
  you: number | null,
  deadline: number,
): void {
  const switched = app.match?.matchId !== state.matchId;
  app.match = state;
  app.you = you;
  app.deadline = deadline;

  if (switched) {
    app.committedRound = null;
    app.revealedRound = null;
    app.draft = null;
    app.avatars = [];
    app.dossier = new Map();
    // A replay from the previous match must not close this one's controls.
    if (replayTimer) clearTimeout(replayTimer);
    replayTimer = null;
    app.replaying = false;
    app.pendingFinish = null;
    dom.feed.replaceChildren();
    hideResult();
    showMatchScreen();
  }

  void renderArena(state, you);
  renderTargets(state, you);
  renderReads(state, you);
  syncPhase(state);
}

// ------------------------------------------------------------ commit & reveal

/**
 * Drives the player's half of the commit-reveal handshake.
 *
 * The reveal is sent automatically the moment the server opens the window: the
 * player already chose in the commit phase, and making them click twice would
 * only produce accidental no-shows.
 */
function syncPhase(state: PublicMatchState): void {
  const plan = phasePlan(state, {
    you: app.you,
    committedRound: app.committedRound,
    revealedRound: app.revealedRound,
    draft: app.draft,
    replaying: app.replaying,
  });

  dom.phaseLabel.textContent = plan.label;
  setActionsEnabled(plan.actionsEnabled);
  dom.lockIn.disabled = plan.lockInDisabled;
  if (plan.statusText !== null) dom.moveStatus.textContent = plan.statusText;
  // The send stays exactly where it was in the sequence; it is simply no longer
  // buried inside the predicate that decides it.
  if (plan.shouldReveal) revealNow(state);
}

function lockIn(): void {
  const state = app.match;
  const draft = app.draft;
  if (!state || !draft || app.you === null) return;

  const salt = freshSalt();
  const sealed = { action: draft.action, target: draft.target, salt };
  // Store before sending: a crash after the server accepts the commitment but
  // before we persist would leave a commitment we can no longer open.
  rememberMove(state.matchId, state.round, sealed);

  const commitment = commitMove(state.matchId, state.round, app.you, sealed);
  net.send({
    type: 'commit',
    commitment,
    // Names the round, so a commit flushed late from the offline queue is
    // refused instead of being taken for a later round's.
    matchId: state.matchId,
    round: state.round,
    ...(dom.holdMoves.checked ? { hold: sealed } : {}),
  });
  app.committedRound = state.round;
  dom.lockIn.disabled = true;
  setActionsEnabled(false);
  dom.moveStatus.textContent = `Sealed: ${describeDraft(draft)}`;
}

function revealNow(state: PublicMatchState): void {
  const stored = recallMove(state.matchId, state.round);
  if (!stored) {
    dom.moveStatus.textContent = 'No sealed move for this round — sitting it out.';
    return;
  }
  net.send({
    type: 'reveal',
    action: stored.action,
    target: stored.target,
    salt: stored.salt,
    matchId: state.matchId,
    round: state.round,
  });
  app.revealedRound = state.round;
  dom.moveStatus.textContent = 'Revealed. Resolving…';
}

// ------------------------------------------------------------------ rendering

async function renderArena(state: PublicMatchState, you: number | null): Promise<void> {
  const mounting = arena === null;
  arena ??= await Arena.mount(dom.arena);
  arena.render(state, you);
  // Avatars for this match may have landed while the canvas was still being
  // created, in which case nothing has handed them to the arena yet.
  if (mounting && app.avatars.length > 0) arena.setAvatars(app.avatars);
}

function renderTargets(state: PublicMatchState, you: number | null): void {
  fillSelect(dom.target, targetOptions(state, you));
}

function renderReads(state: PublicMatchState, you: number | null): void {
  const reads = readOpponents(state, you, app.dossier);
  // A regular's record is worth showing before the first round, too.
  if (reads.length === 0 || (state.history.length === 0 && app.dossier.size === 0)) {
    dom.reads.innerHTML = '<p class="muted small">Patterns appear once the first round resolves.</p>';
    return;
  }

  dom.reads.innerHTML = readsTable(reads);
}

function appendRound(lines: string[], round: number, eliminated: number[]): void {
  appendLine(`Round ${round}`, 'round-head');
  for (const line of lines) appendLine(line);
  if (eliminated.length > 0) {
    appendLine(`eliminated: ${eliminated.map((seat) => `#${seat}`).join(', ')}`, 'kill');
  }
  dom.feed.scrollTop = dom.feed.scrollHeight;
}

function appendLine(text: string, className = ''): void {
  const li = document.createElement('li');
  li.textContent = text;
  if (className) li.className = className;
  dom.feed.append(li);
}

export function updateTimer(): void {
  dom.timer.textContent = formatCountdown(app.match?.phase ?? null, app.deadline, Date.now());
}

// ------------------------------------------------------------------- controls

const HOLD_KEY = 'lms:hold-moves';

export function wireMatchControls(): void {
  dom.holdMoves.checked = readRaw(HOLD_KEY) === '1';
  dom.holdMoves.onchange = () => writeRaw(HOLD_KEY, dom.holdMoves.checked ? '1' : '0');
  for (const button of dom.actionBar.querySelectorAll<HTMLButtonElement>('.action')) {
    button.onclick = () => selectAction(Number(button.dataset.action) as ActionValue, button);
  }

  dom.target.onchange = () => {
    if (app.draft) app.draft.target = Number(dom.target.value);
  };

  dom.lockIn.onclick = lockIn;

  dom.tabFeed.onclick = () => switchTab(true);
  dom.tabReads.onclick = () => switchTab(false);

  // Keyboard shortcuts: the commit window is short enough that reaching for the
  // mouse is a real cost.
  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === '1') clickAction(Action.Attack);
    else if (event.key === '2') clickAction(Action.Defend);
    else if (event.key === '3') clickAction(Action.Hide);
    else if (event.key === 'Enter' && !dom.lockIn.disabled) lockIn();
  });
}

function selectAction(action: ActionValue, button: HTMLButtonElement): void {
  for (const other of dom.actionBar.querySelectorAll('.action')) other.classList.remove('selected');
  button.classList.add('selected');

  const needsTarget = action === Action.Attack;
  dom.targetRow.classList.toggle('hidden', !needsTarget);
  const target = needsTarget ? Number(dom.target.value || 0) : 0;
  app.draft = { action, target };
  dom.lockIn.disabled = app.committedRound === app.match?.round;
  dom.moveStatus.textContent = `Ready: ${describeDraft(app.draft)}`;
}

function clickAction(action: ActionValue): void {
  const button = dom.actionBar.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
  if (button && !button.disabled) button.click();
}

function switchTab(feed: boolean): void {
  dom.tabFeed.classList.toggle('active', feed);
  dom.tabReads.classList.toggle('active', !feed);
  dom.feed.classList.toggle('hidden', !feed);
  dom.reads.classList.toggle('hidden', feed);
}

function setActionsEnabled(enabled: boolean): void {
  for (const button of dom.actionBar.querySelectorAll<HTMLButtonElement>('.action')) {
    button.disabled = !enabled;
  }
}

function lockControls(reason: string): void {
  setActionsEnabled(false);
  dom.lockIn.disabled = true;
  dom.moveStatus.textContent = reason;
}
