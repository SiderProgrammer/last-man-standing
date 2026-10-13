import { encodeFunctionData, isAddress, isHex, keccak256, parseEther, toBytes, type Address, type Hex } from 'viem';
import { governableAbi, type ProtocolParams } from '@lms/protocol';

/**
 * Builds proposal actions from plain inputs.
 *
 * Writing calldata by hand is how proposals go wrong: a fee of 50 instead of
 * 5,000 basis points, an address pasted into the wrong slot. Each template
 * here takes the values a person thinks in — a percentage, a number of days,
 * an address — checks them against the same limits the contracts enforce,
 * and encodes the one call that does it. The custom template is the escape
 * hatch, and the screen flags whatever it produces.
 */

/** The contracts a template may target, as this deployment has them. */
export interface ProposalContext {
  governor: Address;
  timelock: Address;
  vault: Address;
  feeRouter: Address | null;
  escrow: Address | null;
  config: Address | null;
  /** The config's current parameters, which `setParams` must resend in full. */
  params: ProtocolParams | null;
}

export interface TemplateField {
  name: string;
  label: string;
  placeholder: string;
}

export interface ActionTemplate {
  id: string;
  label: string;
  /** Shown under the form: what the action does, and anything to watch for. */
  help: string;
  fields: TemplateField[];
}

export interface ProposalAction {
  target: Address;
  value: bigint;
  calldata: Hex;
}

export type BuildResult = { ok: true; action: ProposalAction } | { ok: false; error: string };

/** `ProtocolConfig.MAX_FEE_BPS`: the contract refuses anything higher. */
const MAX_FEE_BPS = 1_000;
/** `StakedLms.MIN_COOLDOWN` and `MAX_COOLDOWN`, in days. */
const COOLDOWN_DAYS = { min: 1, max: 30 };
const DAY = 86_400;
const CANCELLER_ROLE = keccak256(toBytes('CANCELLER_ROLE'));

const address = (name: string, label: string): TemplateField => ({ name, label, placeholder: '0x…' });

export const ACTION_TEMPLATES: ActionTemplate[] = [
  {
    id: 'stakerShare',
    label: "Stakers' share of fees",
    help: 'The part of every match fee paid to stakers in ETH. The rest goes to the treasury.',
    fields: [{ name: 'percent', label: 'Share to stakers (%)', placeholder: '50' }],
  },
  {
    id: 'protocolFee',
    label: 'Protocol fee per match',
    help:
      'The cut of each prize pool, at most 10%. Matches already open keep the fee they started with. ' +
      'This resends every other parameter as it is now, so it would undo any other parameter change ' +
      'that executes first.',
    fields: [{ name: 'percent', label: 'Fee (%)', placeholder: '5' }],
  },
  {
    id: 'treasury',
    label: 'Treasury address',
    help: "Where the non-stakers' share of fees goes.",
    fields: [address('to', 'New treasury')],
  },
  {
    id: 'guardian',
    label: 'Emergency guardian',
    help: 'The address that can pause play at once, without waiting for a vote.',
    fields: [address('to', 'New guardian')],
  },
  {
    id: 'cooldown',
    label: 'Unstake cooldown',
    help:
      'How long unstaking takes, 1 to 30 days. Keep it longer than the voting period plus the ' +
      'timelock delay, or voters could leave before their proposal executes.',
    fields: [{ name: 'days', label: 'Cooldown (days)', placeholder: '7' }],
  },
  {
    id: 'votingPeriod',
    label: 'Voting period',
    help: 'How long each vote stays open. Keep it shorter than the unstake cooldown minus the timelock delay.',
    fields: [{ name: 'days', label: 'Voting period (days)', placeholder: '5' }],
  },
  {
    id: 'unpause',
    label: 'Resume play',
    help: 'Lifts a pause the guardian put in place. Only governance can do this.',
    fields: [],
  },
  {
    id: 'removeVeto',
    label: "Remove the multisig's veto",
    help:
      'Takes the canceller role away from an address, so it can no longer cancel passed proposals ' +
      'during the timelock delay. This is how governance ends the training-wheels period.',
    fields: [address('account', 'Address to remove (the Safe)')],
  },
  {
    id: 'custom',
    label: 'Custom call (advanced)',
    help: 'Any call at all. Voters will see it flagged if it is not a recognised governance call.',
    fields: [
      address('target', 'Target contract'),
      { name: 'calldata', label: 'Calldata', placeholder: '0x…' },
      { name: 'eth', label: 'ETH to send', placeholder: '0' },
    ],
  },
];

