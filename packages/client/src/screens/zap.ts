import { ZAP_DEADLINE_SECONDS, errorFirstLine, type LobbyInfo, type ZapToken } from '@lms/protocol';
import { app } from '../context.js';
import { toast } from '../ui/chrome.js';
import { planTokenJoin } from '../ui/views.js';
import * as zapCalls from '../wallet/zap.js';
import { QUOTE_TTL_MS, idleTokenButton, seated } from './lobby.js';

/**
 * Paying a stake in a token, through `ZapJoin`: the second and third clicks
 * of the flow `lobby.ts` starts. Loaded on a player's first token quote, so a
 * server or a player that only uses ETH never fetches it.
 */

export async function quoteTokenJoin(button: HTMLButtonElement, lobby: LobbyInfo, token: ZapToken): Promise<void> {
  const { wallet, zap } = app;
  if (!wallet || !zap) return toast('Connect a wallet first.');

  button.disabled = true;
  button.textContent = 'Quoting…';
  try {
    const [quote, balance] = await Promise.all([
      zapCalls.quoteZap(wallet, zap.quoter, token.path, BigInt(lobby.stake)),
      zapCalls.tokenBalance(wallet, token.address),
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
    if ((await zapCalls.tokenAllowance(wallet, token.address, zap.address)) < maxAmountIn) {
      button.textContent = `Approve ${token.symbol}…`;
      // Exactly this join's ceiling, not an unlimited allowance: the zap is
      // ownerless, but an allowance outlives the join it was granted for.
      await zapCalls.approveToken(wallet, token.address, zap.address, maxAmountIn);
    }

    button.textContent = 'Confirm the join…';
    const deadline = BigInt(Math.floor(Date.now() / 1000) + ZAP_DEADLINE_SECONDS);
    const hash = await zapCalls.joinWithToken(wallet, zap.address, lobby.matchId, token.path, maxAmountIn, deadline);
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
