import { formatEther } from 'viem';
import { sameAddress, type BotDifficulty } from '@lms/consensus';
import {
  chainInfo,
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
import { element, fillSelect } from '../ui/dom.js';
import { short } from '../ui/format.js';
import { readRaw, writeRaw } from '../io/storage.js';
import {
  crossChainNotice,
  discountStatus,
  chainChips,
  lobbyAction,
  lobbySeatsText,
  lobbySummary,
  sortLobbies,
  payWithOptions,
  spokeFor,
  spokeQuoteError,
  spokeQuoteLabel,
  spokeStakeLabel,
  stakeButtonLabel,
} from '../ui/views.js';
import { renderWinnings } from '../wallet/payouts.js';
import type { SpokeRoute } from '../wallet/wallet.js';
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

export function wireLobbyControls(): void {
  dom.practice.onclick = () => {
    net.send({
      type: 'practice',
      bots: Number(dom.botCount.value),
      difficulty: dom.botDifficulty.value as BotDifficulty,
    });
  };

  dom.refreshLobbies.onclick = () => net.send({ type: 'lobbies' });
  dom.createLobby.onclick = () => void createLobby();
  dom.payWith.onchange = renderLobbies;
  dom.useDiscount.checked = readRaw(DISCOUNT_KEY) === '1';
  dom.useDiscount.onchange = () => {
    writeRaw(DISCOUNT_KEY, dom.useDiscount.checked ? '1' : '0');
    renderLobbies();
  };

  store.subscribe(['zap', 'wallet', 'walletChainId', 'escrow', 'spokes', 'chainId'], renderPayWith);
  store.subscribe(['lobbies', 'inTransit', 'matched', 'matchmaking'], renderLobbies);
  store.subscribe(['discount'], renderDiscount);
  // The discount is read on the hub, where the escrow is; its module loads
  // the first time a wallet is there.
  store.subscribe(['wallet', 'walletChainId', 'escrow', 'chainId'], () => {
    const onHub = app.wallet && app.escrow && app.wallet.chainId === app.chainId;
    if (onHub) void import('./discount.js').then((discount) => discount.refreshDiscount());
    else store.set({ discount: null });
  });
}

const DISCOUNT_KEY = 'lms:pay-fee-in-lms';

/** The "pay part of the fee in LMS" option: shown while governance has the discount on. */
function renderDiscount(): void {
  const terms = app.discount;
  dom.discountRow.classList.toggle('hidden', !terms);
  if (terms) {
    const status = discountStatus(terms);
    dom.discountStatus.textContent = status.text;
    dom.useDiscount.disabled = !status.enabled;
  }
  renderLobbies();
}

/** True when the next ETH join should spend LMS on its fee. */
function payingInLms(): boolean {
  return Boolean(app.discount && app.discount.balance > 0n && dom.useDiscount.checked);
}

/**
 * Shows the "Pay with" picker only when the server routes at least one token,
 * and the wallet is on the hub, where the zap is. Also the right moment to
 * say that lobbies are opened on the hub: a wallet on a spoke stakes into
 * them but cannot create one.
 */
export function renderPayWith(): void {
  const spoke = currentSpoke();
  fillSelect(dom.payWith, payWithOptions(app.zap));
  dom.payWithRow.classList.toggle('hidden', !app.zap || spoke !== null);
  dom.createLobby.disabled = !app.escrow || spoke !== null;
  dom.createLobby.title = spoke
    ? `Lobbies are opened on ${chainInfo(app.chainId).name}. You can stake into any of them from ${chainInfo(spoke.chainId).name}.`
    : '';
  renderLobbies();
}

/** The token picked to pay with, or null for plain ETH. */
function payToken(): ZapToken | null {
  return app.zap?.tokens.find((token) => sameAddress(token.address, dom.payWith.value)) ?? null;
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
  store.set({
    lobbies: { open, live },
    ...(inTransit.length !== app.inTransit.size ? { inTransit: new Set(inTransit) } : {}),
  });
}

export function renderLobbies(): void {
  const { open, live } = app.lobbies;
  if (open.length === 0 && live.length === 0) {
    dom.lobbyList.replaceChildren(
      element(
        'li',
        'lobby-empty muted small',
        app.escrow
          ? app.matchmaking.length > 0
            ? 'No staked lobbies right now. Find a match, or open your own below.'
            : 'No staked lobbies right now. Open your own below.'
          : 'Server is running without an escrow: practice only.',
      ),
    );
    return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const rows: HTMLLIElement[] = [];
  const ordered = sortLobbies(open, (lobby) => isSeatedIn(lobby) || app.matched.has(lobby.matchId.toLowerCase()));
  if (ordered.length > 0) rows.push(groupHead(`Open · ${ordered.length}`), ...ordered.map((lobby) => lobbyRow(lobby, true, nowSeconds)));
  if (live.length > 0) {
    const yoursFirst = sortLobbies(live, isSeatedIn);
    rows.push(groupHead(`In play · ${live.length}`), ...yoursFirst.map((lobby) => lobbyRow(lobby, false, nowSeconds)));
  }
  dom.lobbyList.replaceChildren(...rows);
}

function groupHead(text: string): HTMLLIElement {
  return element('li', 'lobby-group', text);
}

function lobbyRow(lobby: LobbyInfo, joinable: boolean, nowSeconds: number): HTMLLIElement {
  const seated = isSeatedIn(lobby);
  const matched = app.matched.has(lobby.matchId.toLowerCase());
  const li = element('li', `lobby-row${seated || matched ? ' yours' : ''}`);
  const label = element('div', 'lobby-info');

  const top = element('div', 'lobby-top');
  top.append(
    element('strong', 'lobby-stake', `${formatEther(BigInt(lobby.stake))} ETH`),
    element('span', `pill lobby-status ${lobby.status}`, lobby.status === 'open' ? 'open' : lobby.status === 'pending' ? 'seeding' : 'live'),
  );
  if (seated) top.append(element('span', 'pill lobby-tag', 'your seat'));
  else if (matched) top.append(element('span', 'pill lobby-tag', 'your table'));
  else if (lobby.matchmade) top.append(element('span', 'pill', 'matchmade'));
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
  const bar = element('span', 'seat-bar');
  const fill = element('span');
  fill.style.width = `${Math.round((lobby.seatCount / Math.max(1, lobby.maxSeats)) * 100)}%`;
  bar.append(fill);
  meta.append(bar, element('span', '', lobbySeatsText(lobby, nowSeconds)), element('span', 'lobby-id', short(lobby.matchId)));
  meta.title = lobbySummary(lobby.stake, lobby.seatCount, lobby.maxSeats, lobby.status);
  label.append(top, meta);

  const button = element('button');
  const action = lobbyAction(lobby, seated, nowSeconds, matched);
  const spoke = currentSpoke();

  if (action === 'cancel') {
    button.textContent = 'Cancel & refund';
    button.title = 'This lobby can no longer start. Cancelling it refunds every seat.';
    button.onclick = () => void cancelLobby(button, lobby);
  } else if (action === 'enter' || action === 'watch' || !joinable) {
    button.textContent = action === 'enter' ? 'Enter' : 'Watch';
    button.onclick = () => {
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
    const token = payToken();
    if (token) {
      idleTokenButton(button, lobby, token);
    } else if (payingInLms()) {
      idleDiscountButton(button, lobby);
    } else {
      button.textContent = stakeButtonLabel(lobby.stake, null);
      button.onclick = () => void joinLobby(lobby);
    }
  }

  // A seat of yours is the one row that wants a click now. A join stays plain
  // until it is priced: there, `primary` means "this is the offer, click to pay".
  if (action === 'enter' || action === 'cancel') button.classList.add('primary');
  li.append(label, button);
  return li;
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
  if (!wallet || !escrow) return toast('Connect a wallet first.');
  if (currentSpoke()) return toast(dom.createLobby.title);
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

  try {
    if (canRelay()) {
      try {
        await relayJoin(lobby.matchId, BigInt(lobby.stake));
        return seated(lobby);
      } catch (error) {
        // Over the caps, out of today's quota, or a lobby that just filled:
        // say why, and let the wallet try it as an ordinary transaction.
        if (!(error instanceof RelayError)) throw error;
        toast(`One-click join refused: ${error.message}. Using your wallet.`);
      }
    }
    const hash = await wallet.join(escrow, lobby.matchId, BigInt(lobby.stake));
    await wallet.waitFor(hash);
    seated(lobby);
  } catch (error) {
    toast(errorFirstLine(error));
  }
}

/** The queue put this wallet at a table: its lobby is now one it can stake into. */
export function onMatched(message: Extract<ServerMessage, { type: 'matched' }>): void {
  store.set({ matched: new Set([...app.matched, message.matchId.toLowerCase()]) });
  toast(`Matched: a ${message.seats}-seat table is ready. Stake into ${short(message.matchId)} to take your seat.`);
  net.send({ type: 'lobbies' });
}

/** Cancels a lobby the player sits in that can no longer start; the refund is then theirs to withdraw. */
async function cancelLobby(button: HTMLButtonElement, lobby: LobbyInfo): Promise<void> {
  const { wallet, escrow } = app;
  if (!wallet || !escrow) return toast('Connect a wallet first.');
  button.disabled = true;
  button.textContent = 'Cancelling…';
  try {
    await wallet.waitFor(await wallet.cancelMatch(escrow, lobby.matchId));
    toast('Cancelled. Your stake is back in your balance, ready to withdraw.');
    void renderWinnings();
    net.send({ type: 'lobbies' });
  } catch (error) {
    toast(errorFirstLine(error));
    button.disabled = false;
    button.textContent = 'Cancel & refund';
  }
}

export function seated(lobby: LobbyInfo): void {
  net.send({ type: 'lobbies' });
  // The server opens the room once the lobby locks and the oracle seeds it.
  net.send({ type: 'watch', matchId: lobby.matchId });
  toast('Seat taken. The match starts when the lobby fills.');
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

export function idleTokenButton(button: HTMLButtonElement, lobby: LobbyInfo, token: ZapToken): void {
  button.textContent = stakeButtonLabel(lobby.stake, token);
  button.classList.remove('primary');
  // The pricing and paying are a chunk of their own, fetched on the first quote.
  button.onclick = () => void import('./zap.js').then((zap) => zap.quoteTokenJoin(button, lobby, token));
}

/**
 * An ETH join that spends LMS on its fee, before it is priced. The pricing
 * and paying are in `discount.ts`, loaded with the option.
 */
export function idleDiscountButton(button: HTMLButtonElement, lobby: LobbyInfo): void {
  button.textContent = `${stakeButtonLabel(lobby.stake, null)} · fee in LMS`;
  button.classList.remove('primary');
  button.onclick = () => void import('./discount.js').then((discount) => discount.quoteDiscountJoin(button, lobby));
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
  button.onclick = () => void quoteSpokeJoin(button, lobby, spoke);
}

async function quoteSpokeJoin(button: HTMLButtonElement, lobby: LobbyInfo, spoke: SpokeInfo): Promise<void> {
  const { wallet } = app;
  if (!wallet) return toast('Connect a wallet first.');

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
    toast(spokeQuoteError(errorMessage(error), spoke.chainId));
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
    await wallet.waitFor(hash);
    store.set({ inTransit: new Set([...app.inTransit, lobby.matchId.toLowerCase()]) });
    toast(
      `Stake sent from ${chainInfo(spoke.chainId).name}. It reaches ${chainInfo(app.chainId).name} once a ` +
        'relayer fills it, usually within a minute; you will be told when it is seated.',
    );
  } catch (error) {
    toast(spokeQuoteError(errorFirstLine(error), spoke.chainId));
    idleSpokeButton(button, lobby, spoke);
  }
}

/** The server's report of how one of this player's spoke joins landed on the hub. */
export function onCrossChain(event: CrossChainEvent): void {
  toast(crossChainNotice(event, app.chainId));
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
