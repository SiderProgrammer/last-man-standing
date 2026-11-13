import {
  Action,
  MatchPhase,
  commitMove,
  isActionValue,
  isLegalAction,
  receiptTypedData,
  sameHex,
  strikeDamageFor,
  type ActionValue,
  type MatchResult,
  type MovePlace,
  type PublicMatchState,
  type RoundRecord,
  type SealedMove,
} from '@lms/consensus';
import { isPracticeTable } from '@lms/contracts';
import {
  applyDelta,
  withRound,
  type LobbyInfo,
  type MatchmakingTier,
  type PlayStyle,
  type ServerMessage,
} from '@lms/api';
import { verifyTypedData } from 'viem';
import type { Arena } from '../arena/arena.js';
import { app, dom, net, store, type AppState } from '../context.js';
import { phasePlan, type PhasePlan } from '../game/phase.js';
import { readOpponents, type Read } from '../game/reads.js';
import { freshSalt, recallMove, rememberMove, updateMove } from '../game/salts.js';
import { readRaw, writeRaw } from '../io/storage.js';
import { currentScreen, showLobbyScreen, showMatchScreen, showScreen, toast } from '../ui/chrome.js';
import { callBack, cue, setSound, soundOn } from '../ui/alerts.js';
import { missedRound, roundLines, roundRecap } from '../ui/roundText.js';
import { renderWinnings } from '../wallet/payouts.js';
import { startPractice } from './lobby.js';
import { element, fillSelect } from '../ui/dom.js';
import { describeDraft, formatCountdown } from '../ui/format.js';
import { gsap } from '../motion.js';
import { targetOptions } from '../ui/views.js';
import { hideResult, showResult } from './result.js';
import { offerAnalysis, resetAnalysis, wireAnalysisControls } from './analysis.js';
import { stateBeforeRound } from '../game/rewind.js';
import type { Review } from '../game/review.js';
import type { GrantedKey } from '../wallet/grant.js';
import { explainError } from '../ui/errors.js';

/**
 * The match screen: the commit-reveal handshake, the panels around the arena,
 * the replay hold between rounds, and the history feed.
 *
 * Server messages, clicks and the replay timer are actions: they change the
 * store, and they alone send anything — a commit, a reveal. The renderers
 * below subscribe to the store and only draw.
 */

let arena: Arena | null = null;
/**
 * The arena while it mounts: its module (Pixi, most of the bundle) loads on
 * demand, so the first renders of a match can arrive before it is ready, and
 * they must share one canvas rather than each make their own.
 */
let mounting: Promise<Arena> | null = null;

/**
 * Destroys the arena: its canvas and WebGL context, its seats and the faces
 * they wore, its effects. Each match gets a fresh one, so nothing of the last
 * table — a seat, a texture, a tween — outlives it. One still mounting is
 * destroyed as soon as it is ready.
 */
function disposeArena(): void {
  const current = arena;
  const pending = mounting;
  arena = null;
  mounting = null;
  if (current) current.destroy();
  else void pending?.then((mounted) => mounted.destroy());
}
/** Ends the current replay hold. Owned here, not by the renderer, so the
 *  controls still unlock if the canvas never managed to mount. */
let replayTimer: ReturnType<typeof setTimeout> | null = null;
/** True while a review opens a finished match, which shows its own result. */
let reviewing = false;
/** The round the replay hold is showing, for the phase label. */
let replayedRound: number | null = null;
/** Whether the move buttons are open right now, as the phase plan last said. */
let controlsOpen = false;
/** Phase label last drawn, so the heading is only rebuilt when it changes. */
let phaseShown = '';
/** What the timer bar is draining from: rebased whenever the deadline moves. */
let timerKey = '';
let timerTotal = 1;

// ---------------------------------------------------------------- server feed

export function onRound(message: Extract<ServerMessage, { type: 'round' }>): void {
  // No match on screen: the player left this table for the lobby.
  if (!app.match) return;
  // The history grows here: deltas never carry it.
  replayedRound = message.record.round;
  store.set({ match: withRound(app.match, message.record) });
  appendRound(roundLines(message.record), message.record.round, message.record.eliminated);
  renderRecap(message.record);
  // Before the post-round snapshot lands, which follows within
  // milliseconds: the replay starts from the HP still on screen.
  arena?.showRound(message.record, message.replayMs);
  startReplay(message.replayMs);
}

/**
 * The round from the player's own seat, under the timer, and read out to a
 * screen reader. A round they sat out says so, in the warning colour.
 */
