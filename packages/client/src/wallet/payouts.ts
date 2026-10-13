import { errorFirstLine } from '@lms/protocol';
import { app, dom, net } from '../context.js';
import { toast } from '../ui/chrome.js';

/**
 * Collecting winnings.
 *
 * Settlement only credits a balance in the escrow; nothing reaches a player
 * until it is withdrawn. Two ways to do that, and both pay the player's own
 * address and nothing else:
 *
 *   - the server pushes it with `withdrawFor`, paying the gas — no prompt, and
 *     no permission needed, because `withdrawFor` cannot pay anyone else;
 *   - the player's wallet calls `withdraw(self)`, for a server that does not
 *     push payouts.
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
  if (wallet.chainId !== app.chainId) return disable('Switch your wallet to the hub chain to see your balance.');

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
  dom.collectStatus.textContent = app.collect
    ? 'The server pays the gas to send it to you.'
    : 'Your wallet will ask you to confirm.';
}

export async function collectWinnings(): Promise<void> {
  const wallet = app.wallet;
  const escrow = app.escrow;
  if (!wallet || !escrow) return;

  dom.collect.disabled = true;
  dom.resultCollect.disabled = true;
  try {
    if (app.collect) {
      net.send({ type: 'collect' });
      dom.collectStatus.textContent = 'Requested — the server is sending it now.';
      return;
    }
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
