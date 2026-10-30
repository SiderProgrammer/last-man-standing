import {
  PRACTICE_CHAIN_ID,
  canonicalJson,
  errorFirstLine,
  type MatchResult,
  type PublicMatchState,
  type ServerMessage,
} from '@lms/protocol';
import { app, dom } from '../context.js';
import { evidenceBundle, evidenceHash, verifyMatch, verifyOnChain, type EvidenceBundle, type Verification } from '../game/verify.js';
import { forgetMatch, recallMatch } from '../game/salts.js';
import { writeRaw } from '../io/storage.js';
import { showLobbyScreen, toast } from '../ui/chrome.js';
import { ordinal, short } from '../ui/format.js';
import type { Wallet } from '../wallet/wallet.js';
import { renderWinnings } from '../wallet/payouts.js';

/**
 * The result panel: the final ranking, whether this browser could reproduce
 * it, how it settled on-chain, and the button that collects the payout.
 */

let verification: Verification | null = null;
let shownFor: `0x${string}` | null = null;
/** The game server's HTTP origin, which serves transcripts by hash. */
let serverOrigin = '';
/** What a dispute of the result on screen would submit, once the chain check has failed. */
let evidence: EvidenceBundle | null = null;

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
  evidence = null;
  dom.resultDispute.classList.add('hidden');
  // A practice match never reaches the chain, so the replay is the whole
  // check. A staked match keeps its moves until the chain check passes: they
  // are the evidence if it does not.
  const practice = state.players.every((player) => player.chainId === PRACTICE_CHAIN_ID);
  if (practice && verification.ok) forgetMatch(state.matchId);
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
  if (!wallet || !escrow || wallet.chainId !== app.chainId) return;
  try {
    await wallet.waitFor(message.tx);
    await checkChain(wallet, escrow, message.matchId);
  } catch {
    // The local check already stands on its own; a failed read just leaves it at that.
  }
  void renderWinnings();
}

/**
 * The full check: the transcript the escrow names, audited against the
 * escrow and this browser's own moves. Passing, the stored moves are no
 * longer needed; failing, they are the evidence, and the Dispute button
 * offers to submit them.
 */
async function checkChain(wallet: Wallet, escrow: `0x${string}`, matchId: `0x${string}`): Promise<void> {
  const chain = await wallet.matchRecord(escrow, matchId);
  if (/^0x0+$/.test(chain.transcriptHash)) return;
  const own = app.you !== null ? { seat: app.you, moves: recallMatch(matchId) } : undefined;
  const { audit } = await verifyOnChain({
    chain,
    server: serverOrigin,
    ...(own ? { own } : {}),
    verifyWallet: (args) => wallet.verifyTyped(args),
  });
  if (shownFor !== matchId) return;

  if (audit.ok) {
    setVerifyPill('chain-ok');
    dom.resultDetail.textContent =
      `Checked the transcript the escrow stored (${short(chain.transcriptHash)}): every signature, ` +
      `${own ? 'your own moves, ' : ''}and a replay to the root ${short(chain.historyRoot)}.`;
    forgetMatch(matchId);
    return;
  }
  setVerifyPill('chain-bad');
  dom.resultDetail.textContent = `The transcript the escrow names does not hold up: ${audit.problems.join('; ')}.`;
  if (own) {
    evidence = evidenceBundle(matchId, chain.transcriptHash, audit, own);
    dom.resultDispute.classList.remove('hidden');
    dom.resultDispute.disabled = false;
  }
}

/**
 * Disputes the result on screen. The evidence is saved to a file first —
 * the dispute records only its hash, and the guardian needs the file — then
 * the dispute is sent, holding the payout back 48 hours.
 */
async function disputeResult(): Promise<void> {
  const wallet = app.wallet;
  const escrow = app.escrow;
  const bundle = evidence;
  if (!wallet || !escrow || !bundle) return;
  const hash = evidenceHash(bundle);
  const json = canonicalJson(bundle);
  writeRaw(`lms.evidence.${bundle.matchId}`, json);
  download(`dispute-${bundle.matchId.slice(0, 10)}.json`, json);
  try {
    dom.resultDispute.disabled = true;
    await wallet.waitFor(await wallet.dispute(escrow, bundle.matchId, hash));
    dom.resultDispute.textContent = 'Disputed';
    toast('Disputed. The payout waits 48 hours more while the guardian looks. Send them the file you just saved.');
  } catch (error) {
    dom.resultDispute.disabled = false;
    toast(errorFirstLine(error));
  }
}

function download(name: string, text: string): void {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
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

export function hideResult(): void {
  shownFor = null;
  verification = null;
  dom.resultPanel.classList.add('hidden');
}

export function wireResultControls(origin: string): void {
  serverOrigin = origin;
  dom.resultDispute.onclick = () => void disputeResult();
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
  setVerifyPill(result.ok ? 'ok' : 'bad');
  dom.resultDetail.textContent = result.ok
    ? `Replayed every round from the seed and the revealed moves · root ${short(result.root)}`
    : `This browser could not reproduce the result: ${result.reason ?? 'unknown'}.`;
}

type VerifyState = 'ok' | 'bad' | 'chain-ok' | 'chain-bad';

/** Pill label, and the one-line hover summary of what it means. Clicking it opens the full explanation. */
const VERIFY_PILL: Record<VerifyState, { label: string; ok: boolean; hint: string }> = {
  ok: {
    label: 'verified in your browser',
    ok: true,
    hint: 'This browser replayed every round from the seed and the revealed moves, and got the exact result the server announced.',
  },
  bad: {
    label: 'does not verify',
    ok: false,
    hint: 'This browser replayed the match and could not reproduce the result the server announced.',
  },
  'chain-ok': {
    label: 'verified against chain',
    ok: true,
    hint: 'This browser fetched the transcript the escrow stored, checked every player\'s signatures and your own moves, and replayed it to the root the escrow holds. Payouts follow that root.',
  },
  'chain-bad': {
    label: 'chain disagrees',
    ok: false,
    hint: 'The transcript the escrow names does not hold up. You can dispute the result while the challenge window is open.',
  },
};

function setVerifyPill(state: VerifyState): void {
  const pill = VERIFY_PILL[state];
  dom.resultVerify.textContent = pill.label;
  dom.resultVerify.title = `${pill.hint} Click to learn more.`;
  dom.resultVerify.classList.toggle('ok', pill.ok);
  dom.resultVerify.classList.toggle('bad', !pill.ok);
}
