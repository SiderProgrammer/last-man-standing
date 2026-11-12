import { decodeFunctionData, formatEther, type Abi, type Hex } from 'viem';
import {
  PROPOSAL_STATE_NAMES,
  ProposalState,
  describeCall,
  governableAbi,
  splitDescription,
  type ProposalStateValue,
  type ProposalSummary,
  type ProtocolParams,
} from '@lms/contracts';
import { short } from './format.js';
import { formatDuration, formatLms } from './staking.js';

/**
 * Pure builders for the governance screen: what one proposal card shows, from
 * the indexed proposal and what the chain says about it now. The applier in
 * `screens/governance.ts` reads the chain and builds the DOM.
 */

/** A proposal's live state, as read from `LmsGovernor` for one voter. */
export interface ProposalLive {
  state: ProposalStateValue;
  votes: { for: bigint; against: bigint; abstain: bigint };
  /** Votes needed, fixed at the snapshot. Null while the snapshot is still ahead. */
  quorum: bigint | null;
  /**
   * The voter's power at the snapshot — or, while the proposal is still
   * pending, their power now, which is what it will be if nothing changes.
   */
  power: bigint;
  hasVoted: boolean;
  /** When a queued proposal may execute; zero otherwise. */
  eta: number;
  /** The latest block's timestamp: the clock the governor runs on. */
  chainTime: number;
  /** How this wallet voted, once it has and the vote could be read: 0 against, 1 for, 2 abstain. */
  vote?: { support: number; reason: string } | null;
}

/** One step of a proposal's life, as the card's stepper shows it. */
export interface LifecycleStep {
  label: string;
  /** When it happened or happens, by the chain's clock, or null when there is no date to give. */
  when: string | null;
  state: 'done' | 'current' | 'todo' | 'failed';
}

export type Tone = 'live' | 'good' | 'bad' | 'neutral';

export interface ProposalCard {
  id: string;
  title: string;
  body: string;
  byline: string;
  state: { label: string; tone: Tone };
  /** What happens next and how long until it does. */
  window: string;
  /** When voting opens and closes, as dates. */
  timeline: string;
  /**
   * A vote that has not opened yet, as the label of the vote button it will
   * become; null otherwise. Shown disabled, so the vote has a visible place.
   */
  voteOpens: string | null;
  actions: Array<{ target: string; call: string; warning: string | null; plain: string | null }>;
  /** Pending, voting, passed, queued, executed: where this proposal is. */
  steps: LifecycleStep[];
  tally: {
    for: string;
    against: string;
    abstain: string;
    /** Shares of the votes cast, in percent, for drawing the bar. */
    shares: { for: number; against: number; abstain: number };
  } | null;
  quorum: string;
  you: string;
  canVote: boolean;
  canQueue: boolean;
  canExecute: boolean;
}

const TONES: Record<ProposalStateValue, Tone> = {
  [ProposalState.Pending]: 'neutral',
  [ProposalState.Active]: 'live',
  [ProposalState.Canceled]: 'bad',
  [ProposalState.Defeated]: 'bad',
  [ProposalState.Succeeded]: 'good',
  [ProposalState.Queued]: 'good',
  [ProposalState.Expired]: 'bad',
  [ProposalState.Executed]: 'neutral',
};

/** Why there are no live results to show, and the clock to time the vote by instead. */
export interface ProposalOffline {
  /** Unix seconds: the browser's clock, the best there is without a read. */
  now: number;
  /** What the player can do about it, in place of their own part in the vote. */
  reason: string;
}

const NO_WALLET = 'Connect a wallet to see the result and vote.';

