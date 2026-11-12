import { formatEther, parseEther } from 'viem';
import { MatchStatus, chainInfo } from '@lms/contracts';
import { errorFirstLine, type ServerMessage, type SpokeInfo } from '@lms/api';
import { app, dom, net, store } from '../context.js';
import { showScreen, toast } from '../ui/chrome.js';
import { formatDuration } from '../ui/staking.js';
import {
  collectHomePlan,
  formatEth,
  pendingPrizesText,
  prizeFor,
  spokeFor,
  winningsBadge,
  type PendingPrize,
} from '../ui/views.js';
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
  const show = (pill: string, status: string, open: boolean, label = 'Collect', owed: bigint | null = null) => {
    if (draw !== winningsDraw) return;
    dom.winnings.textContent = pill;
    dom.collect.disabled = !open;
    dom.resultCollect.classList.toggle('hidden', !open);
    dom.collectStatus.textContent = status;
    for (const button of buttons) {
      button.textContent = label;
      button.onclick = () => void collectWinnings();
    }
    // On the result panel the balance sits under one match's prize, and is
    // not that prize: an older balance would read as this match's winnings.
    if (open && owed !== null) dom.resultCollect.textContent = `Collect your balance (${formatEth(owed)} ETH)`;
    if (app.owed !== owed) store.set({ owed });
  };
  const disable = (status: string, pill = '–', owed: bigint | null = null) => show(pill, status, false, 'Collect', owed);

  if (!wallet) return disable('Connect a wallet to check.');
  if (wallet.isGuest) return disable('Guests play practice only. Connect a wallet to play for stakes and collect.');
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
    if (!plan.ok) return disable(plan.reason, `${formatEther(amount)} ETH`, amount);
    return show(
      `${formatEther(amount)} ETH`,
      `${formatEther(amount)} ETH waits for you on ${hub}. Collecting brings all of it to ${name} through Across: ` +
        `the bridge fee comes out of it, and the server pays the ${hub} gas.`,
      true,
      `Collect ${formatEther(amount)} ETH to ${name}`,
      amount,
    );
  }

  let owed: string;
  try {
    owed = await wallet.withdrawableEth(escrow);
  } catch (error) {
    return disable(`Could not read the escrow: ${errorFirstLine(error)}`);
  }
  void renderPending(draw);

  const wei = parseEther(owed);
  if (wei === 0n) return disable('Nothing waiting for you.', '0 ETH', 0n);

  show(
    `${owed} ETH`,
    canRelay() ? 'One click: the server pays the gas.' : 'Your wallet will ask you to confirm.',
    true,
    `Collect ${owed} ETH`,
    wei,
  );
}

/**
 * Prizes this wallet won that are still in their challenge window: not in
 * the balance yet, but coming. Read from the escrow for its recent staked
 * matches, as the history lists them.
 */
async function renderPending(draw: number): Promise<void> {
  const { wallet, escrow } = app;
  if (!wallet || !escrow) return;
  const cutoff = Date.now() - PENDING_LOOKBACK_MS;
  const recent = app.history.filter((match) => match.staked && match.place >= 1 && match.finishedAt >= cutoff).slice(0, 10);
  const reads = await Promise.all(
    recent.map(async (match): Promise<PendingPrize | null> => {
      try {
        const payout = await wallet.matchPayout(escrow, match.matchId);
        if (payout.status !== MatchStatus.Proposed) return null;
        const amount = prizeFor(payout, match.place - 1);
        return amount > 0n ? { matchId: match.matchId, amount, unlocksIn: Math.max(0, payout.deadline - payout.chainTime) } : null;
      } catch {
        return null;
      }
    }),
  );
  if (draw !== winningsDraw) return;
  const pending = reads.filter((prize): prize is PendingPrize => prize !== null);
  store.set({ pendingPrizes: pending });
  const text = pendingPrizesText(pending, formatDuration);
  dom.pendingPrizes.textContent = text;
  dom.pendingPrizes.classList.toggle('hidden', text === '');
}

/** How far back a prize can still be in its challenge window, with a dispute's 48 hours on top. */
const PENDING_LOOKBACK_MS = 7 * 24 * 3_600_000;

/** The header badge: what is waiting to be collected, or on its way; a click opens Winnings. */
function renderBadge(): void {
  const text = app.wallet && app.owed !== null ? winningsBadge(app.owed, app.pendingPrizes) : null;
  dom.winningsBadge.classList.toggle('hidden', text === null);
  dom.winningsBadge.classList.toggle('ready', (app.owed ?? 0n) > 0n);
  if (text) dom.winningsBadge.textContent = text;
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
      await wallet.waitFor(hash, 'Collect winnings');
    }
    toast('Winnings collected.', 'success');
    await renderWinnings();
  } catch (error) {
    toast(errorFirstLine(error), 'error');
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
    ['wallet', 'walletChainId', 'chainId', 'escrow', 'oneClick', 'withdrawToChain', 'spokes', 'history'],
    () => void renderWinnings(),
  );
  store.subscribe(['wallet', 'owed', 'pendingPrizes'], renderBadge);
  dom.winningsBadge.onclick = () => {
    showScreen('lobby');
    dom.winningsPanel.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
}
