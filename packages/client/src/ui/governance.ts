import {
  PROPOSAL_STATE_NAMES,
  ProposalState,
  describeCall,
  splitDescription,
  type ProposalStateValue,
  type ProposalSummary,
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
  actions: Array<{ target: string; call: string; warning: string | null }>;
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
): ProposalCard {
  const { title, body } = splitDescription(summary.description);
  const actions = summary.targets.map((target, i) => {
    const call = describeCall(target, BigInt(summary.values[i] ?? '0'), summary.calldatas[i] ?? '0x', labels);
    const warnings = [
      call.recognised ? null : 'Not a recognised governance call — check the target and data yourself.',
      call.value > 0n ? `Sends ${formatLms(call.value, 6)} ETH.` : null,
    ].filter((warning): warning is string => warning !== null);
    return { target: call.target, call: call.call, warning: warnings.length ? warnings.join(' ') : null };
  });

  const base = {
    id: summary.id,
    title,
    body,
    byline: `${short(proposalIdHex(summary.id))} · proposed by ${short(summary.proposer)}`,
    timeline: `Voting ${formatWhen(summary.voteStart)} → ${formatWhen(summary.voteEnd)}`,
    actions,
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

function youText(live: ProposalLive): string {
  if (live.hasVoted) return 'You voted on this proposal.';
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