export function proposalCard(
  summary: ProposalSummary,
  live: ProposalLive | null,
  labels: Readonly<Record<string, string>>,
  offline: ProposalOffline | null = null,
  /** The config's parameters now, to say what a `setParams` changes. */
  current: ProtocolParams | null = null,
): ProposalCard {
  const { title, body } = splitDescription(summary.description);
  const calldatas = summary.calldatas.map((data) => (data ?? '0x').toLowerCase());
  const actions = summary.targets.map((target, i) => {
    const calldata = summary.calldatas[i] ?? '0x';
    const call = describeCall(target, BigInt(summary.values[i] ?? '0'), calldata, labels);
    const plain = plainCall(calldata, current);
    const warnings = [
      call.recognised ? null : 'Not a recognised governance call — check the target and data yourself.',
      call.value > 0n ? `Sends ${formatLms(call.value, 6)} ETH.` : null,
      calldatas.indexOf(calldata.toLowerCase()) !== i ? 'The same call again: it does nothing the first did not.' : null,
      ...plain.warnings,
    ].filter((warning): warning is string => warning !== null);
    return { target: call.target, call: call.call, warning: warnings.length ? warnings.join(' ') : null, plain: plain.text };
  });

  const base = {
    id: summary.id,
    title,
    body,
    byline: `${short(proposalIdHex(summary.id))} · proposed by ${short(summary.proposer)}`,
    timeline: `Voting ${formatWhen(summary.voteStart)} → ${formatWhen(summary.voteEnd)}`,
    actions,
    steps: lifecycle(summary, live),
  };

  if (!live) {
    return {
      ...base,
      state: { label: '—', tone: 'neutral' },
      window: offline ? clockWindow(summary, offline.now) : '',
      voteOpens: null,
      tally: null,
      quorum: '',
      you: offline?.reason ?? NO_WALLET,
      canVote: false,
      canQueue: false,
      canExecute: false,
    };
  }

  const cast = live.votes.for + live.votes.against + live.votes.abstain;
  const share = (part: bigint) => (cast === 0n ? 0 : Number((part * 10_000n) / cast) / 100);
  const counted = live.votes.for + live.votes.abstain;

  return {
    ...base,
    state: { label: PROPOSAL_STATE_NAMES[live.state], tone: TONES[live.state] },
    window: windowText(summary, live),
    voteOpens:
      live.state === ProposalState.Pending && !live.hasVoted
        ? `Voting opens in ${formatDuration(Math.max(0, summary.voteStart - live.chainTime))}`
        : null,
    tally: {
      for: formatLms(live.votes.for),
      against: formatLms(live.votes.against),
      abstain: formatLms(live.votes.abstain),
      shares: { for: share(live.votes.for), against: share(live.votes.against), abstain: share(live.votes.abstain) },
    },
    // `GovernorCountingSimple` counts For and Abstain towards quorum, never Against.
    quorum:
      live.quorum === null
        ? 'Quorum is fixed when voting opens.'
        : live.quorum === 0n
          ? 'No quorum required.'
          : `Quorum: ${formatLms(counted)} of ${formatLms(live.quorum)} sLMS (${Math.min(
              100,
              Number((counted * 100n) / live.quorum),
            )}%), counting For and Abstain.`,
    you: youText(live),
    canVote: live.state === ProposalState.Active && !live.hasVoted && live.power > 0n,
    canQueue: live.state === ProposalState.Succeeded,
    canExecute: live.state === ProposalState.Queued && live.chainTime >= live.eta,
  };
}

function windowText(summary: ProposalSummary, live: ProposalLive): string {
  const now = live.chainTime;
  switch (live.state) {
    case ProposalState.Pending:
      return `Voting opens in ${formatDuration(summary.voteStart - now)}.`;
    case ProposalState.Active:
      return `Voting closes in ${formatDuration(summary.voteEnd - now)}.`;
    case ProposalState.Succeeded:
      return 'Passed. Queue it to start the timelock delay.';
    case ProposalState.Queued:
      return now >= live.eta
        ? 'The timelock delay is over: anyone can execute it.'
        : `In the timelock: executable in ${formatDuration(live.eta - now)}. The Safe can still veto it.`;
    case ProposalState.Defeated: {
      // `GovernorCountingSimple`: quorum counts For and Abstain; passing needs For over Against.
      const counted = live.votes.for + live.votes.abstain;
      const noQuorum = live.quorum !== null && counted < live.quorum;
      const outvoted = live.votes.for <= live.votes.against;
      if (noQuorum && outvoted) return 'Did not pass: quorum was not reached, and no more voted for than against.';
      if (noQuorum) return `Did not pass: quorum was not reached (${formatLms(counted)} of ${formatLms(live.quorum!)} sLMS).`;
      return 'Did not pass: no more voted for than against.';
    }
    case ProposalState.Canceled:
      return 'Canceled.';
    case ProposalState.Expired:
      return 'Expired before it was executed.';
    case ProposalState.Executed:
      return 'Executed.';
  }
}