function renderRecap(record: RoundRecord): void {
  const recap = roundRecap(record, app.you);
  dom.roundRecap.textContent = recap ?? '';
  dom.roundRecap.classList.toggle('hidden', recap === null);
  dom.roundRecap.classList.toggle('missed', missedRound(record, app.you));
  const out = record.eliminated.length > 0 ? ` Eliminated: ${record.eliminated.map((seat) => `#${seat}`).join(', ')}.` : '';
  dom.roundAnnounce.textContent = `Round ${record.round}. ${recap ?? ''}${out}`;
}

export function onFinished(message: Extract<ServerMessage, { type: 'finished' }>): void {
  // A table the player left: nothing to show, but it belongs in their history now.
  // The server archives it just after announcing it, hence the short wait.
  if (message.result.matchId === app.leftMatch) {
    setTimeout(() => net.send({ type: 'history' }), 2_000);
    return;
  }
  if (app.replaying) store.set({ pendingFinish: message });
  else showFinished(message);
}

/**
 * Keeps the server's receipt for this browser's own commitment, once it checks
 * out: signed by the key `hello` named, for the commitment this browser sealed.
 * It is the evidence if the transcript later leaves the move out.
 */
export async function onReceipt(message: Extract<ServerMessage, { type: 'receipt' }>): Promise<void> {
  const { receipt, signature } = message;
  const stored = recallMove(receipt.matchId, receipt.round);
  const practice = app.match?.matchId === receipt.matchId && isPracticeTable(app.match.players);
  const signer = practice ? app.practiceReceiptSigner : app.receiptSigner;
  if (!stored || !signer) return;
  const sealed = commitMove(receipt.matchId, receipt.round, receipt.seat, stored);
  if (!sameHex(sealed, receipt.commitment)) return;
  const valid = await verifyTypedData({ address: signer, ...receiptTypedData(app.chainId, receipt), signature }).catch(
    () => false,
  );
  if (!valid) {
    console.warn(`[receipt] not signed by the server's receipt key ${signer}`);
    return;
  }
  updateMove(receipt.matchId, receipt.round, { receipt: { receivedAt: receipt.receivedAt, signature } });
}

export function onDossier(message: Extract<ServerMessage, { type: 'dossier' }>): void {
  if (message.matchId !== app.match?.matchId) return;
  store.set({ dossier: new Map(message.entries.map((entry) => [entry.address.toLowerCase(), entry.style])) });
}

export function onAvatars(message: Extract<ServerMessage, { type: 'avatars' }>): void {
  // Late by design: the match is already running by the time these resolve.
  if (message.matchId !== app.match?.matchId) return;
  store.set({ avatars: message.entries });
}

function startReplay(replayMs: number): void {
  if (replayTimer) clearTimeout(replayTimer);
  // A server with no hold configured still gets the animation, just without
  // the controls closing for it.
  if (replayMs <= 0) {
    endReplay();
    return;
  }
  store.set({ replaying: true });
  replayTimer = setTimeout(endReplay, replayMs);
}

/**
 * Ends the hold: the controls reopen, and a reveal that came due while the
 * last round played is sent now. Nothing else would do either: the next
 * snapshot arrived back when the round resolved.
 */
function endReplay(): void {
  replayTimer = null;
  const finished = app.pendingFinish;
  store.set({ replaying: false, pendingFinish: null });
  revealIfDue();
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
  // The sealed moves are kept until the result panel has verified the match:
  // if it does not verify, they are the evidence.
  lockControls('Match finished.');
  // The one button left open: back to the lobby.
  dom.lockIn.disabled = false;
  dom.lockIn.textContent = lockInLabel(true, false, null);
  dom.roundRecap.classList.add('hidden');
  dom.coach.classList.add('hidden');
  // The first practice match has been walked through: not again.
  if (app.match && isPracticeTable(app.match.players) && app.you !== null) writeRaw(COACHED_KEY, '1');
  if (app.match?.matchId === message.result.matchId) {
    showResult(app.match, message);
    // One card for the end of the match: the move panel, its timer and its
    // own back button give way to it.
    dom.movePanel.classList.add('hidden');
    const practice = isPracticeTable(app.match.players);
    // Practice: the same bots again. Staked: the queue for the same table.
    const tier = practice ? null : tierOf(app.match.matchId, app.match.players.length);
    againTier = tier;
    dom.resultAgain.textContent = practice ? 'Play again' : 'Find another match';
    dom.resultAgain.classList.toggle('hidden', practice ? !app.lastPractice : tier === null);
    showResultCard();
  }
  offerAnalysis(message.result.matchId);
}

