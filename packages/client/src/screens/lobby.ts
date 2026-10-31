import {
  ZAP_DEADLINE_SECONDS,
  chainInfo,
  errorFirstLine,
  errorMessage,
  joinMessage,
  localQuote,
  quoteAcross,
  sameAddress,
  type BridgeQuote,
  type BotDifficulty,
  type CrossChainEvent,
  type LobbyInfo,
  type SpokeInfo,
  type ZapToken,
} from '@lms/protocol';
import { app, dom, net } from '../context.js';
import { showMatchScreen, toast } from '../ui/chrome.js';
import { element, fillSelect } from '../ui/dom.js';
import { short } from '../ui/format.js';
import {
  crossChainNotice,
  chainChips,
  lobbySummary,
  payWithOptions,
  planTokenJoin,
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
const QUOTE_TTL_MS = 30_000;

/** A little over the chain bridge's poll interval: how stale the directory can be. */
const DIRECTORY_LAG_MS = 5_000;

/** Last directory the server sent, so changing the payment token can redraw it. */
let shown: { open: LobbyInfo[]; live: LobbyInfo[] } = { open: [], live: [] };

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
  dom.payWith.onchange = () => renderLobbies(shown.open, shown.live);
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
  renderLobbies(shown.open, shown.live);
}

/** The token picked to pay with, or null for plain ETH. */
function payToken(): ZapToken | null {
  return app.zap?.tokens.find((token) => sameAddress(token.address, dom.payWith.value)) ?? null;
}

/** The spoke the wallet stakes from, or null when it is on the hub (or nowhere useful). */
function currentSpoke(): SpokeInfo | null {
  return app.wallet && app.escrow ? spokeFor(app.spokes, app.wallet.chainId) : null;
}

export function renderLobbies(open: LobbyInfo[], live: LobbyInfo[]): void {
  shown = { open, live };
  // A seat in the directory is the surest sign a stake landed, even if the
  // server's report of it was missed while the socket was down.
  for (const lobby of [...open, ...live]) {
    if (lobby.players.some((player) => sameAddress(player.address, app.wallet?.address))) {
      app.inTransit.delete(lobby.matchId.toLowerCase());
    }
  }
  if (open.length === 0 && live.length === 0) {
    dom.lobbyList.replaceChildren(
      element(
        'li',
        'muted small',
        app.escrow ? 'No staked lobbies yet. Create one above.' : 'Server is running without an escrow: practice only.',
      ),
    );
    return;
  }

  dom.lobbyList.replaceChildren(
    ...open.map((lobby) => lobbyRow(lobby, true)),
    ...live.map((lobby) => lobbyRow(lobby, false)),
  );
}

