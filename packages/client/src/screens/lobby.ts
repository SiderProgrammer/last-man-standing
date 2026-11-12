import { formatEther, parseEventLogs, type TransactionReceipt } from 'viem';
import { sameAddress, type BotDifficulty } from '@lms/consensus';
import {
  chainCss,
  chainInfo,
  gameEscrowAbi,
  joinMessage,
  localQuote,
  quoteAcross,
  type BridgeQuote,
} from '@lms/contracts';
import {
  errorFirstLine,
  errorMessage,
  type CrossChainEvent,
  type LobbyInfo,
  type ServerMessage,
  type SpokeInfo,
  type ZapToken,
} from '@lms/api';
import { app, dom, net, store } from '../context.js';
import { showMatchScreen, toast } from '../ui/chrome.js';
import { callBack } from '../ui/alerts.js';
import { element } from '../ui/dom.js';
import { short } from '../ui/format.js';
import {
  crossChainNotice,
  discountStatus,
  chainChips,
  lobbyAction,
  lobbySeatsText,
  lobbySummary,
  parseStakeInput,
  prizeBreakdown,
  prizeSummary,
  sortLobbies,
  stakeRangeText,
  spokeFor,
  spokeQuoteError,
  spokeQuoteLabel,
  spokeStakeLabel,
  stakeButtonLabel,
} from '../ui/views.js';
import { renderWinnings } from '../wallet/payouts.js';
import type { SpokeRoute } from '../wallet/wallet.js';
import { protocolTerms } from '../wallet/terms.js';
import { connectWallet } from '../wallet/flows.js';
import { confirmFirstStake } from './help.js';
import { RelayError, canRelay, relayJoin } from '../wallet/oneClick.js';

/** The lobby screen: practice, the staked-lobby directory, create and join. */

/**
 * How long a quoted price may be accepted. The contract enforces the ceiling
 * whenever the join lands; this only stops the player agreeing to a figure
 * they looked at minutes ago.
 */
export const QUOTE_TTL_MS = 30_000;

/**
 * Turns a priced join button into the offer the player confirms: `label`
 * until it is clicked, which pays, or until `QUOTE_TTL_MS` passes, which
 * puts it back with `expire`.
 */
export function armQuote(button: HTMLButtonElement, label: string, expire: () => void, pay: () => void): void {
  button.textContent = label;
  button.classList.add('primary');
  const expiry = setTimeout(expire, QUOTE_TTL_MS);
  button.onclick = () => {
    clearTimeout(expiry);
    pay();
  };
}

/** A little over the chain bridge's poll interval: how stale the directory can be. */
const DIRECTORY_LAG_MS = 5_000;

/** Starts a practice match: against `bots` house bots at `difficulty`. */
export async function startPractice(bots: number, difficulty: string): Promise<void> {
  // Logged out, the button connects first rather than doing nothing.
  if (!app.wallet) {
    toast('Practice is free: your wallet only signs a login, never a transaction.', 'info');
    await connectWallet();
    if (!app.wallet) return;
  }
  store.set({ lastPractice: { bots, difficulty }, leftMatch: null });
  net.send({ type: 'practice', bots, difficulty: difficulty as BotDifficulty });
}

/** The lobby an invite link (`?lobby=0x…`) points at, if the page was opened from one. */
const invited: string | null = new URLSearchParams(location.search).get('lobby')?.toLowerCase() ?? null;
/** Whether the invited lobby has been scrolled into view: once is enough. */
let invitedShown = false;

/** Lobbies this browser opened, by lowercased id: "your lobby" before anyone has a seat in it. */
const created = new Set<string>();

/**
 * Lobbies this browser opened that the server has not listed yet: it waits
 * for confirmations first. Shown as "opening…" so the new lobby is there at
 * once rather than seconds later.
 */
const opening = new Map<string, LobbyInfo>();

/** Lobbies taken a seat in before the server listed them: watched once it does. */
const watchWhenListed = new Set<string>();

