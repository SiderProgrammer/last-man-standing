import { VoteSupport, type ProposalSummary, type VoteSupportValue } from '@lms/contracts';
import { errorFirstLine } from '@lms/api';
import { app, dom } from '../context.js';
import { toast } from '../ui/chrome.js';
import { element } from '../ui/dom.js';
import { proposalCard, type ProposalCard, type ProposalLive } from '../ui/governance.js';
import { knownContracts, loadProposalContext, renderNewProposalButton, wireProposalForm } from './proposalForm.js';
import * as governorCalls from '../wallet/governance.js';

/**
 * The governance screen: every proposal, its result so far, and the vote.
 * Loaded the first time the screen opens (`governanceNav.ts`).
 *
 * The list comes from the game server, which indexes the governor's events;
 * everything that changes — state, tallies, quorum, this wallet's power — is
 * read from the chain through the player's own wallet.
 *
 * Proposal text is written by whoever proposed it, so it is untrusted: cards
 * are built with `textContent`, never `innerHTML`.
 */

let serverOrigin = '';
let proposals: ProposalSummary[] = [];
let busy = false;

export function wireGovernanceControls(origin: string): void {
  serverOrigin = origin;
  // A new proposal reaches the list once the server's index polls for it,
  // every fifteen seconds: refresh now, and again once it surely has.
  wireProposalForm(() => {
    void renderGovernance();
    setTimeout(() => void renderGovernance(), 16_000);
  });
  // One listener for every card's buttons, which are rebuilt on each render.
  dom.proposalList.onclick = (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-step]');
    if (!button || busy) return;
    const proposal = proposals.find((p) => p.id === button.dataset.id);
    if (proposal) void act(proposal, button.dataset.step!, button);
  };
}

export async function renderGovernance(): Promise<void> {
  const governor = app.staking?.governor;
  const vault = app.staking?.vault;
  if (!governor || !vault) return;

  try {
    const response = await fetch(`${serverOrigin}/proposals`);
    proposals = response.ok ? ((await response.json()) as ProposalSummary[]) : [];
  } catch (error) {
    dom.governanceStatus.textContent = `Could not load proposals: ${errorFirstLine(error)}`;
    return;
  }

  const wallet = app.wallet;
  renderNewProposalButton();
  if (wallet) await loadProposalContext().catch(() => null);
  const labels = knownContracts();
  const cards: ProposalCard[] = [];
  let readError: string | null = null;
  for (const proposal of proposals) {
    let live: ProposalLive | null = null;
    if (wallet) {
      try {
        live = await governorCalls.proposalLive(wallet, governor, vault, proposal);
      } catch (error) {
        // Almost always a wallet on the wrong chain; show the text regardless.
        readError = `Could not read results: ${errorFirstLine(error)}`;
      }
    }
    cards.push(proposalCard(proposal, live, labels));
  }

  dom.governanceStatus.textContent =
    readError ??
    (proposals.length === 0
      ? 'No proposals yet.'
      : wallet
        ? `${proposals.length} proposal${proposals.length === 1 ? '' : 's'}.`
        : 'Connect a wallet to see results and vote.');
  dom.proposalList.replaceChildren(...cards.map(cardElement));
}

function cardElement(card: ProposalCard): HTMLLIElement {
  const li = element('li', 'proposal');

  const head = element('div', 'panel-head');
  head.append(element('h3', '', card.title), element('span', `pill proposal-state ${card.state.tone}`, card.state.label));
  li.append(head, element('p', 'muted small', [card.byline, card.window].filter(Boolean).join(' · ')));

  const actions = element('ol', 'proposal-actions');
  for (const action of card.actions) {
    const item = element('li');
    item.append(element('code', '', `${action.target}.${action.call}`));
    if (action.warning) item.append(element('div', 'warn', action.warning));
    actions.append(item);
  }
  li.append(actions);

  if (card.body) {
    const details = element('details');
    details.append(element('summary', 'small', 'Full description'), element('pre', 'proposal-body', card.body));
    li.append(details);
  }

  if (card.tally) {
    const bar = element('div', 'tally-bar');
    for (const side of ['for', 'against', 'abstain'] as const) {
      const segment = element('span', side);
      segment.style.width = `${card.tally.shares[side]}%`;
      bar.append(segment);
    }
    li.append(
      bar,
      element('p', 'small', `For ${card.tally.for} · Against ${card.tally.against} · Abstain ${card.tally.abstain}`),
      element('p', 'muted small', card.quorum),
    );
  }
  li.append(element('p', 'small', card.you));

  const row = element('div', 'row');
  if (card.canVote) {
    const reason = element('input');
    reason.placeholder = 'Reason (optional, public)';
    reason.dataset.reasonFor = card.id;
    row.append(
      button(card.id, 'for', 'Vote for', 'primary'),
      button(card.id, 'against', 'Vote against'),
      button(card.id, 'abstain', 'Abstain', 'ghost'),
      reason,
    );
  }
  if (card.canQueue) row.append(button(card.id, 'queue', 'Queue in timelock', 'primary'));
  if (card.canExecute) row.append(button(card.id, 'execute', 'Execute', 'primary'));
  if (row.childElementCount > 0) li.append(row);
  return li;
}

const SUPPORT: Record<string, VoteSupportValue> = {
  for: VoteSupport.For,
  against: VoteSupport.Against,
  abstain: VoteSupport.Abstain,
};

async function act(proposal: ProposalSummary, step: string, origin: HTMLButtonElement): Promise<void> {
  const wallet = app.wallet;
  const governor = app.staking?.governor;
  if (!wallet || !governor) return;

  busy = true;
  for (const b of dom.proposalList.querySelectorAll('button')) b.disabled = true;
  try {
    let hash: `0x${string}`;
    if (step === 'queue' || step === 'execute') {
      hash = await governorCalls.advanceProposal(wallet, governor, proposal, step);
    } else {
      const reason =
        origin.closest('.proposal')?.querySelector<HTMLInputElement>('input[data-reason-for]')?.value ?? '';
      hash = await governorCalls.castVote(wallet, governor, proposal.id, SUPPORT[step]!, reason);
    }
    await wallet.waitFor(hash);
    toast(step === 'queue' ? 'Queued in the timelock.' : step === 'execute' ? 'Executed.' : 'Vote cast.');
  } catch (error) {
    console.error('[governance]', error);
    toast(errorFirstLine(error));
  } finally {
    busy = false;
    void renderGovernance();
  }
}

function button(id: string, step: string, label: string, kind = ''): HTMLButtonElement {
  const b = element('button', kind, label);
  b.dataset.id = id;
  b.dataset.step = step;
  return b;
}