/**
 * A table opened after its match ended, as a spectator who missed the
 * `finished`: the winner, from who is left standing, and the controls shut,
 * with the button back to the lobby. A review goes through `showFinished`.
 */
function showEnded(state: PublicMatchState): void {
  const standing = state.players.filter((player) => player.alive);
  const winner = standing.length === 1 ? standing[0]?.index : undefined;
  appendLine(winner === undefined ? 'This match has ended.' : `Match over — seat #${winner} took it after ${state.round} rounds.`, 'round-head');
  if (winner !== undefined) {
    if (arena) arena.showWinner(winner);
    else void mounting?.then((mounted) => mounted.showWinner(winner));
  }
  lockControls('This match has ended.');
  dom.lockIn.disabled = false;
  dom.lockIn.textContent = lockInLabel(true, false, null);
}

/** The matchmaking tier "Find another match" queues for, set when a staked match ends. */
let againTier: MatchmakingTier | null = null;

/**
 * The matchmaker's tier for a finished staked match: its stake, read from
 * the directory as it was while the match ran, and its table size. Null
 * when no tier matches, as for a private lobby's odd stake.
 */
function tierOf(matchId: string, seats: number): MatchmakingTier | null {
  const lobby = [...app.lobbies.live, ...app.lobbies.open].find((entry) => entry.matchId === matchId) ?? tableSeen;
  if (!lobby || lobby.matchId !== matchId) return null;
  // A short matchmade table has as many seats as players: it belongs to the
  // smallest tier at its stake that seats it.
  const size = Math.max(seats, lobby.maxSeats);
  const fits = app.matchmaking.filter((tier) => tier.stake === lobby.stake && tier.seats >= size).sort((a, b) => a.seats - b.seats);
  return fits[0] ?? null;
}

/** The directory's entry for the match on screen, kept as it was when the match opened. */
let tableSeen: LobbyInfo | null = null;

/** Brings the result card into view if it is not, and gives it focus for the keyboard. */
function showResultCard(): void {
  const box = dom.resultPanel.getBoundingClientRect();
  if (box.top < 0 || box.bottom > window.innerHeight) dom.resultPanel.scrollIntoView({ block: 'start', behavior: 'smooth' });
  dom.resultPanel.focus({ preventScroll: true });
}

/**
 * Opens a finished match from the history: the final table, every round in
 * the feed, and the result panel with its browser check, as if it had just
 * ended. Nothing is sent; the arena and analysis tab work as they do live.
 */