export function wireLobbyControls(): void {
  dom.practice.onclick = () => void startPractice(Number(dom.botCount.value), dom.botDifficulty.value);

  dom.refreshLobbies.onclick = () => net.send({ type: 'lobbies' });
  dom.createLobby.onclick = () => void createLobby();
  dom.stake.oninput = renderCreateForm;
  dom.seats.onchange = renderCreateForm;

  store.subscribe(['zap', 'wallet', 'walletChainId', 'escrow', 'spokes', 'chainId'], renderPayWith);
  store.subscribe(['lobbies', 'inTransit', 'matched', 'matchmaking', 'terms', 'wallet'], renderLobbies);
  store.subscribe(['terms', 'matchmaking'], defaultStake);
  store.subscribe(['terms', 'escrow', 'wallet', 'walletChainId', 'spokes'], renderCreateForm);
  store.subscribe(['discount'], renderLobbies);
  store.subscribe(['chainId', 'escrow'], renderHeroNote);
  // The discount is read on the hub, where the escrow is; its module loads
  // the first time a wallet is there.
  store.subscribe(['wallet', 'walletChainId', 'escrow', 'chainId'], () => {
    const { wallet, escrow } = app;
    const onHub = wallet && escrow && wallet.chainId === app.chainId;
    if (onHub) void import('./discount.js').then((discount) => discount.refreshDiscount());
    else store.set({ discount: null });
    // What a table pays, and the stakes a new lobby takes. Kept once read:
    // they only change by a governance vote.
    if (onHub && !app.terms) {
      void protocolTerms(wallet, escrow)
        .then((terms) => store.set({ terms }))
        .catch((error: unknown) => console.warn('[lobby] could not read the protocol terms', error));
    }
  });
}

/** The hero's line about staked play, which says "testnet" only on one. */
function renderHeroNote(): void {
  const chain = chainInfo(app.chainId);
  dom.heroNote.textContent = app.escrow
    ? `Practice runs entirely off-chain against house bots. Staked matches escrow a real ${chain.testnet ? 'testnet ' : ''}stake on ${chain.name} and settle on-chain when the match ends.`
    : 'Practice runs entirely off-chain against house bots. This server runs practice only.';
}

/**
 * The create form's stake box starts at the cheapest table: the config's
 * minimum stake, or the cheapest tier the matchmaker runs. Only while the
 * player has not typed in it.
 */
function defaultStake(): void {
  if (dom.stake.dataset.touched) return;
  const cheapest =
    app.terms?.minStake ??
    app.matchmaking.reduce<bigint | null>((low, tier) => (low === null || BigInt(tier.stake) < low ? BigInt(tier.stake) : low), null);
  if (cheapest !== null && cheapest > 0n) dom.stake.value = formatEther(cheapest);
  renderCreateForm();
}

/**
 * The line under the create form: the stakes allowed and what a full table
 * would pay, or why the stake typed is not one. The button says what it does.
 */
function renderCreateForm(): void {
  if (document.activeElement === dom.stake) dom.stake.dataset.touched = '1';
  const spoke = currentSpoke();
  if (spoke) {
    dom.stakeRange.textContent = `Lobbies are opened on ${chainInfo(app.chainId).name}. You can stake into any of them from ${chainInfo(spoke.chainId).name}.`;
    dom.stakeRange.classList.remove('warn-text');
    dom.createLobby.textContent = 'Create & stake';
    return;
  }
  const parsed = parseStakeInput(dom.stake.value, app.terms);
  const range = app.terms ? `Stakes ${stakeRangeText(app.terms)}.` : '';
  if (!parsed.ok) {
    dom.stakeRange.textContent = dom.stake.value.trim() === '' ? range : `${parsed.error}`;
    dom.stakeRange.classList.toggle('warn-text', dom.stake.value.trim() !== '');
    dom.createLobby.textContent = 'Create & stake';
    return;
  }
  const seats = Number(dom.seats.value);
  const prize = prizeSummary(parsed.wei, seats, app.terms);
  dom.stakeRange.textContent = [range, prize ? `A full table: ${prize} ETH.` : ''].filter(Boolean).join(' ');
  dom.stakeRange.classList.remove('warn-text');
  dom.createLobby.textContent = `Create & stake ${formatEther(parsed.wei)} ETH`;
}

/**
 * The right moment to say that lobbies are opened on the hub: a wallet on a
 * spoke stakes into them but cannot create one.
 */
export function renderPayWith(): void {
  const spoke = currentSpoke();
  dom.createLobby.disabled = !app.escrow || spoke !== null;
  dom.createLobby.title = spoke
    ? `Lobbies are opened on ${chainInfo(app.chainId).name}. You can stake into any of them from ${chainInfo(spoke.chainId).name}.`
    : '';
  renderCreateForm();
  renderLobbies();
}

/** The spoke the wallet stakes from, or null when it is on the hub (or nowhere useful). */
function currentSpoke(): SpokeInfo | null {
  return app.wallet && app.escrow ? spokeFor(app.spokes, app.wallet.chainId) : null;
}

