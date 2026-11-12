import { type LobbyInfo } from '@lms/api';
import { app, store } from '../context.js';
import { toast } from '../ui/chrome.js';
import { discountJoinLabel, discountSavingText } from '../ui/views.js';
import * as discountCalls from '../wallet/discount.js';
import { armQuote, idleDiscountButton, seatTaken, seated } from './lobby.js';
import { explainError } from '../ui/errors.js';

/**
 * Paying part of a seat's fee in LMS. Loaded once a wallet is on the hub,
 * where the escrow is, to read whether governance has the discount on.
 *
 * Two clicks, like token payment: the first asks the escrow what this
 * wallet's LMS takes off the fee and turns the button into the price; the
 * second signs the LMS permit and joins. Always the player's own
 * transaction: one-click play's session key never spends LMS.
 */

/** Reads the discount's terms and this wallet's LMS into the store. */
export async function refreshDiscount(): Promise<void> {
  const { wallet, escrow } = app;
  if (!wallet || !escrow || wallet.chainId !== app.chainId) return store.set({ discount: null });
  try {
    store.set({ discount: await discountCalls.discountTerms(wallet, escrow) });
  } catch (error) {
    console.warn('[discount] could not read the terms', error);
    store.set({ discount: null });
  }
}

export async function quoteDiscountJoin(button: HTMLButtonElement, lobby: LobbyInfo): Promise<void> {
  const { wallet, escrow, discount } = app;
  if (!wallet || !escrow || !discount) return toast('Connect a wallet first.', 'error');

  button.disabled = true;
  button.textContent = 'Quoting…';
  try {
    const quote = await discountCalls.quoteDiscount(wallet, escrow, lobby.matchId, discount.balance);
    if (quote.discount === 0n) {
      toast('Your LMS takes nothing off this fee.');
      idleDiscountButton(button, lobby);
      return;
    }
    armQuote(
      button,
      discountJoinLabel(lobby.stake, quote),
      () => idleDiscountButton(button, lobby),
      () => void payDiscountJoin(button, lobby, discount.token, quote),
    );
    // What the LMS buys, said on the join it buys it for.
    const saving = discountSavingText(quote);
    button.title = saving;
    toast(`${saving} Click the button again to pay.`, 'info');
  } catch (error) {
    toast(`Could not price the discount: ${explainError(error)}`, 'error');
    idleDiscountButton(button, lobby);
  } finally {
    button.disabled = false;
  }
}

async function payDiscountJoin(
  button: HTMLButtonElement,
  lobby: LobbyInfo,
  token: `0x${string}`,
  quote: { discount: bigint; lmsUsed: bigint },
): Promise<void> {
  const { wallet, escrow } = app;
  if (!wallet || !escrow) return;

  button.disabled = true;
  try {
    button.textContent = 'Confirm the join…';
    const hash = await discountCalls.joinWithLms(wallet, escrow, token, lobby.matchId, BigInt(lobby.stake), quote);
    button.textContent = 'Joining…';
    seated(lobby, undefined, seatTaken(await wallet.waitFor(hash, 'Stake with LMS discount')));
    void refreshDiscount();
  } catch (error) {
    toast(explainError(error), 'error');
    idleDiscountButton(button, lobby);
  } finally {
    button.disabled = false;
  }
}
