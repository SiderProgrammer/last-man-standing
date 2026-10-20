import {
  Action,
  MatchPhase,
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
import { gsap } from '../motion.js';
import { readsTable, targetOptions } from '../ui/views.js';
import { hideResult, showResult } from './result.js';
import { offerAnalysis, resetAnalysis, wireAnalysisControls } from './analysis.js';
import { stateBeforeRound } from '../game/rewind.js';

/**
 * The match screen: the commit-reveal handshake, the panels around the arena,
 * the replay hold between rounds, and the history feed.
 */

let arena: Arena | null = null;
/** Ends the current replay hold. Owned here, not by the renderer, so the
 *  controls still unlock if the canvas never managed to mount. */
let replayTimer: ReturnType<typeof setTimeout> | null = null;
/** Whether the move buttons are open right now, as the phase plan last said. */
let controlsOpen = false;
/** Phase label last drawn, so the heading is only rebuilt when it changes. */
let phaseShown = '';
/** What the timer bar is draining from: rebased whenever the deadline moves. */
let timerKey = '';
let timerTotal = 1;

// ---------------------------------------------------------------- server feed

export function onRound(message: Extract<ServerMessage, { type: 'round' }>): void {
  appendRound(message.lines, message.record.round, message.record.eliminated);
  // Before the post-round snapshot lands, which follows within
  // milliseconds: the replay starts from the HP still on screen.
  arena?.showRound(message.record, message.replayMs);
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
  offerAnalysis(message.result.matchId);
}

/**
 * Plays one round of the finished match again: the table is set back to how
 * it stood when the round began, then the round runs as it did live. Driven
 * by the analysis tab's key moments.
 */
export function replayRound(round: number): void {
  const state = app.match;
  if (!state || !arena || app.replaying) return;
  const record = state.history.find((entry) => entry.round === round);
  const before = stateBeforeRound(state, round);
  if (!record || !before) return;
  arena.rewindTo(before, record);
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
    resetAnalysis();
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

  renderPhaseLabel(plan.label);
  setActionsEnabled(plan.actionsEnabled);
  dom.lockIn.disabled = plan.lockInDisabled;
  if (plan.statusText !== null) dom.moveStatus.textContent = plan.statusText;
  renderMove();
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
  renderMove();
  // A stamp: the button punches down and springs back as the move seals.
  gsap.fromTo(dom.lockIn, { scale: 0.94 }, { scale: 1, duration: 0.45, ease: 'elastic.out(1, 0.45)' });
  dom.movePanel.classList.remove('sealing');
  void dom.movePanel.offsetWidth;
  dom.movePanel.classList.add('sealing');
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
  arena.onPick ??= pickTarget;
  arena.render(state, you);
  renderMove();
  // Avatars for this match may have landed while the canvas was still being
  // created, in which case nothing has handed them to the arena yet.
  if (mounting && app.avatars.length > 0) arena.setAvatars(app.avatars);
}

function renderTargets(state: PublicMatchState, you: number | null): void {
  fillSelect(dom.target, targetOptions(state, you));
  // A target that has since been eliminated falls back to whoever the picker
  // now shows, so the move on screen is always the move that would be sealed.
  if (app.draft?.action === Action.Attack && dom.target.value !== String(app.draft.target)) {
    app.draft.target = Number(dom.target.value || 0);
  }
}

/**
 * Everything that follows from the draft: the target chips, the lock-in
 * button's label, the sealed state, and the aim drawn in the arena.
 */
function renderMove(): void {
  const state = app.match;
  const draft = app.draft;
  const sealed = state !== null && app.committedRound === state.round;
  const attacking = draft?.action === Action.Attack;

  const finished = state?.phase === MatchPhase.Finished;
  dom.movePanel.classList.toggle('sealed', sealed && !finished);
  dom.targetRow.classList.toggle('hidden', !attacking || finished);
  for (const button of dom.actionBar.querySelectorAll<HTMLButtonElement>('.action')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.action) === draft?.action));
  }

  dom.lockIn.textContent = lockInLabel(finished, sealed, draft);

  const hp = new Map(state?.players.map((player) => [player.index, player.hp]) ?? []);
  const options = [...dom.target.options].map((option) => Number(option.value));
  dom.targetChips.replaceChildren(
    ...options.map((seat) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.disabled = !controlsOpen;
      chip.classList.toggle('active', attacking && draft?.target === seat);
      const name = document.createElement('b');
      name.textContent = `#${seat}`;
      const life = document.createElement('span');
      // Not mid-replay: the snapshot already holds the HP the replay is
      // still on its way to.
      life.textContent = app.replaying ? '' : `${hp.get(seat) ?? '?'} hp`;
      chip.append(name, life);
      chip.onclick = () => pickTarget(seat);
      return chip;
    }),
  );

  arena?.setAim(app.you !== null ? draft : null, sealed, controlsOpen ? options : []);
}