/** The server's directory arrived. */
export function onLobbies(open: LobbyInfo[], live: LobbyInfo[]): void {
  // A seat in the directory is the surest sign a stake landed, even if the
  // server's report of it was missed while the socket was down.
  const landed = new Set(
    [...open, ...live]
      .filter(isSeatedIn)
      .map((lobby) => lobby.matchId.toLowerCase()),
  );
  const inTransit = [...app.inTransit].filter((id) => !landed.has(id));
  for (const lobby of [...open, ...live]) {
    if (watchWhenListed.delete(lobby.matchId.toLowerCase())) net.send({ type: 'watch', matchId: lobby.matchId });
  }
  store.set({
    lobbies: { open, live },
    ...(inTransit.length !== app.inTransit.size ? { inTransit: new Set(inTransit) } : {}),
  });
}

export function renderLobbies(): void {
  const { open, live } = app.lobbies;
  if (open.length === 0 && live.length === 0 && opening.size === 0) {
    dom.lobbyList.replaceChildren(
      element(
        'li',
        'lobby-empty muted small',
        !app.wallet
          ? 'Connect a wallet to see the staked lobbies and take a seat.'
          : app.escrow
          ? app.matchmaking.length > 0
            ? 'No staked lobbies right now. Find a match, or open your own below.'
            : 'No staked lobbies right now. Open your own below.'
          : 'Server is running without an escrow: practice only.',
      ),
    );
    return;
  }

  // Your own tables first, wherever they are; then what you can join; then
  // what is being played. Tables you cannot take a seat at (another queue's,
  // or past their window) fold away under "Other tables".
  const nowSeconds = Math.floor(Date.now() / 1000);
  const yours = sortLobbies([...open, ...live].filter(isYours), () => false);
  const joinable: LobbyInfo[] = [];
  const others: LobbyInfo[] = [];
  for (const lobby of open) {
    if (isYours(lobby)) continue;
    const action = lobbyAction(lobby, false, nowSeconds, false);
    (action === 'join' ? joinable : others).push(lobby);
  }
  const playing = live.filter((lobby) => !isYours(lobby));

  const rows: HTMLLIElement[] = [];
  const group = (title: string, lobbies: readonly LobbyInfo[], canJoin: boolean) => {
    // "Yours" is drawn above, with the lobbies still opening.
    if (title === 'Yours') return;
    if (lobbies.length > 0) rows.push(groupHead(`${title} · ${lobbies.length}`), ...lobbies.map((lobby) => lobbyRow(lobby, canJoin, nowSeconds)));
  };
  // Opened here and not listed yet: there at once, as "opening…".
  const listed = new Set([...open, ...live].map((lobby) => lobby.matchId.toLowerCase()));
  for (const id of [...opening.keys()]) if (listed.has(id)) opening.delete(id);
  if (yours.length + opening.size > 0) rows.push(groupHead(`Yours · ${yours.length + opening.size}`));
  rows.push(...[...opening.values()].map(openingRow), ...yours.map((lobby) => lobbyRow(lobby, true, nowSeconds)));
  group('Open', sortLobbies(joinable, () => false), true);
  group('In play', playing, false);
  if (others.length > 0) {
    const holder = element('li', 'lobby-others');
    const details = element('details');
    const list = element('ul', 'lobby-list');
    list.append(...others.map((lobby) => lobbyRow(lobby, true, nowSeconds)));
    details.append(element('summary', 'muted small', `Other tables · ${others.length} · matchmade for other players, or closed`), list);
    holder.append(details);
    rows.push(holder);
  }
  if (yours.length === 0 && opening.size === 0 && joinable.length === 0) {
    rows.unshift(
      element(
        'li',
        'lobby-empty muted small',
        app.matchmaking.length > 0
          ? 'No lobbies to join right now. Find a match above, or open your own below.'
          : 'No lobbies to join right now. Open your own below.',
      ),
    );
  }
  dom.lobbyList.replaceChildren(...rows);

  // An invite link lands here: show the lobby it names, once.
  if (invited && !invitedShown) {
    const row = [...dom.lobbyList.querySelectorAll<HTMLElement>('[data-match]')].find((node) => node.dataset.match === invited);
    if (row) {
      invitedShown = true;
      row.scrollIntoView({ block: 'center' });
    }
  }
}

