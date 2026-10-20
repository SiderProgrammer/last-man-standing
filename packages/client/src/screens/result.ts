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
      const medal = document.createElement('span');
      medal.className = 'medal';
      medal.textContent = MEDALS[place] ?? String(place + 1);
      const name = document.createElement('span');
      name.textContent = `#${seat} ${short(address)}${seat === app.you ? ' (you)' : ''}`;
      item.append(medal, name);
      if (place === 0) item.classList.add('winner');
      if (seat === app.you) item.classList.add('you');
      return item;
    }),
  );
  renderHeadline(message.ranking, message.result.rounds);

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
  // A proposal, not a payout: the guardian may still veto the result during
  // the challenge window, and the winnings unlock when it closes.
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
    if (!onChain) {
      dom.resultDetail.textContent =
        `The escrow stored ${short(root)}, not the root this browser replayed. ` +
        'The guardian can veto the result, refunding every stake, until the challenge window closes.';
    }
  } catch {
    // The local check already stands on its own; a failed read just leaves it at that.
  }
  void renderWinnings();
}

const MEDALS = ['🏆', '🥈', '🥉'];

/** One line that says how it went for you, before the details. */
function renderHeadline(ranking: readonly number[], rounds: number): void {
  const place = app.you === null ? -1 : ranking.indexOf(app.you);
  const title = document.createElement('strong');
  const detail = document.createElement('span');
  if (place === 0) {
    title.textContent = 'Victory';
    detail.textContent = `Last one standing after ${rounds} rounds`;
  } else if (place > 0) {
    title.textContent = `${ordinal(place + 1)} of ${ranking.length}`;
    detail.textContent = `Seat #${ranking[0]} survived ${rounds} rounds`;
  } else {
    title.textContent = `Seat #${ranking[0] ?? '?'} wins`;
    detail.textContent = `${rounds} rounds`;
  }
  dom.resultHeadline.className = `result-headline ${place === 0 ? 'won' : place > 0 ? 'lost' : ''}`;
  dom.resultHeadline.replaceChildren(title, detail);
}

function ordinal(value: number): string {
  const suffix = value % 100 >= 11 && value % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][value % 10] ?? 'th');
  return `${value}${suffix}`;
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