/**
 * The vote's window by a clock alone, for a proposal whose state could not be
 * read: it cannot say whether it passed, only whether voting is open.
 */
function clockWindow(summary: ProposalSummary, now: number): string {
  if (now < summary.voteStart) return `Voting opens in ${formatDuration(summary.voteStart - now)}.`;
  if (now < summary.voteEnd) return `Voting closes in ${formatDuration(summary.voteEnd - now)}.`;
  return 'Voting has closed.';
}

/**
 * A proposal id as the CLI and block explorers show it: hex. The governor
 * hands it over as a decimal uint256.
 */
export function proposalIdHex(id: string): string {
  try {
    return `0x${BigInt(id).toString(16)}`;
  } catch {
    return id;
  }
}

/**
 * A vote boundary as a local date and time: "12 Nov, 14:00". In English
 * whatever the browser's locale, as the rest of the page is.
 */
function formatWhen(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString('en-GB', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const SIDES = ['Against', 'For', 'Abstain'];

function youText(live: ProposalLive): string {
  if (live.hasVoted) {
    const side = live.vote ? SIDES[live.vote.support] : undefined;
    if (!side) return 'You voted on this proposal.';
    const verb = side === 'Abstain' ? 'You abstained' : `You voted ${side}`;
    return live.vote?.reason ? `${verb}: “${live.vote.reason}”` : `${verb}.`;
  }
  if (live.state === ProposalState.Pending) {
    return live.power > 0n
      ? `You will vote with the ${formatLms(live.power)} sLMS you hold when voting opens.`
      : 'Stake LMS before voting opens to vote on this.';
  }
  if (live.power === 0n) return 'You had no staked LMS when voting opened, so you cannot vote on this.';
  return live.state === ProposalState.Active
    ? `Your voting power: ${formatLms(live.power)} sLMS.`
    : `You had ${formatLms(live.power)} sLMS of voting power and did not vote.`;
}

// ------------------------------------------------------------- lifecycle

/**
 * Pending, voting, passed, queued, executed: the current step lit, with the
 * chain-time dates of the steps that have one. A proposal that stopped
 * (defeated, canceled, expired) shows where.
 */
export function lifecycle(summary: ProposalSummary, live: ProposalLive | null): LifecycleStep[] {
  const steps: LifecycleStep[] = [
    { label: 'Pending', when: null, state: 'todo' },
    { label: 'Voting', when: `${formatWhen(summary.voteStart)} → ${formatWhen(summary.voteEnd)}`, state: 'todo' },
    { label: 'Passed', when: null, state: 'todo' },
    { label: 'Queued', when: live && live.eta > 0 ? `executable ${formatWhen(live.eta)}` : null, state: 'todo' },
    { label: 'Executed', when: null, state: 'todo' },
  ];
  if (!live) return steps;
  const reached: Partial<Record<ProposalStateValue, number>> = {
    [ProposalState.Pending]: 0,
    [ProposalState.Active]: 1,
    [ProposalState.Succeeded]: 2,
    [ProposalState.Queued]: 3,
    [ProposalState.Executed]: 4,
  };
  const at = reached[live.state];
  if (at !== undefined) {
    steps.forEach((step, i) => (step.state = i < at || at === 4 ? 'done' : i === at ? 'current' : 'todo'));
    return steps;
  }
  // Stopped: the step where it stopped is marked, under the state's own name.
  const stoppedAt =
    live.state === ProposalState.Defeated ? 2 : live.state === ProposalState.Expired ? 4 : live.chainTime < summary.voteStart ? 0 : 1;
  steps.forEach((step, i) => (step.state = i < stoppedAt ? 'done' : i === stoppedAt ? 'failed' : 'todo'));
  steps[stoppedAt]!.label = PROPOSAL_STATE_NAMES[live.state];
  return steps;
}

// ------------------------------------------------------- plain language

/**
 * What a governance call does, in words a voter reads at a glance, and any
 * risk in it: "Set the protocol fee to 2.5%". A `setParams` is described by
 * what it changes against the config now, since it rewrites every field.
 * Null text for a call this does not know.
 */
export function plainCall(calldata: string, current: ProtocolParams | null): { text: string | null; warnings: string[] } {
  let decoded: { functionName: string; args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: governableAbi as Abi, data: calldata as Hex }) as typeof decoded;
  } catch {
    return { text: null, warnings: [] };
  }
  const args = decoded.args ?? [];
  const percent = (bps: unknown) => `${Number(bps) / 100}%`;
  const days = (seconds: unknown) => `${Number(seconds) / 86_400} days`;
  const zero = (address: unknown) => /^0x0{40}$/i.test(String(address));
  switch (decoded.functionName) {
    case 'setStakerBps':
      return { text: `Give stakers ${percent(args[0])} of every match fee`, warnings: [] };
    case 'setTreasury':
      return { text: `Send the protocol's share of fees to ${short(String(args[0]))}`, warnings: [] };
    case 'setGuardian':
      return zero(args[0])
        ? { text: 'Remove the emergency guardian', warnings: ['This switches the guardian off: nobody can pause the game or veto a result.'] }
        : { text: `Make ${short(String(args[0]))} the emergency guardian`, warnings: [] };
    case 'setCooldown':
      return { text: `Make unstaking take ${days(args[0])}`, warnings: [] };
    case 'setVotingPeriod':
      return { text: `Make votes last ${days(args[0])}`, warnings: [] };
    case 'unpause':
      return { text: 'Resume play after a pause', warnings: [] };
    case 'setBridgeReceiver':
      return {
        text: zero(args[0]) ? 'Turn off staking from other chains' : `Take stakes from other chains through ${short(String(args[0]))}`,
        warnings: [],
      };
    case 'revokeRole':
      return { text: `Take away ${short(String(args[1]))}'s power to veto queued proposals`, warnings: [] };
    case 'setParams':
      return describeParams(args[0] as ProtocolParams, current);
    default:
      return { text: null, warnings: [] };
  }
}