export function showReview(review: Review, result: MatchResult): void {
  // Forgotten first, so reopening the match already on screen starts clean too.
  store.set({ match: null, leftMatch: null });
  // The feed is filled from the history as the table opens.
  reviewing = true;
  try {
    onState(review.state, review.you, 0);
  } finally {
    reviewing = false;
  }
  showFinished({ type: 'finished', result, ranking: review.ranking });
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

/**
 * The room on screen was closed before its match ended: a practice match
 * replaced by one started in another tab, or one left unwatched. Back to the
 * lobby, saying why, rather than a clock frozen at zero.
 */
export function onRoomClosed(message: Extract<ServerMessage, { type: 'closed' }>): void {
  if (app.match?.matchId !== message.matchId) return;
  if (replayTimer) clearTimeout(replayTimer);
  replayTimer = null;
  store.set({ match: null, you: null, replaying: false, pendingFinish: null });
  disposeArena();
  hideResult();
  showLobbyScreen();
  toast(`That match was closed: ${message.reason}.`, 'info');
}

/** Folds what changed into the match on screen, and redraws it. A delta for another match is stale and dropped. */
export function onDelta(message: Extract<ServerMessage, { type: 'delta' }>): void {
  if (!app.match || app.match.matchId !== message.delta.matchId) return;
  onState(applyDelta(app.match, message.delta), app.you, Date.now() + message.msRemaining, message.waitingFor, message.holdMs);
}

/** What belongs to one match alone: cleared when another takes its place. Shared, so never mutated. */
const FRESH_MATCH: Partial<AppState> = {
  committedRound: null,
  revealedRound: null,
  avatars: [],
  dossier: new Map<string, PlayStyle>(),
  replaying: false,
  pendingFinish: null,
};

export function onState(
  state: PublicMatchState,
  you: number | null,
  deadline: number,
  waitingFor: readonly number[] = [],
  /** What is left of the server's replay hold, for a page that missed the `round` that began it. */
  holdMs = 0,
): void {
  // A table the player walked away from: what it does next is not shown.
  if (state.matchId === app.leftMatch) return;
  const switched = app.match?.matchId !== state.matchId;
  if (switched) {
    // A replay from the previous match must not close this one's controls.
    if (replayTimer) clearTimeout(replayTimer);
    replayTimer = null;
    replayedRound = null;
    disposeArena();
    dom.feed.replaceChildren();
    hideResult();
    resetAnalysis();
    dom.movePanel.classList.remove('hidden');
    dom.roundRecap.classList.add('hidden');
    dom.roundAnnounce.textContent = '';
    showMatchScreen();
    // The rounds already played, so a table opened mid-match, or just after
    // it ended, has its history and not an empty feed.
    for (const record of state.history) appendRound(roundLines(record), record.round, record.eliminated);
    tableSeen = [...app.lobbies.live, ...app.lobbies.open].find((entry) => entry.matchId === state.matchId) ?? null;
    if (you !== null) callBack('Match starting', 'Your table is open: round 1 is about to begin.');
  }
  const committedRound = switched ? null : app.committedRound;
  store.set({
    ...(switched ? FRESH_MATCH : {}),
    match: state,
    you,
    deadline,
    waitingFor: [...waitingFor],
    draft: keptDraft(state, you, switched ? null : app.draft, committedRound),
  });
  // Opened after it ended: no `finished` is coming, so say who won from the table.
  if (switched && state.phase === MatchPhase.Finished && !reviewing) showEnded(state);
  // Attached mid-hold: the clock the server sent counts the hold and the
  // commit window together, so hold the controls and clock for the rest of it.
  if (holdMs > 0 && !app.replaying && state.phase === MatchPhase.Commit) startReplay(holdMs);
  revealIfDue();
}

/**
 * The draft carried into a new snapshot. It is kept from round to round so a
 * player can lock in the same move again, but one the cooldowns now rule out
 * is dropped — it would be sealed, rejected at reveal, and cost the round —
 * and a strike on a seat since eliminated moves to whoever the target picker
 * now leads with, so the move on screen is always the move that would be
 * sealed.
 */
function keptDraft(
  state: PublicMatchState,
  you: number | null,
  draft: AppState['draft'],
  committedRound: number | null,
): AppState['draft'] {
  if (!draft || committedRound === state.round) return draft;
  const me = you === null ? undefined : state.players.find((player) => player.index === you);
  if (me && !isLegalAction(draft.action, me)) return null;
  if (draft.action !== Action.Strike) return draft;
  const targets = targetOptions(state, you).map(([value]) => Number(value));
  return targets.includes(draft.target) ? draft : { ...draft, target: targets[0] ?? 0 };
}

// ------------------------------------------------------------ commit & reveal

/** The phase plan for the match on screen, as the store has it now. */
function currentPlan(state: PublicMatchState): PhasePlan {
  return phasePlan(state, {
    you: app.you,
    committedRound: app.committedRound,
    revealedRound: app.revealedRound,
    draft: app.draft,
    replaying: app.replaying,
    replayedRound,
  });
}

/**
 * Sends this round's reveal if it is due: the moment the server opens the
 * window, because the player already chose in the commit phase, and making
 * them click twice would only produce accidental no-shows. An action, run
 * after each new snapshot and when a replay hold ends; no render sends it.
 */
function revealIfDue(): void {
  const state = app.match;
  if (state && currentPlan(state).shouldReveal) revealNow(state);
}

/** True once the match on screen has ended: by its phase, or by its result being up. */
function matchOver(): boolean {
  return app.match?.phase === MatchPhase.Finished || !dom.resultPanel.classList.contains('hidden');
}

function lockIn(): void {
  if (matchOver() || eliminated() || (app.match !== null && app.you === null)) {
    leaveMatch();
    return;
  }
  const state = app.match;
  const draft = app.draft;
  if (!state || !draft || app.you === null) return;
  const key = app.grantKey;
  if (!key) {
    dom.moveStatus.textContent = 'Log in to play: there is no session key to sign your move.';
    return;
  }

  const salt = freshSalt();
  const sealed = { action: draft.action, target: draft.target, salt };
  // Store before sending: a crash after the server accepts the commitment but
  // before we persist would leave a commitment we can no longer open.
  rememberMove(state.matchId, state.round, sealed);

  const place = { matchId: state.matchId, round: state.round, seat: app.you };
  void sendCommit(key, place, sealed, dom.holdMoves.checked);
  store.set({ committedRound: state.round });
  dom.moveStatus.textContent = `Sealed: ${describeDraft(draft)}`;
  // A stamp: the button punches down and springs back as the move seals.
  gsap.fromTo(dom.lockIn, { scale: 0.94 }, { scale: 1, duration: 0.45, ease: 'elastic.out(1, 0.45)' });
  dom.movePanel.classList.remove('sealing');
  void dom.movePanel.offsetWidth;
  dom.movePanel.classList.add('sealing');
}

/**
 * Signs and sends a commitment. The session key signs it, so the server can
 * show it in the transcript but never forge one; a held move is signed as the
 * reveal it stands in for.
 */
async function sendCommit(key: GrantedKey, place: MovePlace, sealed: SealedMove, hold: boolean): Promise<void> {
  try {
    const commitment = commitMove(place.matchId, place.round, place.seat, sealed);
    const signature = await key.signCommit(place, commitment);
    const held = hold ? { ...sealed, signature: await key.signReveal(place, sealed) } : null;
    net.send({
      type: 'commit',
      commitment,
      signature,
      // Names the round, so a commit flushed late from the offline queue is
      // refused instead of being taken for a later round's.
      matchId: place.matchId,
      round: place.round,
      ...(held ? { hold: held } : {}),
    });
    // Held, the server reveals it: as far as the transcript goes, it was revealed.
    if (held) updateMove(place.matchId, place.round, { revealed: true });
  } catch (error) {
    dom.moveStatus.textContent = `Could not sign your move: ${explainError(error)}`;
  }
}

function revealNow(state: PublicMatchState): void {
  const stored = recallMove(state.matchId, state.round);
  if (!stored) {
    dom.moveStatus.textContent = 'No sealed move for this round — sitting it out.';
    return;
  }
  const key = app.grantKey;
  if (!key || app.you === null) {
    dom.moveStatus.textContent = 'No session key to sign the reveal — log in again.';
    return;
  }
  store.set({ revealedRound: state.round });
  dom.moveStatus.textContent = 'Revealed. Resolving…';
  void sendReveal(key, { matchId: state.matchId, round: state.round, seat: app.you }, {
    action: stored.action,
    target: stored.target,
    salt: stored.salt,
  });
}

async function sendReveal(key: GrantedKey, place: MovePlace, move: SealedMove): Promise<void> {
  try {
    const signature = await key.signReveal(place, move);
    net.send({
      type: 'reveal',
      action: move.action,
      target: move.target,
      salt: move.salt,
      signature,
      matchId: place.matchId,
      round: place.round,
    });
    updateMove(place.matchId, place.round, { revealed: true });
  } catch (error) {
    dom.moveStatus.textContent = `Could not sign your reveal: ${explainError(error)}`;
  }
}

// ------------------------------------------------------------------ rendering
//
// Each of these redraws from the store and sends nothing. They are
// subscribed in `wireMatchControls`, in the order they must run: the table
// first, because the controls read the target picker it fills.

/** The arena and the target picker: what the table looks like. */
function renderTable(): void {
  const state = app.match;
  if (!state) return;
  void renderArena(state, app.you);
  fillSelect(dom.target, targetOptions(state, app.you));
  if (app.draft?.action === Action.Strike) dom.target.value = String(app.draft.target);
}

async function renderArena(state: PublicMatchState, you: number | null): Promise<void> {
  if (!arena) {
    const pending = (mounting ??= mountArena());
    const mounted = await pending;
    // Disposed while it mounted: the match it was for is gone.
    if (mounting !== pending) return;
    arena = mounted;
    arena.onPick = pickTarget;
  }
  arena.render(state, you);
  // After the render, which is what creates the seats: avatars that landed
  // while the canvas was still being made, or before this match's first
  // state, had no seat to go on. A seat already wearing its face skips it.
  if (app.avatars.length > 0) arena.setAvatars(app.avatars);
  renderMove();
}

async function mountArena(): Promise<Arena> {
  const { Arena } = await import('../arena/arena.js');
  return Arena.mount(dom.arena);
}

const COACHED_KEY = 'lms:coached';

/**
 * A first practice match walks through the moves, one round at a time:
 * Strike and aiming, then Guard, then Charge and the cooldowns. Shown
 * once per browser; the end of that match ends it.
 */
function renderCoach(state: PublicMatchState): void {
  const text =
    readRaw(COACHED_KEY) !== '1' && app.you !== null && isPracticeTable(state.players) && state.phase === MatchPhase.Commit
      ? coachLine(state.round)
      : null;
  dom.coach.textContent = text ?? '';
  dom.coach.classList.toggle('hidden', text === null);
}

function coachLine(round: number): string | null {
  switch (round) {
    case 1:
      return 'Your first match. Pick Strike (key 1), click a seat in the arena to aim at it, then Lock in before the timer runs out.';
    case 2:
      return 'Guard (2) blocks one strike aimed at you and hits that striker back. You cannot Guard two rounds in a row.';
    case 3:
      return 'Charge (3) loads your next Strike to hit much harder, but strikes on you hurt more while you charge, and everyone can see it.';
    case 4:
      return 'Everyone moves at once, so read the table: the Reads tab shows each seat’s habits. Last one standing wins.';
    default:
      return null;
  }
}

/** The phase heading, the move buttons, the lock-in button and the status line. */
function renderControls(): void {
  const state = app.match;
  if (!state) return;
  renderCoach(state);
  const plan = currentPlan(state);
  renderPhaseLabel(plan.label);
  setActionsEnabled(plan.actionsEnabled);
  // Once the match is over, or the player is out of it, the lock-in button
  // is the way back to the lobby.
  dom.lockIn.disabled = matchOver() || eliminated() ? false : plan.lockInDisabled;
  if (plan.statusText !== null) dom.moveStatus.textContent = plan.statusText;
  renderMove();
}

/**
 * Everything that follows from the draft: the target chips, the lock-in
 * button's label, the sealed state, and the aim drawn in the arena.
 */
function renderMove(): void {
  const state = app.match;
  const draft = app.draft;
  const sealed = state !== null && app.committedRound === state.round;
  const striking = draft?.action === Action.Strike;

  const finished = matchOver();
  const out = !finished && yourSeat(state)?.alive === false;
  dom.movePanel.classList.toggle('sealed', sealed && !finished);
  // Nothing left to pick: the move buttons give way to what matters now.
  dom.movePanel.classList.toggle('done', finished || out);
  dom.targetRow.classList.toggle('hidden', !striking || finished || out);
  for (const button of dom.actionBar.querySelectorAll<HTMLButtonElement>('.action')) {
    const chosen = actionOf(button) === draft?.action;
    button.setAttribute('aria-pressed', String(chosen));
    button.classList.toggle('selected', chosen);
  }

  const watching = !finished && state !== null && app.you === null;
  // Only a seat has a move to hold.
  dom.holdMoves.closest('label')?.classList.toggle('hidden', app.you === null);
  dom.lockIn.textContent = out ? 'Eliminated · leave to lobby' : watching ? 'Stop watching' : lockInLabel(finished, sealed, draft);
  dom.lockIn.title = out ? 'You are out of this match. Leave, or stay and watch the rest.' : '';
  if (watching) dom.lockIn.disabled = false;

  const hp = new Map(state?.players.map((player) => [player.index, player.hp]) ?? []);
  const options = [...dom.target.options].map((option) => Number(option.value));
  dom.targetChips.replaceChildren(
    ...options.map((seat) => {
      const chip = element('button', striking && draft?.target === seat ? 'chip active' : 'chip');
      chip.type = 'button';
      chip.disabled = !controlsOpen;
      // No HP mid-replay: the snapshot already holds the HP the replay is
      // still on its way to.
      chip.append(element('b', '', `#${seat}`), element('span', '', app.replaying ? '' : `${hp.get(seat) ?? '?'} hp`));
      chip.onclick = () => pickTarget(seat);
      return chip;
    }),
  );

  arena?.setAim(app.you !== null ? draft : null, sealed, controlsOpen ? options : []);
}

function lockInLabel(finished: boolean, sealed: boolean, draft: AppState['draft']): string {
  if (finished) return '← Back to lobby';
  if (sealed) return '✓ Move sealed';
  if (!controlsOpen) return 'Lock in move';
  return draft ? `Lock in · ${describeDraft(draft)}` : 'Pick a move';
}

/** Targets a seat, from a chip or a click in the arena: a strike on it. */
function pickTarget(seat: number): void {
  if (!controlsOpen) return;
  if (![...dom.target.options].some((option) => option.value === String(seat))) return;
  selectAction(Action.Strike, seat);
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
  dom.phaseLabel.replaceChildren(round ?? '', element('span', `phase-chip ${phase}`, phase));
}

function renderReads(): void {
  const state = app.match;
  const you = app.you;
  if (!state) return;
  const reads = readOpponents(state, you, app.dossier);
  // A regular's record is worth showing before the first round, too.
  if (reads.length === 0 || (state.history.length === 0 && app.dossier.size === 0)) {
    dom.reads.replaceChildren(element('p', 'muted small', 'Patterns appear once the first round resolves.'));
    return;
  }

  dom.reads.replaceChildren(readsTable(reads));
}

function readsTable(reads: Read[]): HTMLTableElement {
  const head = element('tr');
  for (const label of ['seat', '⚔️', '🛡️', '⚡', 'favours', 'tell']) head.append(element('th', '', label));

  const body = element('tbody');
  for (const read of reads) {
    const row = element('tr', read.alive ? '' : 'dead');
    const favourite = read.favourite === null ? '—' : `#${read.favourite}`;
    for (const value of [`#${read.seat}`, String(read.strikes), String(read.guards), String(read.charges), favourite]) {
      row.append(element('td', '', value));
    }
    row.append(element('td', 'tell', read.tell));
    body.append(row);
    if (read.past) {
      const past = element('tr', read.alive ? 'past' : 'past dead');
      const cell = element('td', '', read.past);
      cell.colSpan = 5;
      past.append(element('td'), cell);
      body.append(past);
    }
  }

  const thead = element('thead');
  thead.append(head);
  const table = element('table');
  table.append(thead, body);
  return table;
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
  const li = element('li', className || lineKind(text), text);
  if (app.you !== null && text.startsWith(`#${app.you} `)) li.classList.add('mine');
  dom.feed.append(li);
}

/** Colours a history line by what it describes. */
function lineKind(text: string): string {
  if (text.includes('struck')) return 'act-strike';
  if (text.includes('guarded')) return 'act-guard';
  if (text.endsWith('charged')) return 'act-charge';
  if (text.includes('eliminated')) return 'kill';
  if (text.endsWith('no move')) return 'act-none';
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
  // While the last round replays, the clock holds the next one closed: no
  // countdown until the commit window really opens.
  dom.timer.textContent = app.replaying ? '' : formatCountdown(phase, app.deadline, now, app.waitingFor.length);

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
  const deciding = phase === MatchPhase.Commit && !app.replaying && !sealed && app.you !== null && !eliminated();
  dom.movePanel.classList.toggle('urgent', deciding && left < 5_000);
  // Ten seconds out the timer pulses, and a screen reader hears it once.
  const warning = deciding && left < 10_000 && left > 0;
  dom.timer.classList.toggle('warning', warning);
  const roundKey = `${state?.matchId}:${state?.round}`;
  if (warning && warnedFor !== roundKey) {
    warnedFor = roundKey;
    dom.roundAnnounce.textContent = '10 seconds left to lock in a move.';
    cue('warning');
  }
  // A round opens for this seat: one soft note, if the player wants them.
  if (deciding && openedFor !== roundKey) {
    openedFor = roundKey;
    cue('round');
  }
}

/** The round the "round opens" cue was last played for. */
let openedFor = '';

/** The round the 10-second warning was last read out for. */
let warnedFor = '';

// ------------------------------------------------------------------- controls

const HOLD_KEY = 'lms:hold-moves';

/**
 * The action an `.action` button stands for. Throws on markup that names none,
 * rather than sending it. `None` is no button's action, and `Number('')` is 0.
 */
function actionOf(button: HTMLButtonElement): ActionValue {
  const action = Number(button.dataset.action);
  if (!isActionValue(action) || action === Action.None) throw new Error(`.action button has no valid data-action: "${button.dataset.action}"`);
  return action;
}

export function wireMatchControls(): void {
  dom.holdMoves.checked = readRaw(HOLD_KEY) === '1';
  dom.holdMoves.onchange = () => writeRaw(HOLD_KEY, dom.holdMoves.checked ? '1' : '0');
  dom.soundCues.checked = soundOn();
  dom.soundCues.onchange = () => setSound(dom.soundCues.checked);
  for (const button of dom.actionBar.querySelectorAll<HTMLButtonElement>('.action')) {
    button.onclick = () => selectAction(actionOf(button));
  }

  dom.target.onchange = () => {
    if (app.draft) store.set({ draft: { ...app.draft, target: Number(dom.target.value) } });
  };

  store.subscribe(['match', 'you'], renderTable);
  store.subscribe(['match', 'you', 'dossier'], renderReads);
  store.subscribe(['match', 'you', 'draft', 'committedRound', 'revealedRound', 'replaying'], renderControls);
  store.subscribe(['avatars'], () => arena?.setAvatars(app.avatars));
  // No analyst on the server: no tab that can only say so.
  store.subscribe(['analyst'], () => {
    dom.tabAnalysis.classList.toggle('hidden', !app.analyst);
    if (!app.analyst && dom.tabAnalysis.classList.contains('active')) switchTab('feed');
  });
  dom.tabAnalysis.classList.toggle('hidden', !app.analyst);
  dom.resultBack.onclick = leaveMatch;
  // The header's Lobby, from any screen: from a match, it leaves the table.
  dom.navLobby.onclick = () => {
    if (leaveMatchFor()) showScreen('lobby');
  };
  dom.resultAgain.onclick = () => {
    if (againTier) {
      net.send({ type: 'queue', stake: againTier.stake, seats: againTier.seats });
      leaveMatch();
      return;
    }
    const last = app.lastPractice;
    if (last) void startPractice(last.bots, last.difficulty);
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
    if (event.key === '1') clickAction(Action.Strike);
    else if (event.key === '2') clickAction(Action.Guard);
    else if (event.key === '3') clickAction(Action.Charge);
    // Enter only ever seals a move: leaving the table takes a click.
    else if (event.key === 'Enter' && !dom.lockIn.disabled && !matchOver() && !eliminated()) lockIn();
  });
}

