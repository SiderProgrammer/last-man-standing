import {
  chainInfo,
  errorFirstLine,
  localQuote,
  quoteAcrossFrom,
  quoteToWire,
  withdrawalToWire,
  withdrawalTypedData,
  type BridgeQuote,
  type ChainWithdrawal,
  type SpokeInfo,
} from '@lms/protocol';
import { app, dom } from '../context.js';
import { toast } from '../ui/chrome.js';
import { collectHomePlan } from '../ui/views.js';
import { RelayError, sendRelayed } from './oneClick.js';
import { collectWinnings, renderWinnings, requestBalance } from './payouts.js';

/**
 * Collecting winnings to the spoke the wallet is on.
 *
 * Two clicks, like a join from a spoke: the first asks the server what the
 * hub holds for this wallet, and Across what bridging all of it costs, and
 * turns the button into what will arrive; the second signs the withdrawal
 * — on the spoke, which its EIP-712 domain allows — and hands it to the
 * server, which submits it on the hub and pays the gas there.
 *
 * Without `VITE_ACROSS_API`, as on the local stack, the quote has no fee.
 */

const ACROSS_API = import.meta.env.VITE_ACROSS_API ?? '';
/** How long a quote may be accepted, as for a join. */
const QUOTE_TTL_MS = 30_000;
/** How long the signed withdrawal stays valid on the hub, in seconds. */
const WITHDRAWAL_SECONDS = 10 * 60;

const buttons = () => [dom.collect, dom.resultCollect];

export async function quoteCollectHome(spoke: SpokeInfo): Promise<void> {
  const wallet = app.wallet;
  if (!wallet) return;
  const name = chainInfo(spoke.chainId).name;

  for (const button of buttons()) button.disabled = true;
  dom.collectStatus.textContent = 'Reading your balance…';
  try {
    const balance = await requestBalance();
    const amount = BigInt(balance.amount);
    const route = await wallet.spokeRoute(spoke.router);
    const priced = ACROSS_API
      ? await quoteAcrossFrom(
          ACROSS_API,
          {
            originChainId: app.chainId,
            destinationChainId: spoke.chainId,
            inputToken: route.hubWeth,
            outputToken: route.weth,
            recipient: wallet.address,
            message: '0x',
          },
          amount,
        )
      : { outputAmount: amount, quote: localQuote(amount, balance.chainTime).quote };

    const plan = collectHomePlan(amount, BigInt(balance.minimum), priced.outputAmount, spoke.chainId, app.chainId);
    if (!plan.ok) {
      toast(plan.reason);
      await renderWinnings();
      return;
    }

    const withdrawal: ChainWithdrawal = {
      player: wallet.address,
      hubChainId: BigInt(app.chainId),
      destinationChainId: BigInt(spoke.chainId),
      recipient: wallet.address,
      outputToken: route.weth,
      // Exactly the fee quoted: the output is fixed, so a balance that has
      // grown since is refused on the hub rather than bridged at a worse rate.
      maxFee: amount - priced.outputAmount,
      nonce: BigInt(balance.withdrawalNonce),
      deadline: BigInt(balance.chainTime + WITHDRAWAL_SECONDS),
    };
    dom.collectStatus.textContent = plan.detail;
    const expiry = setTimeout(() => void renderWinnings(), QUOTE_TTL_MS);
    for (const button of buttons()) {
      button.textContent = plan.label;
      button.disabled = false;
      button.onclick = () => {
        clearTimeout(expiry);
        void collectHome(name, balance.receiver, withdrawal, priced.quote);
      };
    }
  } catch (error) {
    toast(`Could not price bringing your winnings to ${name}: ${errorFirstLine(error)}`);
    await renderWinnings();
  }
}

async function collectHome(
  name: string,
  receiver: `0x${string}`,
  withdrawal: ChainWithdrawal,
  quote: BridgeQuote,
): Promise<void> {
  const wallet = app.wallet;
  if (!wallet) return;
  for (const button of buttons()) button.disabled = true;
  try {
    dom.collectStatus.textContent = 'Sign the withdrawal in your wallet…';
    const signature = await wallet.client.signTypedData({ account: wallet.signer, ...withdrawalTypedData(receiver, withdrawal) });
    dom.collectStatus.textContent = 'Submitting it on the hub…';
    await sendRelayed((id) => ({
      type: 'withdrawToChain',
      id,
      withdrawal: withdrawalToWire(withdrawal),
      quote: quoteToWire(quote),
      signature,
    }));
    toast(`On its way to ${name}: it arrives once a relayer fills it, usually within a minute.`);
  } catch (error) {
    toast(error instanceof RelayError ? `Withdrawal refused: ${error.message}` : errorFirstLine(error));
  } finally {
    for (const button of buttons()) button.onclick = () => void collectWinnings();
    await renderWinnings();
  }
}