/** A lobby just opened here, before the server lists it. */
function openingRow(lobby: LobbyInfo): HTMLLIElement {
  const li = element('li', 'lobby-row yours opening');
  li.dataset.match = lobby.matchId.toLowerCase();
  const label = element('div', 'lobby-info');
  const top = element('div', 'lobby-top');
  top.append(element('strong', 'lobby-stake', `${formatEther(BigInt(lobby.stake))} ETH`), element('span', 'pill lobby-status', 'opening…'));
  const meta = element('div', 'lobby-meta muted small');
  meta.append(seatDots(lobby), element('span', '', `${lobby.seatCount}/${lobby.maxSeats} seats · on-chain, listed once confirmed`), element('span', 'lobby-id', short(lobby.matchId)));
  label.append(top, meta);
  const invite = element('button', 'ghost', 'Copy invite');
  invite.type = 'button';
  invite.onclick = () => void copyInvite(lobby.matchId);
  const buttons = element('div', 'lobby-buttons');
  buttons.append(invite);
  li.append(label, buttons);
  return li;
}

/** Whether this lobby is the player's own: a seat in it, the queue's table for them, or one they opened. */
function isYours(lobby: LobbyInfo): boolean {
  const id = lobby.matchId.toLowerCase();
  return isSeatedIn(lobby) || app.matched.has(id) || (created.has(id) && lobby.status === 'open');
}

function groupHead(text: string): HTMLLIElement {
  return element('li', 'lobby-group', text);
}

function lobbyRow(lobby: LobbyInfo, joinable: boolean, nowSeconds: number): HTMLLIElement {
  const seated = isSeatedIn(lobby);
  const id = lobby.matchId.toLowerCase();
  const matched = app.matched.has(id);
  const mine = created.has(id);
  const li = element('li', `lobby-row${seated || matched || mine ? ' yours' : ''}${id === invited ? ' invited' : ''}`);
  li.dataset.match = id;
  const label = element('div', 'lobby-info');
  const action = lobbyAction(lobby, seated, nowSeconds, matched);

  const top = element('div', 'lobby-top');
  top.append(
    element('strong', 'lobby-stake', `${formatEther(BigInt(lobby.stake))} ETH`),
    element('span', `pill lobby-status ${lobby.status}`, lobby.status === 'open' ? 'open' : lobby.status === 'pending' ? 'seeding' : 'live'),
  );
  if (action === 'cancel') top.append(element('span', 'pill lobby-tag', 'refund ready'));
  else if (seated) top.append(element('span', 'pill lobby-tag', 'your seat'));
  else if (matched) top.append(element('span', 'pill lobby-tag', 'your table'));
  else if (mine) top.append(element('span', 'pill lobby-tag', 'your lobby'));
  else if (lobby.matchmade) top.append(element('span', 'pill', 'matchmade'));
  else if (id === invited) top.append(element('span', 'pill lobby-tag', 'invited'));
  const chips = chainChips(lobby.players).map((chip) => {
    const node = element('span', 'chain-chip', chip.label);
    node.title = chip.title;
    node.style.setProperty('--chain', chip.css);
    return node;
  });
  if (chips.length > 0) {
    const row = element('span', 'chain-chips');
    row.append(...chips);
    top.append(row);
  }

  const meta = element('div', 'lobby-meta muted small');
  meta.append(seatDots(lobby), element('span', '', lobbySeatsText(lobby, nowSeconds)), element('span', 'lobby-id', short(lobby.matchId)));
  meta.title = lobbySummary(lobby.stake, lobby.seatCount, lobby.maxSeats, lobby.status);
  label.append(top, meta);

  // What a seat can win, before staking: the lobby's own terms, or the
  // config's when the server did not send them.
  const terms = lobby.feeBps !== undefined && lobby.payoutBps ? { feeBps: lobby.feeBps, payoutBps: lobby.payoutBps } : app.terms;
  const prize = prizeSummary(lobby.stake, lobby.maxSeats, terms);
  if (prize && terms) {
    const line = element('div', 'lobby-prize small', `${prize} ETH`);
    line.title = prizeBreakdown(lobby.stake, lobby.maxSeats, terms);
    label.append(line);
  }

  const button = element('button');
  const spoke = currentSpoke();

  if (action === 'cancel') {
    button.textContent = 'Cancel & refund';
    button.title = 'This lobby can no longer start. Cancelling it refunds every seat.';
    button.onclick = () => void cancelLobby(button, lobby);
  } else if (action === 'enter' || action === 'watch' || !joinable) {
    button.textContent = action === 'enter' ? 'Enter' : 'Watch';
    button.onclick = () => {
      // Opening it again undoes having left it.
      if (app.leftMatch === lobby.matchId) store.set({ leftMatch: null });
      net.send({ type: 'watch', matchId: lobby.matchId });
      showMatchScreen();
    };
  } else if (action === 'closed') {
    disable(button, 'Closed', 'Its join window has closed.');
  } else if (action === 'matchmade') {
    disable(button, 'Matchmade', 'The matchmaking queue put this table together; only its players can take a seat.');
  } else if (app.inTransit.has(lobby.matchId.toLowerCase())) {
    disable(button, 'In transit…', `Your stake is on its way to ${chainInfo(app.chainId).name}. You will be told when it lands.`);
  } else if (spoke) {
    idleSpokeButton(button, lobby, spoke);
  } else {
    idleStakeButton(button, lobby);
  }

  // A seat of yours is the one row that wants a click now. A join stays plain
  // until it is priced: there, `primary` means "this is the offer, click to pay".
  if (action === 'enter' || action === 'cancel' || (matched && action === 'join')) button.classList.add('primary');
  const buttons = element('div', 'lobby-buttons');
  // A private lobby fills with the people its link is sent to.
  if (lobby.status === 'open' && !lobby.matchmade && (seated || mine) && action !== 'cancel') {
    const invite = element('button', 'ghost', 'Copy invite');
    invite.type = 'button';
    invite.title = 'A link that opens this lobby, ready to stake into';
    invite.onclick = () => void copyInvite(lobby.matchId);
    buttons.append(invite);
  }
  buttons.append(button);
  li.append(label, buttons);
  return li;
}

