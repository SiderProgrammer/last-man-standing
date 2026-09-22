import { encodeFunctionData, formatEther, parseEther } from 'viem';
import {
  ACTION_NAMES,
  AUTH_PREFIX,
  Action,
  MatchPhase,
  chainCss,
  chainInfo,
  commitMove,
  errorFirstLine,
  sameAddress,
  gameEscrowAbi,
  playerAvatarsAbi,
  type ActionValue,
  type BookSnapshot,
  type AvatarCollectionInfo,
  type AvatarEntry,
  type LobbyInfo,
  type LobbySeat,
  type PublicMatchState,
  type ServerMessage,
} from '@lms/protocol';
import { Arena } from './arena.js';
import { Net } from './net.js';
import { readOpponents } from './reads.js';
import { forgetMatch, freshSalt, recallMove, rememberMove } from './salts.js';
import { Session } from './session.js';
import { Wallet } from './wallet.js';

const SERVER_URL = import.meta.env.VITE_WS_URL ?? `ws://${location.hostname}:8787`;

const dom = {
  connect: byId<HTMLButtonElement>('connect'),
  chainLabel: byId<HTMLSpanElement>('chain-label'),
  chipsLabel: byId<HTMLSpanElement>('chips-label'),
  lobbyScreen: byId<HTMLElement>('lobby-screen'),
  matchScreen: byId<HTMLElement>('match-screen'),
  practice: byId<HTMLButtonElement>('practice'),
  botCount: byId<HTMLSelectElement>('bot-count'),
  refreshLobbies: byId<HTMLButtonElement>('refresh-lobbies'),
  createLobby: byId<HTMLButtonElement>('create-lobby'),
  stake: byId<HTMLInputElement>('stake'),
  seats: byId<HTMLSelectElement>('seats'),
  lobbyList: byId<HTMLUListElement>('lobby-list'),
  avatarChain: byId<HTMLSpanElement>('avatar-chain'),
  avatarPreview: byId<HTMLImageElement>('avatar-preview'),
  avatarStatus: byId<HTMLSpanElement>('avatar-status'),
  mintAvatar: byId<HTMLButtonElement>('mint-avatar'),
  sessionState: byId<HTMLSpanElement>('session-state'),
  sessionStatus: byId<HTMLSpanElement>('session-status'),
  enableSession: byId<HTMLButtonElement>('enable-session'),
  revokeSession: byId<HTMLButtonElement>('revoke-session'),
  arena: byId<HTMLDivElement>('arena'),
  phaseLabel: byId<HTMLHeadingElement>('phase-label'),
  timer: byId<HTMLSpanElement>('timer'),
  actionBar: byId<HTMLDivElement>('action-bar'),
  targetRow: byId<HTMLDivElement>('target-row'),
  target: byId<HTMLSelectElement>('target'),
  lockIn: byId<HTMLButtonElement>('lock-in'),
  moveStatus: byId<HTMLParagraphElement>('move-status'),
  bookRound: byId<HTMLSpanElement>('book-round'),
  betTarget: byId<HTMLSelectElement>('bet-target'),
  betChips: byId<HTMLInputElement>('bet-chips'),
  placeBet: byId<HTMLButtonElement>('place-bet'),
  bookList: byId<HTMLUListElement>('book-list'),
  tabFeed: byId<HTMLButtonElement>('tab-feed'),
  tabReads: byId<HTMLButtonElement>('tab-reads'),
  feed: byId<HTMLOListElement>('feed'),
  reads: byId<HTMLDivElement>('reads'),
  toast: byId<HTMLDivElement>('toast'),
};