/**
 * Back to the lobby from a finished match, or from one the player is out
 * of. Nothing on its table is needed again, so the arena goes with it; a
 * match still running is forgotten here, so its next rounds do not pull the
 * page back to it. Its row in the lobby opens it again.
 */
export function leaveMatch(): void {
  const state = app.match;
  if (state && state.phase !== MatchPhase.Finished && dom.resultPanel.classList.contains('hidden')) {
    if (replayTimer) clearTimeout(replayTimer);
    replayTimer = null;
    store.set({ leftMatch: state.matchId, match: null, you: null, replaying: false, pendingFinish: null });
  }
  disposeArena();
  hideResult();
  showLobbyScreen();
  void renderWinnings();
  // A practice match is archived by now: "Your matches" lists it.
  net.send({ type: 'history' });
}

/**
 * Off the match screen for another, from the header: asks first while the
 * player's seat is still in a running match, then leaves the table as
 * `leaveMatch` does. False when they chose to stay.
 */
export function leaveMatchFor(): boolean {
  if (currentScreen() !== 'match') return true;
  const playing = !matchOver() && app.you !== null && !eliminated();
  if (playing && !window.confirm('Leave this match? Your seat keeps playing without you.')) {
    return false;
  }
  leaveMatch();
  return true;
}

/** True while the player's seat is out of a match that is still running. */
function eliminated(): boolean {
  return !matchOver() && yourSeat(app.match)?.alive === false;
}