/** Copies a link that opens the lobby page on `matchId`. */
async function copyInvite(matchId: string): Promise<void> {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('lobby', matchId);
  try {
    await navigator.clipboard.writeText(url.toString());
    toast('Invite link copied. Anyone who opens it can stake into this lobby.', 'success');
  } catch {
    toast(`Send this link to invite players: ${url.toString()}`, 'info', { sticky: true });
  }
}

/**
 * One dot per seat: filled in the colour of the chain each stake came from,
 * yours ringed, empty ones hollow. Read at a glance where "1/4 seats" needs
 * reading.
 */
function seatDots(lobby: LobbyInfo): HTMLElement {
  const dots = element('span', 'seat-dots');
  dots.setAttribute('aria-label', `${lobby.seatCount} of ${lobby.maxSeats} seats taken`);
  dots.setAttribute('role', 'img');
  for (let i = 0; i < lobby.maxSeats; i++) {
    const player = lobby.players[i];
    const dot = element('span', `seat-dot${player ? ' taken' : ''}${player && sameAddress(player.address, app.wallet?.address) ? ' you' : ''}`);
    if (player) {
      const chain = chainInfo(player.chainId);
      dot.style.setProperty('--chain', chainCss(chain.color));
      dot.title = `${short(player.address)} · staked on ${chain.name}`;
    }
    dots.append(dot);
  }
  return dots;
}

/** Whether the connected wallet holds a seat in `lobby`. */
function isSeatedIn(lobby: LobbyInfo): boolean {
  return lobby.players.some((player) => sameAddress(player.address, app.wallet?.address));
}

/** A row's button with nothing to do, saying why. */
function disable(button: HTMLButtonElement, label: string, why: string): void {
  button.textContent = label;
  button.disabled = true;
  button.title = why;
}

async function createLobby(): Promise<void> {
  const { wallet, escrow } = app;
  if (!wallet || !escrow) return toast('Connect a wallet first.', 'error');
  if (currentSpoke()) return toast(dom.createLobby.title, 'error');
  const stake = parseStakeInput(dom.stake.value, app.terms);
  if (!stake.ok) return toast(stake.error, 'error');
  if (!(await confirmFirstStake())) return;
  const seats = Number(dom.seats.value);
  try {
    dom.createLobby.disabled = true;
    dom.createLobby.textContent = 'Confirm the new lobby…';
    const hash = await wallet.createMatch(escrow, formatEther(stake.wei), seats);
    dom.createLobby.textContent = 'Opening…';
    const matchId = createdMatchId(await wallet.waitFor(hash, 'Open lobby'));
    created.add(matchId.toLowerCase());
    // Creating does not seat you: the stake goes in with a join of its own,
    // asked for straight away so it is one click for the player.
    const lobby: LobbyInfo = {
      matchId,
      stake: stake.wei.toString(),
      seatCount: 0,
      maxSeats: seats,
      minSeats: seats,
      joinDeadline: 0,
      status: 'open',
      players: [],
      cancellableAt: 0,
      matchmade: false,
    };
    opening.set(matchId.toLowerCase(), lobby);
    renderLobbies();
    refreshDirectorySoon();
    dom.createLobby.textContent = 'Confirm your stake…';
    await joinLobby(lobby, 'Lobby open and your seat taken. Copy its invite link to bring players in.');
    if (app.wallet) opening.set(matchId.toLowerCase(), { ...lobby, seatCount: 1, players: [{ address: app.wallet.address, chainId: app.chainId }] });
    renderLobbies();
  } catch (error) {
    toast(errorFirstLine(error), 'error');
  } finally {
    dom.createLobby.disabled = false;
    renderCreateForm();
  }
}

