import { formatEther } from 'viem';
import { chainInfo } from '@lms/contracts';
import { errorFirstLine, type ServerMessage, type SpokeInfo } from '@lms/api';
import { app, dom, net, store } from '../context.js';
import { toast } from '../ui/chrome.js';
import { collectHomePlan, spokeFor } from '../ui/views.js';
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

/** Bumped on every `renderWinnings`, so a slow read cannot overwrite a newer one. */
let winningsDraw = 0;

/** Reads what the escrow owes the connected wallet and updates both buttons. */
export async function renderWinnings(): Promise<void> {
  const draw = ++winningsDraw;
  const wallet = app.wallet;
  const escrow = app.escrow;
  const buttons = [dom.collect, dom.resultCollect];

  /** The balance pill, the status line, what the buttons say, and whether there is anything to collect. */
  const show = (pill: string, status: string, open: boolean, label = 'Collect') => {
    if (draw !== winningsDraw) return;
    dom.winnings.textContent = pill;
    dom.collect.disabled = !open;
    dom.resultCollect.classList.toggle('hidden', !open);
    dom.collectStatus.textContent = status;
    for (const button of buttons) {
      button.textContent = label;
      button.onclick = () => void collectWinnings();
    }
  };
  const disable = (status: string, pill = '–') => show(pill, status, false);

  if (!wallet) return disable('Connect a wallet to check.');
  if (!escrow) return disable('This server runs practice only; there is nothing to collect.');
  if (wallet.chainId !== app.chainId) {
    const spoke = homeSpoke();
    const hub = chainInfo(app.chainId).name;
    // A player who staked from a spoke is paid on the hub too. The balance
    // there is the server's to read: this wallet's node is the spoke's.
    if (!spoke) return disable(`Winnings and refunds are paid on ${hub}. Switch your wallet there to collect.`);
    const name = chainInfo(spoke.chainId).name;
    show(`on ${hub}`, `Checking what waits for you on ${hub}…`, false, `Collect to ${name}`);
    let balance: HubBalance;
    try {
      balance = await requestBalance();
    } catch (error) {
      return disable(`Could not read your balance on ${hub}: ${errorFirstLine(error)}`);
    }
    const amount = BigInt(balance.amount);
    const plan = collectHomePlan(amount, BigInt(balance.minimum), amount, spoke.chainId, app.chainId);
    if (!plan.ok) return disable(plan.reason, `${formatEther(amount)} ETH`);
    return show(
      `${formatEther(amount)} ETH`,
      `${formatEther(amount)} ETH waits for you on ${hub}. Collecting brings all of it to ${name} through Across: ` +
        `the bridge fee comes out of it, and the server pays the ${hub} gas.`,
      true,
      `Collect ${formatEther(amount)} ETH to ${name}`,
    );
  }

  let owed: string;
  try {
    owed = await wallet.withdrawableEth(escrow);
  } catch (error) {
    return disable(`Could not read the escrow: ${errorFirstLine(error)}`);
  }

  if (Number(owed) === 0) return disable('Nothing waiting for you.', '0 ETH');

  show(
    `${owed} ETH`,
    canRelay() ? 'One click: the server pays the gas.' : 'Your wallet will ask you to confirm.',
    true,
    `Collect ${owed} ETH`,
  );
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
