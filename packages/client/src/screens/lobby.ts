import { encodeFunctionData } from 'viem';
import {
  ZAP_DEADLINE_SECONDS,
  errorFirstLine,
  gameEscrowAbi,
  sameAddress,
  type BotDifficulty,
  type LobbyInfo,
  type ZapToken,
} from '@lms/protocol';
import { app, dom, net } from '../context.js';
import { showMatchScreen, toast } from '../ui/chrome.js';
import { fillSelect } from '../ui/dom.js';
import { short } from '../ui/format.js';
import { lobbySummary, payWithOptions, planTokenJoin, stakeButtonLabel } from '../ui/views.js';
import { relayCall } from '../wallet/flows.js';

/** The lobby screen: practice, the staked-lobby directory, create and join. */

/**
 * How long a quoted price may be accepted. The contract enforces the ceiling
 * whenever the join lands; this only stops the player agreeing to a figure
 * they looked at minutes ago.
 */
const QUOTE_TTL_MS = 30_000;

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

/** Shows the "Pay with" picker only when the server routes at least one token. */
export function renderPayWith(): void {
  fillSelect(dom.payWith, payWithOptions(app.zap));
  dom.payWithRow.classList.toggle('hidden', !app.zap);
  renderLobbies(shown.open, shown.live);
}

/** The token picked to pay with, or null for plain ETH. */
function payToken(): ZapToken | null {
  return app.zap?.tokens.find((token) => sameAddress(token.address, dom.payWith.value)) ?? null;
}

export function renderLobbies(open: LobbyInfo[], live: LobbyInfo[]): void {
  shown = { open, live };
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
  label.innerHTML = lobbySummary(
    lobby.matchId,
    lobby.stake,
    lobby.seatCount,
    lobby.maxSeats,
    lobby.status,
    lobby.players,
    short,
  );

  const button = document.createElement('button');
  const seated = lobby.players.some((player) => sameAddress(player.address, app.wallet?.address));

  if (seated || !joinable) {
    button.textContent = seated ? 'Enter' : 'Watch';
    button.onclick = () => {
      net.send({ type: 'watch', matchId: lobby.matchId });
      showMatchScreen();
    };
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
// Never through the session key: its scope covers the escrow and the avatar
// collection, not the zap, and a token approval is exactly the kind of call a
// prompt-free key should not be able to make.

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