/** The id of the lobby a `createMatch` receipt opened. */
function createdMatchId(receipt: TransactionReceipt): `0x${string}` {
  const [event] = parseEventLogs({ abi: gameEscrowAbi, eventName: 'MatchCreated', logs: receipt.logs });
  if (!event?.args.matchId) throw new Error('The lobby was not created: the transaction did not open one.');
  return event.args.matchId;
}

/**
 * Asks for the directory now and twice more as the server's bridge catches
 * up with the chain, so a lobby just opened or joined shows without Refresh.
 */
function refreshDirectorySoon(): void {
  net.send({ type: 'lobbies' });
  setTimeout(() => net.send({ type: 'lobbies' }), DIRECTORY_LAG_MS);
  setTimeout(() => net.send({ type: 'lobbies' }), DIRECTORY_LAG_MS * 3);
}

async function joinLobby(lobby: LobbyInfo, done?: string): Promise<void> {
  const { wallet, escrow } = app;
  if (!wallet || !escrow) return toast('Connect a wallet first.', 'error');

  try {
    if (canRelay()) {
      try {
        await relayJoin(lobby.matchId, BigInt(lobby.stake));
        return seated(lobby, done);
      } catch (error) {
        // Over the caps, out of today's quota, or a lobby that just filled:
        // say why, and let the wallet try it as an ordinary transaction.
        if (!(error instanceof RelayError)) throw error;
        toast(`One-click join refused: ${error.message}. Using your wallet.`, 'info');
      }
    }
    const hash = await wallet.join(escrow, lobby.matchId, BigInt(lobby.stake));
    await wallet.waitFor(hash, 'Stake');
    seated(lobby, done);
  } catch (error) {
    toast(errorFirstLine(error), 'error');
  }
}

/** The queue put this wallet at a table: its lobby is now one it can stake into. */
export function onMatched(message: Extract<ServerMessage, { type: 'matched' }>): void {
  store.set({ matched: new Set([...app.matched, message.matchId.toLowerCase()]) });
  // Kept until dismissed: it is the one message that needs an answer, and a
  // later toast must not bury it.
  toast(
    `Matched: a ${message.seats}-seat table is ready. Stake in its row under "Yours" (${short(message.matchId)}) to take your seat.`,
    'success',
    { sticky: true },
  );
  callBack('Table ready', `A ${message.seats}-seat table is waiting for your stake.`);
  refreshDirectorySoon();
}

/** Cancels a lobby the player sits in that can no longer start; the refund is then theirs to withdraw. */
async function cancelLobby(button: HTMLButtonElement, lobby: LobbyInfo): Promise<void> {
  const { wallet, escrow } = app;
  if (!wallet || !escrow) return toast('Connect a wallet first.', 'error');
  button.disabled = true;
  button.textContent = 'Cancelling…';
  try {
    await wallet.waitFor(await wallet.cancelMatch(escrow, lobby.matchId), 'Cancel & refund');
    toast('Cancelled. Your stake is back in your balance, ready to withdraw.', 'success', { sticky: true });
    void renderWinnings();
    net.send({ type: 'lobbies' });
  } catch (error) {
    toast(errorFirstLine(error), 'error');
    button.disabled = false;
    button.textContent = 'Cancel & refund';
  }
}

export function seated(lobby: LobbyInfo, done?: string): void {
  refreshDirectorySoon();
  // The server opens the room once the lobby locks and the oracle seeds it.
  // A lobby its bridge has not picked up yet (one just opened) would answer
  // "unknown match": ask once it is in the directory.
  const known = [...app.lobbies.open, ...app.lobbies.live].some((entry) => entry.matchId === lobby.matchId);
  if (known) net.send({ type: 'watch', matchId: lobby.matchId });
  else watchWhenListed.add(lobby.matchId.toLowerCase());
  const filled = lobby.seatCount + 1 >= lobby.maxSeats;
  toast(
    done ??
      (filled
        ? 'Seat taken, and the table is full. The match opens as soon as its seed arrives.'
        : `Seat taken. The match starts when the lobby fills: ${lobby.maxSeats - lobby.seatCount - 1} more to go.`),
    'success',
  );
}

