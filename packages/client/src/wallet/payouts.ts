import { chainInfo, errorFirstLine } from '@lms/protocol';
import { app, dom } from '../context.js';
import { toast } from '../ui/chrome.js';

/**
 * Collecting winnings.
 *
 * Settlement only credits a balance in the escrow; nothing reaches a player
 * until they withdraw it, with their own wallet, to their own address. The
 * server never sends a payout.
 */

/** Reads what the escrow owes the connected wallet and updates both buttons. */
export async function renderWinnings(): Promise<void> {
  const wallet = app.wallet;
  const escrow = app.escrow;

  const disable = (status: string, pill = '–') => {
    dom.winnings.textContent = pill;
    dom.collect.disabled = true;
    dom.resultCollect.classList.add('hidden');
    dom.collectStatus.textContent = status;
  };

  if (!wallet) return disable('Connect a wallet to check.');
  if (!escrow) return disable('This server runs practice only; there is nothing to collect.');
  if (wallet.chainId !== app.chainId) {
    // A player who staked from a spoke is paid on the hub too.
    return disable(
      `Winnings and refunds are paid on ${chainInfo(app.chainId).name}. Switch your wallet there to collect.`,
    );
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
  dom.collectStatus.textContent = 'Your wallet will ask you to confirm.';
}

export async function collectWinnings(): Promise<void> {
  const wallet = app.wallet;
  const escrow = app.escrow;
  if (!wallet || !escrow) return;

  dom.collect.disabled = true;
  dom.resultCollect.disabled = true;
  try {
    dom.collectStatus.textContent = 'Confirm in your wallet…';
    const hash = await wallet.withdraw(escrow);
    await wallet.waitFor(hash);
    toast('Winnings collected.');
    await renderWinnings();
  } catch (error) {
    toast(errorFirstLine(error));
    await renderWinnings();
  } finally {
    dom.resultCollect.disabled = false;
  }
}

export function wirePayoutControls(): void {
  dom.collect.onclick = () => void collectWinnings();
  dom.resultCollect.onclick = () => void collectWinnings();
}