interface AppState {
  wallet: Wallet | null;
  nonce: string;
  chainId: number;
  escrow: `0x${string}` | null;
  /** Where `PlayerAvatars` lives, per chain. Minting happens on the player's own chain. */
  avatarCollections: AvatarCollectionInfo[];
  /** 7702 delegate the account may point at, or null if the server cannot verify one. */
  sessionDelegate: `0x${string}` | null;
  /** Live session key, if this browser holds one. Signs logins without a prompt. */
  session: Session | null;
  match: PublicMatchState | null;
  /**
   * Avatars for the current match, held here rather than pushed straight at the
   * arena: they can arrive before `Arena.mount` has resolved, and the arena is
   * rebuilt on every match switch.
   */
  avatars: AvatarEntry[];
  you: number | null;
  deadline: number;
  book: BookSnapshot | null;
  /** Action the player has selected but not yet sealed. */
  draft: { action: ActionValue; target: number } | null;
  /** Round whose commitment is already on the server. */
  committedRound: number | null;
  /** Round whose reveal is already on the server. */
  revealedRound: number | null;
}

const app: AppState = {
  wallet: null,
  nonce: '',
  chainId: 0,
  escrow: null,
  avatarCollections: [],
  sessionDelegate: null,
  session: null,
  match: null,
  avatars: [],
  you: null,
  deadline: 0,
  book: null,
  draft: null,
  committedRound: null,
  revealedRound: null,
};

let arena: Arena | null = null;

const net = new Net(
  SERVER_URL,
  () => void authenticate(),
  (connected) => {
    if (!connected) dom.chainLabel.textContent = 'reconnecting…';
  },
);

net.on(onServerMessage);
net.connect();
wireControls();
setInterval(updateTimer, 200);

// ---------------------------------------------------------------- server feed

function onServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case 'hello':
      app.nonce = message.nonce;
      app.chainId = message.chainId;
      app.escrow = message.escrow;
      app.avatarCollections = message.avatarCollections;
      app.sessionDelegate = message.sessionDelegate;
      renderHubLabel();
      renderSessionPanel();
      void renderAvatarPanel();
      dom.createLobby.disabled = !message.escrow;
      break;

    case 'authed':
      dom.connect.textContent = short(message.address);
      dom.connect.disabled = true;
      net.flush();
      net.send({ type: 'lobbies' });
      // A reconnect drops the socket, not the seat: ask to be re-attached to the
      // match that is still running on the server.
      if (app.match && app.match.phase !== MatchPhase.Finished) {
        net.send({ type: 'watch', matchId: app.match.matchId });
      }
      break;

    case 'lobbies':
      renderLobbies(message.open, message.live);
      break;

    case 'state':
      onState(message.state, message.you, message.deadline, message.chips, message.book);
      break;

    case 'avatars':
      // Late by design: the match is already running by the time these resolve.
      if (message.matchId !== app.match?.matchId) break;
      app.avatars = message.entries;
      arena?.setAvatars(message.entries);
      break;

    case 'round': {
      app.book = message.book;
      setChips(message.chips);
      appendRound(message.lines, message.record.round, message.record.eliminated);
      arena?.showRound(message.record);
      break;
    }

    case 'finished': {
      setChips(message.chips);
      const winner = message.ranking[0];
      const youWon = winner !== undefined && winner === app.you;
      appendLine(
        youWon
          ? `You are the last one standing after ${message.result.rounds} rounds.`
          : `Match over — seat #${winner ?? '?'} took it after ${message.result.rounds} rounds.`,
        'round-head',
      );
      forgetMatch(message.result.matchId);
      lockControls('Match finished.');
      break;
    }

    case 'relayed':
      toast(`Sent without a wallet prompt · ${short(message.hash)}`);
      net.send({ type: 'lobbies' });
      void renderAvatarPanel();
      break;

    case 'error':
      toast(message.message);
      break;
  }
}