function describeParams(next: ProtocolParams, current: ProtocolParams | null): { text: string; warnings: string[] } {
  const field: Record<keyof ProtocolParams, (p: ProtocolParams) => string> = {
    feeBps: (p) => `the protocol fee to ${p.feeBps / 100}%`,
    minSeats: (p) => `the smallest table to ${p.minSeats} seats`,
    maxSeats: (p) => `the largest table to ${p.maxSeats} seats`,
    joinWindow: (p) => `the join window to ${Number(p.joinWindow) / 60} minutes`,
    settleWindow: (p) => `the settle window to ${Number(p.settleWindow) / 60} minutes`,
    minStake: (p) => `the smallest stake to ${formatEther(p.minStake)} ETH`,
    maxStake: (p) => `the largest stake to ${formatEther(p.maxStake)} ETH`,
    treasury: (p) => `the treasury to ${short(p.treasury)}`,
  };
  const keys = Object.keys(field) as Array<keyof ProtocolParams>;
  if (!current) {
    return {
      text: `Set ${keys.map((key) => field[key](next)).join(', ')}`,
      warnings: ['Rewrites every parameter at once: check none undoes another change.'],
    };
  }
  const changed = keys.filter((key) => String(next[key]).toLowerCase() !== String(current[key]).toLowerCase());
  if (changed.length === 0) return { text: 'Change nothing: every parameter stays as it is now', warnings: [] };
  return {
    text: `Set ${changed.map((key) => field[key](next)).join(', ')}`,
    warnings: ['Also writes every other parameter back to its value when this was proposed.'],
  };
}
