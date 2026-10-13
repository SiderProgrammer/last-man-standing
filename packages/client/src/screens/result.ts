import type { MatchResult, PublicMatchState, ServerMessage } from '@lms/protocol';
import { app, dom } from '../context.js';
import { matchesChain, verifyMatch, type Verification } from '../game/verify.js';
import { showLobbyScreen } from '../ui/chrome.js';
import { short } from '../ui/format.js';
import { renderWinnings } from '../wallet/payouts.js';

/**
 * The result panel: the final ranking, whether this browser could reproduce
 * it, how it settled on-chain, and the button that collects the payout.
 */

let verification: Verification | null = null;
let shownFor: `0x${string}` | null = null;

export function showResult(
  state: PublicMatchState,
  message: Extract<ServerMessage, { type: 'finished' }>,
): void {
  shownFor = state.matchId;
  dom.resultPanel.classList.remove('hidden');
  dom.resultSettle.textContent = '';

  dom.resultRanking.replaceChildren(
    ...message.ranking.map((seat, place) => {
      const item = document.createElement('li');
      const address = state.players[seat]?.address ?? '0x?';
      item.textContent = `#${seat} ${short(address)}${seat === app.you ? ' (you)' : ''}`;
      if (place === 0) item.classList.add('winner');
      return item;
    }),
  );

  verification = verify(state, message.result);
  renderVerification();
  void renderWinnings();
}

/** Settlement arrived: show the transaction, then hold the escrow's root against ours. */
export async function onSettled(message: Extract<ServerMessage, { type: 'settled' }>): Promise<void> {
  if (message.matchId !== shownFor) return;
  if (!message.tx) {
    dom.resultSettle.textContent =
      'Settlement could not be submitted. The escrow refunds every stake after its deadline.';
    return;
  }
  // A proposal, not a payout: the result stays open to a fraud proof for the
  // challenge window, and the winnings unlock when it closes unchallenged.
  dom.resultSettle.textContent =
    `Proposed on-chain · ${short(message.tx)} · winnings unlock once the challenge window closes`;

  const wallet = app.wallet;
  const escrow = app.escrow;
  if (!wallet || !escrow || wallet.chainId !== app.chainId || !verification) return;
  try {
    await wallet.waitFor(message.tx);
    const root = await wallet.settledRoot(escrow, message.matchId);
    const onChain = matchesChain(verification, root);
    dom.resultVerify.textContent = onChain ? 'verified against chain' : 'chain disagrees';
    dom.resultVerify.classList.toggle('ok', onChain);
    dom.resultVerify.classList.toggle('bad', !onChain);
    if (!onChain) dom.resultDetail.textContent = `The escrow stored ${short(root)}, not the root this browser replayed.`;
  } catch {
    // The local check already stands on its own; a failed read just leaves it at that.
  }
  void renderWinnings();
}

export function hideResult(): void {
  shownFor = null;
  verification = null;
  dom.resultPanel.classList.add('hidden');
}

export function wireResultControls(): void {
  dom.resultBack.onclick = () => {
    hideResult();
    showLobbyScreen();
  };
}

function verify(state: PublicMatchState, result: MatchResult): Verification {
  try {
    return verifyMatch(state, result);
  } catch (error) {
    return { ok: false, root: '0x', reason: `replay failed: ${String(error)}` };
  }
}

function renderVerification(): void {
  const result = verification;
  if (!result) return;
  dom.resultVerify.textContent = result.ok ? 'verified in your browser' : 'does not verify';
  dom.resultVerify.classList.toggle('ok', result.ok);
  dom.resultVerify.classList.toggle('bad', !result.ok);
  dom.resultDetail.textContent = result.ok
    ? `Replayed every round from the seed and the revealed moves · root ${short(result.root)}`
    : `This browser could not reproduce the result: ${result.reason ?? 'unknown'}.`;
}
