import { describeCall, errorFirstLine } from '@lms/protocol';
import { app, dom } from '../context.js';
import { toast } from '../ui/chrome.js';
import { fillSelect } from '../ui/dom.js';
import {
  ACTION_TEMPLATES,
  buildAction,
  proposalDescription,
  proposalProblem,
  type ProposalAction,
  type ProposalContext,
} from '../ui/proposalBuilder.js';
import { formatLms } from '../ui/staking.js';
import * as governorCalls from '../wallet/governance.js';

/**
 * The "New proposal" form on the governance screen.
 *
 * Actions are added one at a time from templates and previewed with the same
 * decoder the proposal cards use, so the proposer sees exactly what voters
 * will. Submitting simulates first; the governor's own error explains a
 * missing threshold or a malformed proposal.
 */

let context: ProposalContext | null = null;
let draft: ProposalAction[] = [];
let canPropose = false;
let onSubmitted: () => void = () => {};

export function wireProposalForm(afterSubmit: () => void): void {
  onSubmitted = afterSubmit;
  fillSelect(
    dom.actionTemplate,
    ACTION_TEMPLATES.map((template) => [template.id, template.label]),
  );
  dom.actionTemplate.onchange = renderTemplateFields;
  dom.newProposal.onclick = () => void openForm();
  dom.cancelProposal.onclick = closeForm;
  dom.addAction.onclick = addAction;
  dom.submitProposal.onclick = () => void submit();
  dom.proposalTitle.oninput = renderSubmitState;
  renderTemplateFields();
}

/** The entry point needs a wallet: proposing is a transaction. */
export function renderNewProposalButton(): void {
  dom.newProposal.classList.toggle('hidden', !app.wallet || !app.staking?.governor);
}

/**
 * Reads where each governed contract is, and this wallet's power against the
 * threshold. Cached until the next call; the proposal cards use it for labels.
 */
export async function loadProposalContext(): Promise<{ power: bigint; threshold: bigint } | null> {
  const wallet = app.wallet;
  const staking = app.staking;
  if (!wallet || !staking?.governor) return null;
  const result = await governorCalls.proposalContext(wallet, staking.governor, {
    vault: staking.vault,
    feeRouter: staking.feeRouter,
    escrow: app.escrow,
  });
  context = result.context;
  return result;
}

async function openForm(): Promise<void> {
  dom.proposalForm.classList.remove('hidden');
  dom.proposerPower.textContent = 'Checking your voting power…';
  try {
    const result = await loadProposalContext();
    if (!result) throw new Error('Connect a wallet first.');
    canPropose = result.power >= result.threshold;
    dom.proposerPower.textContent = `${formatLms(result.power)} of ${formatLms(result.threshold)} sLMS needed`;
    dom.proposerPower.classList.toggle('warn-text', !canPropose);
    dom.proposalStatus.textContent = canPropose
      ? ''
      : `Proposing takes ${formatLms(result.threshold)} sLMS of voting power, held at least a second before you submit.`;
  } catch (error) {
    context = null;
    canPropose = false;
    dom.proposerPower.textContent = '—';
    dom.proposalStatus.textContent = `Could not read the governor: ${errorFirstLine(error)}`;
  }
  renderDraft();
}

function closeForm(): void {
  dom.proposalForm.classList.add('hidden');
  draft = [];
  dom.proposalTitle.value = '';
  dom.proposalBody.value = '';
  dom.actionError.textContent = '';
  renderDraft();
}

function renderTemplateFields(): void {
  const template = ACTION_TEMPLATES.find((t) => t.id === dom.actionTemplate.value) ?? ACTION_TEMPLATES[0]!;
  dom.actionHelp.textContent = template.help;
  dom.actionError.textContent = '';
  dom.actionFields.replaceChildren(
    ...template.fields.map((field) => {
      const label = document.createElement('label');
      label.textContent = field.label;
      const input = document.createElement('input');
      input.dataset.field = field.name;
      input.placeholder = field.placeholder;
      input.setAttribute('aria-label', field.label);
      label.append(input);
      return label;
    }),
  );
}

function addAction(): void {
  if (!context) {
    dom.actionError.textContent = 'Connect a wallet on the hub chain first.';
    return;
  }
  const values: Record<string, string> = {};
  for (const input of dom.actionFields.querySelectorAll<HTMLInputElement>('input[data-field]')) {
    values[input.dataset.field!] = input.value;
  }
  const result = buildAction(dom.actionTemplate.value, values, context);
  if (!result.ok) {
    dom.actionError.textContent = result.error;
    return;
  }
  draft.push(result.action, ...(result.also ?? []));
  dom.actionError.textContent = '';
  for (const input of dom.actionFields.querySelectorAll<HTMLInputElement>('input')) input.value = '';
  renderDraft();
}

function renderDraft(): void {
  const labels = knownContracts();
  dom.draftActions.replaceChildren(
    ...draft.map((action, index) => {
      const described = describeCall(action.target, action.value, action.calldata, labels);
      const item = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = `${described.target}.${described.call}`;
      const remove = document.createElement('button');
      remove.className = 'ghost';
      remove.textContent = 'Remove';
      remove.onclick = () => {
        draft.splice(index, 1);
        renderDraft();
      };
      item.append(code, ' ', remove);
      if (!described.recognised || action.value > 0n) {
        const warn = document.createElement('div');
        warn.className = 'warn';
        warn.textContent = [
          described.recognised ? null : 'Voters will see this flagged as an unrecognised call.',
          action.value > 0n ? `Sends ${formatLms(action.value, 6)} ETH from the timelock.` : null,
        ]
          .filter(Boolean)
          .join(' ');
        item.append(warn);
      }
      return item;
    }),
  );
  renderSubmitState();
}

function renderSubmitState(): void {
  const problem = proposalProblem(dom.proposalTitle.value, draft);
  dom.submitProposal.disabled = !canPropose || problem !== null;
  if (canPropose) dom.proposalStatus.textContent = problem ?? 'Ready to submit.';
}

async function submit(): Promise<void> {
  const wallet = app.wallet;
  const governor = app.staking?.governor;
  if (!wallet || !governor || draft.length === 0) return;

  dom.submitProposal.disabled = true;
  dom.proposalStatus.textContent = 'Submitting…';
  try {
    const hash = await governorCalls.propose(wallet, governor,
      draft,
      proposalDescription(dom.proposalTitle.value, dom.proposalBody.value),
    );
    await wallet.waitFor(hash);
    toast('Proposal created. Voting opens after the voting delay.');
    closeForm();
    onSubmitted();
  } catch (error) {
    console.error('[governance]', error);
    dom.proposalStatus.textContent = errorFirstLine(error);
    renderSubmitState();
  }
}

/**
 * Names for every governed contract this deployment has, for labelling
 * actions. Includes the config and timelock once the form has read them.
 */
export function knownContracts(): Record<string, string> {
  const labels: Record<string, string> = {};
  const name = (address: string | null | undefined, label: string) => {
    if (address) labels[address.toLowerCase()] = label;
  };
  name(app.staking?.vault, 'StakedLms');
  name(app.staking?.governor, 'LmsGovernor');
  name(app.staking?.feeRouter, 'FeeRouter');
  name(app.staking?.rewards, 'RewardsDistributor');
  name(app.escrow, 'GameEscrow');
  name(context?.config, 'ProtocolConfig');
  name(context?.timelock, 'Timelock');
  return labels;
}