// ------------------------------------------------------------ token payment
//
// Two clicks. The first prices the route and turns the button into the most
// the player will pay; the second pays it. Nothing reaches the wallet until
// the player has seen that figure, because the wallet's own prompt for
// `joinWithToken` shows a contract call, not a price.
//
// Always the player's own transactions, one-click play or not: a token
// approval is exactly the kind of call a prompt-free key must never make.

/**
 * A quote that expired or failed: back to the plain Stake button, which
 * offers the payment choice again.
 */
export function idleTokenButton(button: HTMLButtonElement, lobby: LobbyInfo, _token: ZapToken): void {
  idleStakeButton(button, lobby);
}

function quoteToken(button: HTMLButtonElement, lobby: LobbyInfo, token: ZapToken): void {
  button.textContent = `Pricing in ${token.symbol}…`;
  // The pricing and paying are a chunk of their own, fetched on the first quote.
  void import('./zap.js').then((zap) => zap.quoteTokenJoin(button, lobby, token));
}

/**
 * An open lobby's Stake button. With only ETH to pay in, a click joins.
 * With a token route or the LMS discount on offer, a click opens the
 * choice of how to pay, in the row: then the price, then Pay.
 */
function idleStakeButton(button: HTMLButtonElement, lobby: LobbyInfo): void {
  button.textContent = stakeButtonLabel(lobby.stake, null);
  button.classList.remove('primary');
  button.disabled = false;
  button.title = '';
  const choices = paymentChoices();
  button.onclick = async () => {
    if (!(await confirmFirstStake())) return;
    if (choices.length > 1) openPayChoice(button, lobby, choices);
    else void joinLobby(lobby);
  };
}

type PayChoice = { label: string; title: string; pick: (button: HTMLButtonElement, lobby: LobbyInfo) => void };

/** How a seat can be paid for here: ETH, each token the zap routes, and ETH with part of the fee in LMS. */
function paymentChoices(): PayChoice[] {
  const choices: PayChoice[] = [
    { label: 'ETH', title: 'Pay the stake in ETH', pick: (_button, lobby) => void joinLobby(lobby) },
  ];
  for (const token of app.zap?.tokens ?? []) {
    choices.push({
      label: token.symbol,
      title: `Pay in ${token.symbol}, swapped to exactly the stake through Uniswap v4 as you join`,
      pick: (button, lobby) => quoteToken(button, lobby, token),
    });
  }
  const discount = app.discount;
  if (discount && discount.balance > 0n) {
    choices.push({
      label: 'ETH + LMS fee',
      title: discountStatus(discount).text,
      pick: (button, lobby) => void import('./discount.js').then((module) => module.quoteDiscountJoin(button, lobby)),
    });
  }
  return choices;
}

/** The row's payment choice, in place of its buttons until one is picked. */
function openPayChoice(button: HTMLButtonElement, lobby: LobbyInfo, choices: PayChoice[]): void {
  const holder = button.parentElement;
  if (!holder) return;
  const kept = [...holder.childNodes];
  const close = () => holder.replaceChildren(...kept);
  const group = element('div', 'pay-choice');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Pay with');
  group.append(element('span', 'muted small', 'Pay with'));
  for (const choice of choices) {
    const option = element('button', 'ghost', choice.label);
    option.type = 'button';
    option.title = choice.title;
    option.onclick = () => {
      close();
      choice.pick(button, lobby);
    };
    group.append(option);
  }
  const cancel = element('button', 'toast-close', '×');
  cancel.type = 'button';
  cancel.setAttribute('aria-label', 'Cancel');
  cancel.onclick = close;
  group.append(cancel);
  holder.replaceChildren(group);
  group.querySelector('button')?.focus();
}

/**
 * An ETH join that spends LMS on its fee, before it is priced. The pricing
 * and paying are in `discount.ts`, loaded with the option.
 */
export function idleDiscountButton(button: HTMLButtonElement, lobby: LobbyInfo): void {
  idleStakeButton(button, lobby);
}

// -------------------------------------------------------------- spoke joins
//
// Two clicks, like token payment: the first asks Across what bridging the
// stake to the hub costs and the second pays it, through the spoke's
// `SpokeRouter`. The stake then waits for a relayer, during which the row
// says so; the server reports how it landed on the hub.
//
// With no Across API configured (`VITE_ACROSS_API`), as on the local stack,
// whose SpokePools are mocks `npm run dev:fork` fills, the quote has no fee.