function onState(
  state: PublicMatchState,
  you: number | null,
  deadline: number,
  chips: number,
  book: BookSnapshot,
): void {
  const switched = app.match?.matchId !== state.matchId;
  app.match = state;
  app.you = you;
  app.deadline = deadline;
  app.book = book;
  setChips(chips);

  if (switched) {
    app.committedRound = null;
    app.revealedRound = null;
    app.draft = null;
    app.avatars = [];
    dom.feed.replaceChildren();
    showMatchScreen();
  }

  void renderArena(state, you);
  renderTargets(state, you);
  renderBook(state);
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
  const seated = app.you !== null;
  const committed = app.committedRound === state.round;

  if (state.phase === MatchPhase.Commit) {
    dom.phaseLabel.textContent = `Round ${state.round} — commit`;
    setActionsEnabled(seated && !committed);
    dom.lockIn.disabled = !seated || committed || app.draft === null;
    dom.placeBet.disabled = !seated;
    if (committed) dom.moveStatus.textContent = 'Move sealed. Waiting for the table.';
    else if (!seated) dom.moveStatus.textContent = 'Spectating — no seat in this match.';
    else dom.moveStatus.textContent = 'Pick an action before the timer runs out.';
    return;
  }

  if (state.phase === MatchPhase.Reveal) {
    dom.phaseLabel.textContent = `Round ${state.round} — reveal`;
    setActionsEnabled(false);
    dom.lockIn.disabled = true;
    dom.placeBet.disabled = true;
    if (seated && app.revealedRound !== state.round) revealNow(state);
    return;
  }

  dom.phaseLabel.textContent = state.phase === MatchPhase.Finished ? 'Finished' : 'Waiting';
  setActionsEnabled(false);
  dom.lockIn.disabled = true;
  dom.placeBet.disabled = true;
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
  net.send({ type: 'commit', commitment });
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
  const targets = state.players.filter((player) => player.alive && player.index !== you);
  fillSelect(dom.target, targets.map((player) => [String(player.index), `#${player.index}`]));
  fillSelect(
    dom.betTarget,
    state.players
      .filter((player) => player.alive)
      .map((player) => [
        String(player.index),
        player.index === you ? `#${player.index} (you)` : `#${player.index}`,
      ]),
  );
}

function renderBook(state: PublicMatchState): void {
  const book = app.book;
  dom.bookRound.textContent = `round ${state.round}`;
  if (!book) return;

  const entries = Object.entries(book.pots).sort((a, b) => Number(b[1]) - Number(a[1]));
  const total = entries.reduce((sum, [, chips]) => sum + chips, 0);

  dom.bookList.replaceChildren(
    ...entries.map(([seat, chips]) => {
      const yours = book.yours[Number(seat)] ?? 0;
      const li = document.createElement('li');
      const odds = total > 0 ? (total / chips).toFixed(2) : '—';
      li.innerHTML =
        `<span>#${seat}</span>` +
        `<span class="muted small">${chips} chips · ${odds}×${yours ? ` · you ${yours}` : ''}</span>`;
      return li;
    }),
  );
}

