import { chainInfo, errorFirstLine, type ServerMessage, type SpokeInfo } from '@lms/protocol';
import { app, dom, net, store } from '../context.js';
import { toast } from '../ui/chrome.js';
import { spokeFor } from '../ui/views.js';
import { RelayError, canRelay, relayCollect } from './oneClick.js';

/**
 * Collecting winnings.
 *
 * Settlement only credits a balance in the escrow; nothing reaches a player
 * until they withdraw it to their own address: with their own wallet, or with
 * one-click play, through `withdrawFor`, which can pay nobody else. The server
 * never sends a payout of its own accord.
 *
 * A wallet on a spoke collects to that spoke instead (`collectHome.ts`): it
 * signs a withdrawal of its whole hub balance there, and the server submits
 * it on the hub, where the player may hold no gas at all.
 */

/** The spoke the wallet is on, when the server will bring its winnings there. */
function homeSpoke(): SpokeInfo | null {
  const wallet = app.wallet;
  if (!wallet || !app.escrow || !app.withdrawToChain || wallet.chainId === app.chainId) return null;
  return spokeFor(app.spokes, wallet.chainId);
}

/** Reads what the escrow owes the connected wallet and updates both buttons. */
export async function renderWinnings(): Promise<void> {
  const wallet = app.wallet;
  const escrow = app.escrow;
  const buttons = [dom.collect, dom.resultCollect];

  const disable = (status: string, pill = '–') => {
    dom.winnings.textContent = pill;
    dom.collect.disabled = true;
    dom.resultCollect.classList.add('hidden');
    dom.collectStatus.textContent = status;
  };
  for (const button of buttons) {
    button.textContent = button === dom.collect ? 'Collect' : 'Collect winnings';
    button.onclick = () => void collectWinnings();
  }

  if (!wallet) return disable('Connect a wallet to check.');
  if (!escrow) return disable('This server runs practice only; there is nothing to collect.');
  if (wallet.chainId !== app.chainId) {
    const spoke = homeSpoke();
    const hub = chainInfo(app.chainId).name;
    // A player who staked from a spoke is paid on the hub too. The balance
    // there is the server's to read: this wallet's node is the spoke's.
    if (!spoke) return disable(`Winnings and refunds are paid on ${hub}. Switch your wallet there to collect.`);
    const name = chainInfo(spoke.chainId).name;
    dom.winnings.textContent = `on ${hub}`;
    for (const button of buttons) button.textContent = `Collect to ${name}`;
    dom.collect.disabled = false;
    dom.resultCollect.classList.remove('hidden');
    dom.collectStatus.textContent =
      `Your winnings and refunds wait on ${hub}. Collecting brings all of them to ${name} through Across: ` +
      `the bridge fee comes out of them, and the server pays the ${hub} gas.`;
    return;
  }

  let owed: string;
  try {
    owed = await wallet.withdrawableEth(escrow);
  } catch (error) {
    return disable(`Could not read the escrow: ${errorFirstLine(error)}`);
  }

  if (Number(owed) === 0) return disable('Nothing waiting for you.', '0 ETH');

  dom.winnings.textContent = `${owed} ETH`;
  dom.collect.disabled = false;
  dom.resultCollect.classList.remove('hidden');
  dom.collectStatus.textContent = canRelay()
    ? 'One click: the server pays the gas.'
    : 'Your wallet will ask you to confirm.';
}

export async function collectWinnings(): Promise<void> {
  const wallet = app.wallet;
  const escrow = app.escrow;
  if (!wallet || !escrow) return;

  const spoke = homeSpoke();
  if (spoke) {
    // Its own chunk: the pricing and signing of a withdrawal to a spoke.
    void import('./collectHome.js').then((home) => home.quoteCollectHome(spoke));
    return;
  }

  dom.collect.disabled = true;
  dom.resultCollect.disabled = true;
  try {
    if (!(canRelay() && (await collectByRelay()))) {
      dom.collectStatus.textContent = 'Confirm in your wallet…';
      const hash = await wallet.withdraw(escrow);
      await wallet.waitFor(hash);
    }
    toast('Winnings collected.');
    await renderWinnings();
  } catch (error) {
    toast(errorFirstLine(error));
    await renderWinnings();
  } finally {
    dom.resultCollect.disabled = false;
  }
}

/**
 * Collects through the relayer. False when it refused — under the escrow's
 * minimum for a relayed withdrawal, or out of today's quota — so the wallet
 * can collect it itself.
 */
async function collectByRelay(): Promise<boolean> {
  dom.collectStatus.textContent = 'Collecting…';
  try {
    await relayCollect();
    return true;
  } catch (error) {
    if (!(error instanceof RelayError)) throw error;
    toast(`One-click collect refused: ${error.message}. Using your wallet.`);
    return false;
  }
}

export type HubBalance = Extract<ServerMessage, { type: 'balance' }>;

/** How long to wait for the server's `balance` before giving up on it. */
const BALANCE_TIMEOUT_MS = 10_000;

let balanceWaiters: Array<(message: HubBalance) => void> = [];

/** Asks the server for this wallet's hub balance and the terms to withdraw it. */
export function requestBalance(): Promise<HubBalance> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the server did not say what you hold on the hub')), BALANCE_TIMEOUT_MS);
    balanceWaiters.push((message) => {
      clearTimeout(timer);
      resolve(message);
    });
    net.send({ type: 'balance' });
  });
}

export function onBalance(message: HubBalance): void {
  const waiters = balanceWaiters;
  balanceWaiters = [];
  for (const resolve of waiters) resolve(message);
}

export function wirePayoutControls(): void {
  store.subscribe(
    ['wallet', 'walletChainId', 'chainId', 'escrow', 'oneClick', 'withdrawToChain', 'spokes'],
    () => void renderWinnings(),
  );
}