const ACROSS_API = import.meta.env.VITE_ACROSS_API ?? '';
/** Each router's route, read once: it is immutable. */
const routes = new Map<string, Promise<SpokeRoute>>();

function idleSpokeButton(button: HTMLButtonElement, lobby: LobbyInfo, spoke: SpokeInfo): void {
  button.textContent = spokeStakeLabel(lobby.stake, spoke.chainId);
  button.classList.remove('primary');
  button.disabled = false;
  button.title = `Staked on ${chainInfo(spoke.chainId).name}, carried to ${chainInfo(app.chainId).name} for the match.`;
  button.onclick = async () => {
    if (await confirmFirstStake()) void quoteSpokeJoin(button, lobby, spoke);
  };
}

async function quoteSpokeJoin(button: HTMLButtonElement, lobby: LobbyInfo, spoke: SpokeInfo): Promise<void> {
  const { wallet } = app;
  if (!wallet) return toast('Connect a wallet first.', 'error');

  const stake = BigInt(lobby.stake);
  button.disabled = true;
  button.textContent = 'Quoting…';
  try {
    const key = spoke.router.toLowerCase();
    let pending = routes.get(key);
    if (!pending) routes.set(key, (pending = wallet.spokeRoute(spoke.router)));
    const route = await pending;
    const priced = ACROSS_API
      ? await quoteAcross(
          ACROSS_API,
          {
            originChainId: spoke.chainId,
            destinationChainId: route.hubChainId,
            inputToken: route.weth,
            outputToken: route.hubWeth,
            recipient: route.hubReceiver,
            message: joinMessage(lobby.matchId, wallet.address, spoke.chainId),
          },
          stake,
        )
      : localQuote(stake, await wallet.chainTime());
    armQuote(
      button,
      spokeQuoteLabel(stake, priced.inputAmount),
      () => idleSpokeButton(button, lobby, spoke),
      () => void paySpokeJoin(button, lobby, spoke, priced.quote, priced.inputAmount),
    );
    button.disabled = false;
  } catch (error) {
    toast(spokeQuoteError(errorMessage(error), spoke.chainId), 'error');
    idleSpokeButton(button, lobby, spoke);
  }
}

async function paySpokeJoin(
  button: HTMLButtonElement,
  lobby: LobbyInfo,
  spoke: SpokeInfo,
  quote: BridgeQuote,
  total: bigint,
): Promise<void> {
  const { wallet } = app;
  if (!wallet) return;

  button.disabled = true;
  try {
    button.textContent = 'Confirm the join…';
    const hash = await wallet.joinFromSpoke(spoke.chainId, spoke.router, lobby.matchId, quote, total);
    button.textContent = 'Sending…';
    await wallet.waitFor(hash, 'Stake from another chain');
    store.set({ inTransit: new Set([...app.inTransit, lobby.matchId.toLowerCase()]) });
    toast(
      `Stake sent from ${chainInfo(spoke.chainId).name}. It reaches ${chainInfo(app.chainId).name} once a ` +
        'relayer fills it, usually within a minute; you will be told when it is seated.',
    );
  } catch (error) {
    toast(spokeQuoteError(errorFirstLine(error), spoke.chainId), 'error');
    idleSpokeButton(button, lobby, spoke);
  }
}

/** The server's report of how one of this player's spoke joins landed on the hub. */
export function onCrossChain(event: CrossChainEvent): void {
  // A stake that did not seat anyone is money to go and collect: kept up.
  toast(crossChainNotice(event, app.chainId), event.kind === 'seated' ? 'success' : 'error', { sticky: event.kind === 'refunded' });
  if (event.kind === 'seated') {
    // The row stays locked until the seat shows in the directory, which can
    // lag this report by one of the bridge's polls; otherwise it would offer
    // to stake for a seat the player already holds. `onLobbies` unlocks it.
    // No `watch` yet: the room only exists once the lobby locks and the
    // oracle seeds it, and asking sooner answers "unknown match" over this
    // notice. The row's Enter button attaches the player then.
    net.send({ type: 'lobbies' });
    setTimeout(() => net.send({ type: 'lobbies' }), DIRECTORY_LAG_MS);
  } else if (event.kind === 'refunded') {
    const id = event.matchId.toLowerCase();
    store.set({ inTransit: new Set([...app.inTransit].filter((entry) => entry !== id)) });
    void renderWinnings();
  }
}
