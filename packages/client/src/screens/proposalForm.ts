import { describeCall } from '@lms/contracts';
import { errorFirstLine } from '@lms/api';
import { app, dom } from '../context.js';
import { toast } from '../ui/chrome.js';
import { element, fillSelect } from '../ui/dom.js';
import {
  ACTION_TEMPLATES,
  buildAction,
  proposalDescription,
  proposalProblem,
  type ProposalAction,
  type ProposalContext,
} from '../ui/proposalBuilder.js';
import { formatLms } from '../ui/staking.js';
import { plainCall } from '../ui/governance.js';
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
  dom.addAction.onclick = () => void addAction();
  dom.submitProposal.onclick = () => void submit();
  dom.proposalTitle.oninput = renderSubmitState;
  // An action typed in but not added yet still counts towards Submit.
  dom.actionFields.oninput = renderSubmitState;
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
    dom.proposerPower.textContent = `You have ${formatLms(result.power)} sLMS · ${formatLms(result.threshold)} needed to propose`;
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
      const label = element('label', '', field.label);
      const input = element('input');
      input.dataset.field = field.name;
      input.placeholder = field.placeholder;
      input.setAttribute('aria-label', field.label);
      label.append(input);
      return label;
    }),
  );
}

function addAction(): boolean {
  if (!context) {
    dom.actionError.textContent = 'Connect a wallet on the hub chain first.';
    return false;
  }
  const result = buildAction(dom.actionTemplate.value, fieldValues(), context);
  if (!result.ok) {
    dom.actionError.textContent = result.error;
    return false;
  }
  const adding = [result.action, ...(result.also ?? [])];
  // The same call twice does nothing the first did not, and voters read it as a mistake.
  if (adding.some((action) => draft.some((other) => sameAction(action, other)))) {
    dom.actionError.textContent = 'That action is already in the proposal.';
    return false;
  }
  draft.push(...adding);
  dom.actionError.textContent = '';
  for (const input of dom.actionFields.querySelectorAll<HTMLInputElement>('input')) input.value = '';
  renderDraft();
  return true;
}

function fieldValues(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const input of dom.actionFields.querySelectorAll<HTMLInputElement>('input[data-field]')) {
    values[input.dataset.field!] = input.value;
  }
  return values;
}

/** Whether the template's fields hold something: an action the proposer means but has not added. */
function pendingFields(): boolean {
  return [...dom.actionFields.querySelectorAll<HTMLInputElement>('input[data-field]')].some((input) => input.value.trim() !== '');
}

function sameAction(a: ProposalAction, b: ProposalAction): boolean {
  return a.target.toLowerCase() === b.target.toLowerCase() && a.value === b.value && a.calldata.toLowerCase() === b.calldata.toLowerCase();
}

function renderDraft(): void {
  const labels = knownContracts();
  dom.draftActions.replaceChildren(
    ...draft.map((action, index) => {
      const described = describeCall(action.target, action.value, action.calldata, labels);
      const item = element('li');
      const code = element('code', '', `${described.target}.${described.call}`);
      const remove = element('button', 'ghost', 'Remove');
      remove.onclick = () => {
        draft.splice(index, 1);
        renderDraft();
      };
      // What voters will read first.
      const plain = plainCall(action.calldata, context?.params ?? null);
      if (plain.text) item.append(element('div', 'proposal-plain', plain.text));
      item.append(code, ' ', remove);
      for (const warning of plain.warnings) item.append(element('div', 'warn', warning));
      if (!described.recognised || action.value > 0n) {
        const warn = element(
          'div',
          'warn',
          [
            described.recognised ? null : 'Voters will see this flagged as an unrecognised call.',
            action.value > 0n ? `Sends ${formatLms(action.value, 6)} ETH from the timelock.` : null,
          ]
            .filter(Boolean)
            .join(' '),
        );
        item.append(warn);
      }
      return item;
    }),
  );
  renderSubmitState();
}

function renderSubmitState(): void {
  // Filled-in fields count as the action they describe: Submit adds it first.
  const pending = draft.length === 0 && pendingFields();
  const problem = proposalProblem(dom.proposalTitle.value, pending ? [PENDING_ACTION] : draft);
  dom.submitProposal.disabled = !canPropose || problem !== null;
  if (canPropose) {
    dom.proposalStatus.textContent = problem ?? (pending ? 'Ready to submit, with the action filled in above.' : 'Ready to submit.');
  }
}

/** Stands in for an action whose fields are filled in but not yet added, for `proposalProblem`. */
const PENDING_ACTION: ProposalAction = { target: '0x0000000000000000000000000000000000000000', value: 0n, calldata: '0x' };

async function submit(): Promise<void> {
  const wallet = app.wallet;
  const governor = app.staking?.governor;
  if (!wallet || !governor) return;
  if (pendingFields() && !addAction()) return;
  if (draft.length === 0) return;

  dom.submitProposal.disabled = true;
  dom.proposalStatus.textContent = 'Submitting…';
  try {
    const hash = await governorCalls.propose(wallet, governor,
      draft,
      proposalDescription(dom.proposalTitle.value, dom.proposalBody.value),
    );
    await wallet.waitFor(hash, 'Propose');
    toast('Proposal created. Voting opens after the voting delay.', 'success');
    closeForm();
    onSubmitted();
  } catch (error) {
    console.error('[governance]', error);
    dom.proposalStatus.textContent = errorFirstLine(error);
    renderSubmitState();
  }
}

/** The config's parameters as the form last read them, for describing what a proposal changes. */
export function currentParams(): ProposalContext['params'] {
  return context?.params ?? null;
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