function renderReads(state: PublicMatchState, you: number | null): void {
  const reads = readOpponents(state, you);
  if (reads.length === 0 || state.history.length === 0) {
    dom.reads.innerHTML = '<p class="muted small">Patterns appear once the first round resolves.</p>';
    return;
  }

  const rows = reads
    .map(
      (read) => `
      <tr style="opacity:${read.alive ? 1 : 0.45}">
        <td>#${read.seat}</td>
        <td>${read.attacks}</td>
        <td>${read.defends}</td>
        <td>${read.hides}</td>
        <td>${read.favourite === null ? '—' : `#${read.favourite}`}</td>
        <td class="tell">${read.tell}</td>
      </tr>`,
    )
    .join('');

  dom.reads.innerHTML = `
    <table>
      <thead>
        <tr><th>seat</th><th>⚔️</th><th>🛡️</th><th>🏃</th><th>favours</th><th>tell</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderLobbies(open: LobbyInfo[], live: LobbyInfo[]): void {
  if (open.length === 0 && live.length === 0) {
    dom.lobbyList.innerHTML = app.escrow
      ? '<li class="muted small">No staked lobbies yet. Create one above.</li>'
      : '<li class="muted small">Server is running without an escrow: practice only.</li>';
    return;
  }

  dom.lobbyList.replaceChildren(
    ...open.map((lobby) => lobbyRow(lobby, true)),
    ...live.map((lobby) => lobbyRow(lobby, false)),
  );
}

function lobbyRow(lobby: LobbyInfo, joinable: boolean): HTMLLIElement {
  const li = document.createElement('li');
  const label = document.createElement('span');
  label.innerHTML =
    `<strong>${short(lobby.matchId)}</strong> ` +
    `<span class="muted small">${formatEther(BigInt(lobby.stake))} ETH · ` +
    `${lobby.seatCount}/${lobby.maxSeats} seats · ${lobby.status}</span>` +
    chainChips(lobby.players);

  const button = document.createElement('button');
  const seated = lobby.players.some((player) => sameAddress(player.address, app.wallet?.address));

  if (seated || !joinable) {
    button.textContent = seated ? 'Enter' : 'Watch';
    button.onclick = () => {
      net.send({ type: 'watch', matchId: lobby.matchId });
      showMatchScreen();
    };
  } else {
    button.textContent = `Stake ${formatEther(BigInt(lobby.stake))}`;
    button.onclick = () => void joinLobby(lobby);
  }

  li.append(label, button);
  return li;
}

/**
 * One chip per chain represented in the lobby, with a count when several seats
 * came from the same place. Per-chain rather than per-seat: eight identical
 * Sepolia chips say nothing, "3 spokes feeding this pool" is the point.
 */
function chainChips(seats: LobbySeat[]): string {
  const counts = new Map<number, number>();
  for (const seat of seats) counts.set(seat.chainId, (counts.get(seat.chainId) ?? 0) + 1);
  if (counts.size === 0) return '';

  const chips = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([chainId, count]) => {
      const chain = chainInfo(chainId);
      const css = chainCss(chain.color);
      const suffix = count > 1 ? ` ×${count}` : '';
      return (
        `<span class="chain-chip" style="--chain:${css}" title="${chain.name}">` +
        `${chain.short}${suffix}</span>`
      );
    })
    .join('');

  return `<span class="chain-chips">${chips}</span>`;
}

/** The collection deployed to the chain the player's wallet is actually on. */
function avatarCollection(): AvatarCollectionInfo | null {
  const chainId = app.wallet?.chainId ?? 0;
  return app.avatarCollections.find((entry) => entry.chainId === chainId) ?? null;
}

/**
 * Shows what the player owns on their own chain.
 *
 * Reads rather than assumes: the same wallet can hold an avatar on one chain
 * and none on another, and the arena will show whichever one belongs to the
 * chain they staked from.
 */
async function renderAvatarPanel(): Promise<void> {
  const wallet = app.wallet;
  const collection = avatarCollection();

  dom.avatarChain.textContent = collection
    ? chainInfo(collection.chainId).name
    : 'no collection';

  if (!wallet) {
    dom.mintAvatar.disabled = true;
    dom.avatarStatus.textContent = 'Connect a wallet to check.';
    return;
  }

  if (!collection) {
    dom.mintAvatar.disabled = true;
    dom.avatarStatus.textContent = app.avatarCollections.length === 0
      ? 'No avatar collection configured on this server.'
      : `No collection on ${chainInfo(wallet.chainId).name}. Switch chains to mint.`;
    return;
  }

  try {
    const status = await wallet.avatarStatus(collection.address);
    const supply = `${status.totalMinted}/${status.maxSupply} minted`;

    if (status.equipped > 0n) {
      dom.mintAvatar.disabled = true;
      dom.avatarStatus.textContent = `Wearing #${status.equipped} · ${supply}`;
    } else if (status.minted) {
      dom.mintAvatar.disabled = true;
      dom.avatarStatus.textContent = `You own one but wear none · ${supply}`;
    } else if (status.totalMinted >= status.maxSupply) {
      dom.mintAvatar.disabled = true;
      dom.avatarStatus.textContent = `Sold out · ${supply}`;
    } else {
      dom.mintAvatar.disabled = false;
      dom.avatarStatus.textContent = `Free, one per wallet · ${supply}`;
    }
  } catch (error) {
    // Almost always a wallet pointed at a chain the collection is not on.
    dom.mintAvatar.disabled = true;
    dom.avatarStatus.textContent = `Could not read the collection: ${errorFirstLine(error)}`;
  }
}

async function mintAvatar(): Promise<void> {
  const wallet = app.wallet;
  const collection = avatarCollection();
  if (!wallet || !collection) return;

  const relayed = await relayCall(
    collection.address,
    0n,
    encodeFunctionData({ abi: playerAvatarsAbi, functionName: 'mint' }),
  );
  if (relayed) {
    dom.mintAvatar.disabled = true;
    dom.avatarStatus.textContent = 'Minting without a prompt…';
    return;
  }

  try {
    dom.mintAvatar.disabled = true;
    dom.avatarStatus.textContent = 'Confirm in your wallet…';
    const hash = await wallet.mintAvatar(collection.address);
    await wallet.waitFor(hash);
    toast('Avatar minted. You will wear it in your next match.');
  } catch (error) {
    toast(errorFirstLine(error));
  } finally {
    await renderAvatarPanel();
  }
}

/**
 * The hub chain, plus a warning when the connected wallet is pointed somewhere
 * else. A player on the wrong network can read every lobby but every stake they
 * try to place reverts, and the wallet's own error for that is unreadable.
 */
function renderHubLabel(): void {
  const hub = chainInfo(app.chainId);
  const walletChain = app.wallet?.chainId ?? 0;
  const mismatch = walletChain !== 0 && walletChain !== app.chainId;

  dom.chainLabel.style.setProperty('--chain', chainCss(hub.color));
  dom.chainLabel.classList.add('chain-chip');
  dom.chainLabel.classList.toggle('warn', mismatch);

  if (mismatch) {
    dom.chainLabel.textContent = `${hub.name} hub · wallet on ${chainInfo(walletChain).name}`;
    dom.chainLabel.title = 'Switch your wallet to the hub chain to stake directly, or join from a spoke.';
    return;
  }

  dom.chainLabel.textContent = app.escrow ? `${hub.name} hub` : `${hub.name} · practice only`;
  dom.chainLabel.title = `Hub chain ${app.chainId}`;
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

function updateTimer(): void {
  if (!app.match || app.match.phase === MatchPhase.Finished) {
    dom.timer.textContent = '--';
    return;
  }
  const left = Math.max(0, app.deadline - Date.now());
  dom.timer.textContent = `${(left / 1000).toFixed(1)}s`;
}

// ------------------------------------------------------------------- controls

function wireControls(): void {
  dom.connect.onclick = () => void connectWallet();

  dom.practice.onclick = () => {
    net.send({ type: 'practice', bots: Number(dom.botCount.value) });
  };

  dom.refreshLobbies.onclick = () => net.send({ type: 'lobbies' });
  dom.mintAvatar.onclick = () => void mintAvatar();
  dom.enableSession.onclick = () => void enableSession();
  dom.revokeSession.onclick = () => void revokeSession();
  dom.createLobby.onclick = () => void createLobby();

  for (const button of dom.actionBar.querySelectorAll<HTMLButtonElement>('.action')) {
    button.onclick = () => selectAction(Number(button.dataset.action) as ActionValue, button);
  }

  dom.target.onchange = () => {
    if (app.draft) app.draft.target = Number(dom.target.value);
  };

  dom.lockIn.onclick = lockIn;

  dom.placeBet.onclick = () => {
    net.send({
      type: 'bet',
      target: Number(dom.betTarget.value),
      chips: Number(dom.betChips.value),
    });
  };

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

async function connectWallet(): Promise<void> {
  try {
    const devKey = import.meta.env.DEV ? import.meta.env.VITE_DEV_KEY : undefined;
    app.wallet =
      Wallet.available() || !devKey
        ? await Wallet.connect()
        : Wallet.burner(devKey as `0x${string}`, import.meta.env.VITE_RPC_URL);
    restoreSession();
    renderHubLabel();
    renderSessionPanel();
    void renderAvatarPanel();
    await authenticate();
  } catch (error) {
    console.error('[wallet]', error);
    toast(errorFirstLine(error));
  }
}

async function authenticate(): Promise<void> {
  const wallet = app.wallet;
  if (!wallet || !app.nonce) return;

  const message = `${AUTH_PREFIX}${app.nonce}`;
  try {
    // The session key is the whole point of the delegation: reconnects are
    // routine, and each one would otherwise interrupt the player mid-round.
    const signature = app.session
      ? await app.session.signLogin(message)
      : await wallet.signLogin(app.nonce);
    net.send({ type: 'auth', address: wallet.address, signature });
  } catch (error) {
    console.error('[auth]', error);
    if (app.session) {
      // A key the chain no longer honours is worse than none: drop it and let
      // the next attempt go through the wallet.
      app.session = null;
      Session.forget(wallet.address, wallet.chainId);
      renderSessionPanel();
      toast('Session key rejected — falling back to your wallet.');
      return;
    }
    toast(`Login signature failed: ${errorFirstLine(error)}`);
  }
}

// ------------------------------------------------------------------ sessions

/** How long a granted key lasts. Long enough to cover a sitting, not a month. */
const SESSION_HOURS = 12;
/** Cumulative value a session key may move, across every call it makes. */
const SESSION_SPEND_CAP = parseEther('0.05');

function renderSessionPanel(): void {
  const wallet = app.wallet;
  const active = app.session;

  dom.sessionState.textContent = active ? 'on' : 'off';
  dom.sessionState.classList.toggle('chain-chip', Boolean(active));
  dom.revokeSession.classList.toggle('hidden', !active);

  if (!wallet) {
    dom.enableSession.disabled = true;
    dom.sessionStatus.textContent = 'Connect a wallet to set up.';
    return;
  }

  if (!app.sessionDelegate) {
    dom.enableSession.disabled = true;
    dom.sessionStatus.textContent =
      'This server has no session delegate configured, so logins use your wallet.';
    return;
  }

  if (active) {
    dom.enableSession.disabled = true;
    const hours = Math.floor(active.secondsLeft() / 3600);
    const minutes = Math.floor((active.secondsLeft() % 3600) / 60);
    dom.sessionStatus.textContent =
      `Signing in without prompts · expires in ${hours}h ${minutes}m · ` +
      `capped at ${formatEther(SESSION_SPEND_CAP)} ETH`;
    return;
  }

  dom.enableSession.disabled = false;
  dom.sessionStatus.textContent =
    `One signature now, then ${SESSION_HOURS}h of prompt-free reconnects.`;
}

/** Picks up a key this browser already holds for the connected account. */
function restoreSession(): void {
  const wallet = app.wallet;
  if (!wallet || !app.sessionDelegate) {
    app.session = null;
    return;
  }
  app.session = Session.load(wallet.address, wallet.chainId, app.sessionDelegate);
}

async function enableSession(): Promise<void> {
  const wallet = app.wallet;
  const delegate = app.sessionDelegate;
  if (!wallet || !delegate) return;

  const validUntil = Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600;
  const session = Session.create(wallet.address, wallet.chainId, delegate, validUntil);

  try {
    dom.enableSession.disabled = true;
    dom.sessionStatus.textContent = 'Confirm the delegation in your wallet…';

    const hash = await wallet.grantSession(
      delegate,
      session.address,
      validUntil,
      SESSION_SPEND_CAP,
      { escrow: app.escrow, avatars: avatarCollection()?.address ?? null },
    );
    await wallet.waitFor(hash);

    // Stored only now: a key saved before the grant confirmed would fail every
    // login while a perfectly good wallet sat unused next to it.
    session.save();
    app.session = session;
    toast('One-click play is on. Reconnects will not prompt your wallet.');
  } catch (error) {
    toast(errorFirstLine(error));
  } finally {
    renderSessionPanel();
  }
}

/**
 * Sends a call through the session key instead of the wallet.
 *
 * Returns false when there is no usable session, so callers fall back to a
 * normal wallet transaction rather than leaving the player stuck: a relayer
 * that is offline or a session that has lapsed should cost a prompt, not the
 * ability to play.
 */
async function relayCall(target: `0x${string}`, value: bigint, data: `0x${string}`): Promise<boolean> {
  const wallet = app.wallet;
  const session = app.session;
  if (!wallet || !session) return false;

  try {
    const nonce = await wallet.sessionNonce();
    const signature = await session.signCall(target, value, data, nonce);
    net.send({
      type: 'relay',
      target,
      value: value.toString(),
      data,
      nonce: nonce.toString(),
      signature,
    });
    return true;
  } catch (error) {
    console.warn('[session] relay failed, falling back to the wallet', error);
    return false;
  }
}

async function revokeSession(): Promise<void> {
  const wallet = app.wallet;
  const session = app.session;
  if (!wallet || !session) return;

  try {
    dom.revokeSession.disabled = true;
    const hash = await wallet.revokeSession(session.address);
    await wallet.waitFor(hash);
    toast('Session key revoked.');
  } catch (error) {
    toast(errorFirstLine(error));
  } finally {
    // Forgotten locally either way: a key the player asked to be rid of should
    // not keep being offered just because the transaction failed.
    Session.forget(wallet.address, wallet.chainId);
    app.session = null;
    dom.revokeSession.disabled = false;
    renderSessionPanel();
  }
}

async function createLobby(): Promise<void> {
  const { wallet, escrow } = app;
  if (!wallet || !escrow) return toast('Connect a wallet first.');
  try {
    dom.createLobby.disabled = true;
    const hash = await wallet.createMatch(escrow, dom.stake.value, Number(dom.seats.value));
    await wallet.waitFor(hash);
    // Creating does not seat you: join explicitly so the stake is escrowed.
    net.send({ type: 'lobbies' });
    toast('Lobby created. Stake into it to take a seat.');
  } catch (error) {
    toast(errorFirstLine(error));
  } finally {
    dom.createLobby.disabled = false;
  }
}

async function joinLobby(lobby: LobbyInfo): Promise<void> {
  const { wallet, escrow } = app;
  if (!wallet || !escrow) return toast('Connect a wallet first.');

  // The session key covers `join`, so a staked seat costs no prompt at all.
  const relayed = await relayCall(
    escrow,
    BigInt(lobby.stake),
    encodeFunctionData({ abi: gameEscrowAbi, functionName: 'join', args: [lobby.matchId] }),
  );
  if (relayed) {
    // No `watch` yet: the relay is still in flight, and the room does not exist
    // until the lobby fills and the oracle seeds it. The `relayed` reply
    // refreshes the directory, and the row turns into an Enter button.
    toast('Seat requested. The match starts when the lobby fills.');
    return;
  }

  try {
    const hash = await wallet.join(escrow, lobby.matchId, BigInt(lobby.stake));
    await wallet.waitFor(hash);
    net.send({ type: 'lobbies' });
    // The server opens the room once the lobby locks and the oracle seeds it.
    net.send({ type: 'watch', matchId: lobby.matchId });
    toast('Seat taken. The match starts when the lobby fills.');
  } catch (error) {
    toast(errorFirstLine(error));
  }
}

// --------------------------------------------------------------------- chrome

function showMatchScreen(): void {
  dom.lobbyScreen.classList.add('hidden');
  dom.matchScreen.classList.remove('hidden');
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
  dom.placeBet.disabled = true;
  dom.moveStatus.textContent = reason;
}

function setChips(chips: number): void {
  dom.chipsLabel.textContent = `${chips} chips`;
}

function describeDraft(draft: { action: ActionValue; target: number }): string {
  return draft.action === Action.Attack
    ? `attack #${draft.target}`
    : ACTION_NAMES[draft.action];
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function toast(message: string): void {
  dom.toast.textContent = message;
  dom.toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.add('hidden'), 5_000);
}

function fillSelect(select: HTMLSelectElement, options: Array<[string, string]>): void {
  const previous = select.value;
  select.replaceChildren(
    ...options.map(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }),
  );
  if (options.some(([value]) => value === previous)) select.value = previous;
}

function short(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id} in index.html`);
  return element as T;
}