function lobbyRow(lobby: LobbyInfo, joinable: boolean): HTMLLIElement {
  const li = document.createElement('li');
  const label = element('span');
  const chips = chainChips(lobby.players).map((chip) => {
    const node = element('span', 'chain-chip', chip.label);
    node.title = chip.title;
    node.style.setProperty('--chain', chip.css);
    return node;
  });
  label.append(
    element('strong', '', short(lobby.matchId)),
    ' ',
    element('span', 'muted small', lobbySummary(lobby.stake, lobby.seatCount, lobby.maxSeats, lobby.status)),
  );
  if (chips.length > 0) {
    const row = element('span', 'chain-chips');
    row.append(...chips);
    label.append(row);
  }

  const button = document.createElement('button');
  const seated = lobby.players.some((player) => sameAddress(player.address, app.wallet?.address));

  const spoke = currentSpoke();

  if (seated || !joinable) {
    button.textContent = seated ? 'Enter' : 'Watch';
    button.onclick = () => {
      net.send({ type: 'watch', matchId: lobby.matchId });
      showMatchScreen();
    };
  } else if (app.inTransit.has(lobby.matchId.toLowerCase())) {
    button.textContent = 'In transit…';
    button.disabled = true;
    button.title = `Your stake is on its way to ${chainInfo(app.chainId).name}. You will be told when it lands.`;
  } else if (spoke) {
    idleSpokeButton(button, lobby, spoke);
  } else {
    const token = payToken();
    if (token) {
      idleTokenButton(button, lobby, token);
    } else {
      button.textContent = stakeButtonLabel(lobby.stake, null);
      button.onclick = () => void joinLobby(lobby);
    }
  }

  li.append(label, button);
  return li;
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

function seated(lobby: LobbyInfo): void {
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

function idleTokenButton(button: HTMLButtonElement, lobby: LobbyInfo, token: ZapToken): void {
  button.textContent = stakeButtonLabel(lobby.stake, token);
  button.classList.remove('primary');
  button.onclick = () => void quoteTokenJoin(button, lobby, token);
}

async function quoteTokenJoin(button: HTMLButtonElement, lobby: LobbyInfo, token: ZapToken): Promise<void> {
  const { wallet, zap } = app;
  if (!wallet || !zap) return toast('Connect a wallet first.');

  button.disabled = true;
  button.textContent = 'Quoting…';
  try {
    const [quote, balance] = await Promise.all([
      wallet.quoteZap(zap.quoter, token.path, BigInt(lobby.stake)),
      wallet.tokenBalance(token.address),
    ]);
    const plan = planTokenJoin(token, quote, balance);
    if (!plan.ok) {
      toast(plan.reason);
      idleTokenButton(button, lobby, token);
      return;
    }

    button.textContent = plan.label;
    button.classList.add('primary');
    const expiry = setTimeout(() => idleTokenButton(button, lobby, token), QUOTE_TTL_MS);
    button.onclick = () => {
      clearTimeout(expiry);
      void payTokenJoin(button, lobby, token, plan.maxAmountIn);
    };
  } catch (error) {
    // Almost always a route with no pool behind it, or a wallet on another chain.
    toast(`Could not price ${token.symbol}: ${errorFirstLine(error)}`);
    idleTokenButton(button, lobby, token);
  } finally {
    button.disabled = false;
  }
}

async function payTokenJoin(
  button: HTMLButtonElement,
  lobby: LobbyInfo,
  token: ZapToken,
  maxAmountIn: bigint,
): Promise<void> {
  const { wallet, zap } = app;
  if (!wallet || !zap) return;

  button.disabled = true;
  try {
    if ((await wallet.tokenAllowance(token.address, zap.address)) < maxAmountIn) {
      button.textContent = `Approve ${token.symbol}…`;
      // Exactly this join's ceiling, not an unlimited allowance: the zap is
      // ownerless, but an allowance outlives the join it was granted for.
      await wallet.approveToken(token.address, zap.address, maxAmountIn);
    }

    button.textContent = 'Confirm the join…';
    const deadline = BigInt(Math.floor(Date.now() / 1000) + ZAP_DEADLINE_SECONDS);
    const hash = await wallet.joinWithToken(zap.address, lobby.matchId, token.path, maxAmountIn, deadline);
    button.textContent = 'Joining…';
    await wallet.waitFor(hash);
    seated(lobby);
  } catch (error) {
    toast(errorFirstLine(error));
    idleTokenButton(button, lobby, token);
  } finally {
    button.disabled = false;
  }
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
    if (!routes.has(key)) routes.set(key, wallet.spokeRoute(spoke.router));
    const route = await routes.get(key)!;
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
    button.textContent = spokeQuoteLabel(stake, priced.inputAmount);
    button.classList.add('primary');
    const expiry = setTimeout(() => idleSpokeButton(button, lobby, spoke), QUOTE_TTL_MS);
    button.onclick = () => {
      clearTimeout(expiry);
      void paySpokeJoin(button, lobby, spoke, priced.quote, priced.inputAmount);
    };
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
    const hash = await wallet.joinFromSpoke(spoke.router, lobby.matchId, quote, total);
    button.textContent = 'Sending…';
    await wallet.waitFor(hash);
    app.inTransit.add(lobby.matchId.toLowerCase());
    renderLobbies(shown.open, shown.live);
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
    // to stake for a seat the player already holds. `renderLobbies` unlocks it.
    // No `watch` yet: the room only exists once the lobby locks and the
    // oracle seeds it, and asking sooner answers "unknown match" over this
    // notice. The row's Enter button attaches the player then.
    net.send({ type: 'lobbies' });
    setTimeout(() => net.send({ type: 'lobbies' }), DIRECTORY_LAG_MS);
  } else if (event.kind === 'refunded') {
    app.inTransit.delete(event.matchId.toLowerCase());
    void renderWinnings();
  }
  renderLobbies(shown.open, shown.live);
}