/** Builds one action from a template and its field values, or says what is wrong. */
export function buildAction(templateId: string, values: Record<string, string>, context: ProposalContext): BuildResult {
  const field = (name: string) => (values[name] ?? '').trim();
  const call = (target: Address | null, missing: string, data: Hex): BuildResult =>
    target ? { ok: true, action: { target, value: 0n, calldata: data } } : { ok: false, error: missing };

  switch (templateId) {
    case 'stakerShare': {
      const bps = percentToBps(field('percent'), 10_000);
      if (typeof bps === 'string') return { ok: false, error: bps };
      return call(context.feeRouter, 'This deployment has no fee router.', encode('setStakerBps', [bps]));
    }
    case 'protocolFee': {
      const bps = percentToBps(field('percent'), MAX_FEE_BPS);
      if (typeof bps === 'string') return { ok: false, error: bps };
      if (!context.params) return { ok: false, error: 'Could not read the current parameters.' };
      return call(
        context.config,
        'Could not find the protocol config.',
        encode('setParams', [{ ...context.params, feeBps: bps }]),
      );
    }
    case 'treasury':
    case 'guardian': {
      const to = field('to');
      if (!isAddress(to)) return { ok: false, error: 'Enter a valid address.' };
      return templateId === 'treasury'
        ? call(context.feeRouter, 'This deployment has no fee router.', encode('setTreasury', [to]))
        : call(context.config, 'Could not find the protocol config.', encode('setGuardian', [to]));
    }
    case 'cooldown': {
      const days = wholeDays(field('days'), COOLDOWN_DAYS.min, COOLDOWN_DAYS.max);
      if (typeof days === 'string') return { ok: false, error: days };
      return call(context.vault, 'No staking vault.', encode('setCooldown', [BigInt(days * DAY)]));
    }
    case 'votingPeriod': {
      const days = wholeDays(field('days'), 1, 30);
      if (typeof days === 'string') return { ok: false, error: days };
      return call(context.governor, 'No governor.', encode('setVotingPeriod', [days * DAY]));
    }
    case 'unpause':
      return call(context.escrow, 'This deployment has no escrow.', encode('unpause', []));
    case 'removeVeto': {
      const account = field('account');
      if (!isAddress(account)) return { ok: false, error: 'Enter a valid address.' };
      return call(context.timelock, 'No timelock.', encode('revokeRole', [CANCELLER_ROLE, account]));
    }
    case 'custom': {
      const target = field('target');
      const calldata = field('calldata') || '0x';
      if (!isAddress(target)) return { ok: false, error: 'Enter a valid target address.' };
      if (!isHex(calldata) || calldata.length % 2 !== 0) return { ok: false, error: 'Calldata must be 0x-prefixed hex.' };
      let value: bigint;
      try {
        value = parseEther(field('eth') || '0');
      } catch {
        return { ok: false, error: 'Enter the ETH amount as a number.' };
      }
      if (value < 0n) return { ok: false, error: 'ETH cannot be negative.' };
      return { ok: true, action: { target, value, calldata } };
    }
    default:
      return { ok: false, error: 'Choose an action.' };
  }
}

/** The description the governor stores: the title as a heading, then the body. */
export function proposalDescription(title: string, body: string): string {
  const heading = `# ${title.trim()}`;
  return body.trim() ? `${heading}\n\n${body.trim()}` : heading;
}

/** Whether a proposal is ready to submit, or what is missing. */
export function proposalProblem(title: string, actions: readonly ProposalAction[]): string | null {
  if (!title.trim()) return 'Give the proposal a title.';
  if (actions.length === 0) return 'Add at least one action.';
  if (title.includes('\n') || title.includes('\r')) return 'Keep the title to one line.';
  return null;
}

function encode(functionName: string, args: readonly unknown[]): Hex {
  return encodeFunctionData({ abi: governableAbi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
}

/** A percentage with up to two decimals, as basis points no higher than `maxBps`. */
function percentToBps(text: string, maxBps: number): number | string {
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return 'Enter a percentage, with at most two decimals.';
  const bps = Math.round(Number(text) * 100);
  if (bps > maxBps) return `At most ${maxBps / 100}%.`;
  return bps;
}

function wholeDays(text: string, min: number, max: number): number | string {
  if (!/^\d+$/.test(text)) return 'Enter a whole number of days.';
  const days = Number(text);
  if (days < min || days > max) return `Between ${min} and ${max} days.`;
  return days;
}