function lockInLabel(finished: boolean, sealed: boolean, draft: typeof app.draft): string {
  if (finished) return 'Match over';
  if (sealed) return '✓ Move sealed';
  if (!controlsOpen) return 'Lock in move';
  return draft ? `Lock in · ${describeDraft(draft)}` : 'Pick a move';
}

/** Targets a seat, from a chip or a click in the arena: an attack on it. */
function pickTarget(seat: number): void {
  if (!controlsOpen) return;
  if (![...dom.target.options].some((option) => option.value === String(seat))) return;
  dom.target.value = String(seat);
  const attack = dom.actionBar.querySelector<HTMLButtonElement>(`[data-action="${Action.Attack}"]`);
  if (attack) selectAction(Action.Attack, attack);
}

/** "Round 3 — commit" as the round, plus a coloured chip for the phase. */
function renderPhaseLabel(label: string): void {
  if (label === phaseShown) return;
  phaseShown = label;
  const [round, phase] = label.split(' — ');
  if (!phase) {
    dom.phaseLabel.textContent = label;
    return;
  }
  const chip = document.createElement('span');
  chip.className = `phase-chip ${phase}`;
  chip.textContent = phase;
  dom.phaseLabel.replaceChildren(round ?? '', chip);
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
  li.className = className || lineKind(text);
  if (app.you !== null && text.startsWith(`#${app.you} `)) li.classList.add('mine');
  dom.feed.append(li);
}

/** Colours a history line by what it describes. */
function lineKind(text: string): string {
  if (text.includes('attacked')) return 'act-attack';
  if (text.includes('defended')) return 'act-defend';
  if (text.endsWith('hid')) return 'act-hide';
  if (text.includes('eliminated')) return 'kill';
  if (text.includes('did not reveal')) return 'act-none';
  return '';
}

/**
 * The countdown, and the bar under it that drains with it. The bar rebases on
 * every new deadline, so it always runs from full to empty over the window it
 * shows, and sits full while a replay holds the clock.
 */
export function updateTimer(): void {
  const now = Date.now();
  const state = app.match;
  const phase = state?.phase ?? null;
  dom.timer.textContent = formatCountdown(phase, app.deadline, now);

  const key = `${app.deadline}|${app.replaying}`;
  if (key !== timerKey) {
    timerKey = key;
    timerTotal = Math.max(1, app.deadline - now);
  }
  const left = Math.max(0, app.deadline - now);
  const running = phase === MatchPhase.Commit || phase === MatchPhase.Reveal;
  const fraction = !running ? 0 : app.replaying ? 1 : left / timerTotal;
  dom.timerBar.style.transform = `scaleX(${fraction.toFixed(4)})`;
  dom.timerBar.classList.toggle('held', app.replaying);
  dom.timerBar.classList.toggle('reveal', phase === MatchPhase.Reveal);

  const sealed = state !== null && app.committedRound === state.round;
  const urgent =
    phase === MatchPhase.Commit && !app.replaying && !sealed && app.you !== null && left < 5_000;
  dom.movePanel.classList.toggle('urgent', urgent);
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

  dom.tabFeed.onclick = () => switchTab('feed');
  dom.tabReads.onclick = () => switchTab('reads');
  dom.tabAnalysis.onclick = () => switchTab('analysis');
  wireAnalysisControls({ replay: replayRound, showTab: () => switchTab('analysis') });

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
  dom.moveStatus.textContent = `Ready: ${describeDraft(app.draft)} — Enter to lock in`;
  renderMove();
}

function clickAction(action: ActionValue): void {
  const button = dom.actionBar.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
  if (button && !button.disabled) button.click();
}

function switchTab(tab: 'feed' | 'reads' | 'analysis'): void {
  const tabs = [
    [dom.tabFeed, dom.feed, tab === 'feed'],
    [dom.tabReads, dom.reads, tab === 'reads'],
    [dom.tabAnalysis, dom.analysis, tab === 'analysis'],
  ] as const;
  for (const [button, pane, active] of tabs) {
    button.classList.toggle('active', active);
    pane.classList.toggle('hidden', !active);
  }
}

function setActionsEnabled(enabled: boolean): void {
  controlsOpen = enabled;
  for (const button of dom.actionBar.querySelectorAll<HTMLButtonElement>('.action')) {
    button.disabled = !enabled;
  }
}

function lockControls(reason: string): void {
  setActionsEnabled(false);
  dom.lockIn.disabled = true;
  dom.moveStatus.textContent = reason;
  renderMove();
}