/** Picks a move: a strike on `seat`, or on whoever the target picker shows. */
function selectAction(action: ActionValue, seat?: number): void {
  const target = action === Action.Strike ? (seat ?? Number(dom.target.value || 0)) : 0;
  const draft = { action, target };
  store.set({ draft });
  dom.moveStatus.textContent = `Ready: ${describeDraft(draft)} — Enter to lock in`;
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

/** Your seat as the snapshot shows it: HP, whether a Charge is loaded, last round's action. */
function yourSeat(state: PublicMatchState | null) {
  return app.you === null ? undefined : state?.players.find((player) => player.index === app.you);
}

/**
 * Opens or closes the move buttons. Open ones still respect your cooldowns:
 * Guard and Charge cannot follow themselves and Charge cannot stack, so those
 * buttons stay shut with the reason on them, and Strike says when it is loaded.
 */
function setActionsEnabled(enabled: boolean): void {
  controlsOpen = enabled;
  const state = app.match;
  const me = yourSeat(state);
  for (const button of dom.actionBar.querySelectorAll<HTMLButtonElement>('.action')) {
    const action = actionOf(button);
    const legal = !me || isLegalAction(action, me);
    button.disabled = !enabled || !legal;
    button.classList.toggle('cooldown', !legal);
    // The markup's own tooltip, kept so it comes back once the cooldown ends.
    button.dataset.title ??= button.title;
    button.title = legal ? button.dataset.title : cooldownReason(action, me?.charged ?? false);
    if (action === Action.Strike) {
      const loaded = me?.charged ?? false;
      button.classList.toggle('loaded', loaded);
      const desc = button.querySelector('.action-desc');
      if (desc && state) {
        desc.textContent = loaded
          ? `Loaded: hits for ${strikeDamageFor(state.rules, true)}`
          : 'Hit one seat, heal on a hit';
      }
    }
  }
}

function cooldownReason(action: ActionValue, charged: boolean): string {
  if (action === Action.Guard) return 'You guarded last round — Guard is on cooldown';
  return charged ? 'Your Charge is already loaded — Strike to spend it' : 'You charged last round — Charge is on cooldown';
}

function lockControls(reason: string): void {
  setActionsEnabled(false);
  dom.lockIn.disabled = true;
  dom.moveStatus.textContent = reason;
  renderMove();
}
