import {
  decodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  toBytes,
  type Abi,
  type Address,
  type Hex,
} from 'viem';

/**
 * Token governance as the client and server see it: proposals made to
 * `LmsGovernor`, and what their actions would do.
 *
 * The governor is stock OpenZeppelin and has no way to list its proposals, so
 * the server indexes `ProposalCreated` and serves the list; every live number
 * (state, tallies, quorum, a voter's power) is read from the chain by the
 * client itself.
 */

export const lmsGovernorAbi = parseAbi([
  'function state(uint256 proposalId) view returns (uint8)',
  'function proposalVotes(uint256 proposalId) view returns (uint256 againstVotes, uint256 forVotes, uint256 abstainVotes)',
  'function hasVoted(uint256 proposalId, address account) view returns (bool)',
  'function getVotes(address account, uint256 timepoint) view returns (uint256)',
  'function proposalSnapshot(uint256 proposalId) view returns (uint256)',
  'function proposalDeadline(uint256 proposalId) view returns (uint256)',
  'function proposalEta(uint256 proposalId) view returns (uint256)',
  'function quorum(uint256 timepoint) view returns (uint256)',
  'function castVote(uint256 proposalId, uint8 support) returns (uint256)',
  'function castVoteWithReason(uint256 proposalId, uint8 support, string reason) returns (uint256)',
  'function propose(address[] targets, uint256[] values, bytes[] calldatas, string description) returns (uint256)',
  'function proposalThreshold() view returns (uint256)',
  'function clock() view returns (uint48)',
  'function timelock() view returns (address)',
  'function votingPeriod() view returns (uint256)',
  'function queue(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) returns (uint256)',
  'function execute(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) payable returns (uint256)',
  'event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 voteStart, uint256 voteEnd, string description)',
  'error GovernorUnexpectedProposalState(uint256 proposalId, uint8 current, bytes32 expectedStates)',
  'error GovernorAlreadyCastVote(address voter)',
  'error GovernorInvalidVoteType()',
  'error GovernorNonexistentProposal(uint256 proposalId)',
  'error GovernorInsufficientProposerVotes(address proposer, uint256 votes, uint256 threshold)',
  'error GovernorInvalidProposalLength(uint256 targets, uint256 calldatas, uint256 values)',
  'error GovernorRestrictedProposer(address proposer)',
  'error TimelockUnexpectedOperationState(bytes32 operationId, bytes32 expectedStates)',
  'error ERC5805FutureLookup(uint256 timepoint, uint48 clock)',
]);

/** The `ProtocolConfig` reads a proposal builder needs, and where the escrow keeps it. */
export const protocolConfigAbi = parseAbi([
  'function config() view returns (address)',
  'function getParams() view returns ((uint16 feeBps, uint16 minSeats, uint16 maxSeats, uint64 joinWindow, uint64 settleWindow, uint128 minStake, uint128 maxStake, address treasury))',
  'function guardian() view returns (address)',
]);

/** The config's parameter set, as `getParams` returns it and `setParams` takes it. */
export interface ProtocolParams {
  feeBps: number;
  minSeats: number;
  maxSeats: number;
  joinWindow: bigint;
  settleWindow: bigint;
  minStake: bigint;
  maxStake: bigint;
  treasury: Address;
}

/** Mirrors OpenZeppelin's `IGovernor.ProposalState`. */
export const ProposalState = {
  Pending: 0,
  Active: 1,
  Canceled: 2,
  Defeated: 3,
  Succeeded: 4,
  Queued: 5,
  Expired: 6,
  Executed: 7,
} as const;

export type ProposalStateValue = (typeof ProposalState)[keyof typeof ProposalState];

export const PROPOSAL_STATE_NAMES: Record<ProposalStateValue, string> = {
  0: 'Pending',
  1: 'Active',
  2: 'Canceled',
  3: 'Defeated',
  4: 'Succeeded',
  5: 'Queued',
  6: 'Expired',
  7: 'Executed',
};

/** `GovernorCountingSimple`'s vote types. */
export const VoteSupport = { Against: 0, For: 1, Abstain: 2 } as const;
export type VoteSupportValue = (typeof VoteSupport)[keyof typeof VoteSupport];

/**
 * One proposal as the server indexed it from `ProposalCreated`. Numbers that
 * can exceed 2^53 travel as decimal strings so they survive JSON.
 */
export interface ProposalSummary {
  id: string;
  proposer: Address;
  targets: Address[];
  values: string[];
  calldatas: Hex[];
  description: string;
  /** Timestamps, on the governor's clock. */
  voteStart: number;
  voteEnd: number;
  /** Block the proposal was made in, for ordering. */
  block: number;
}

/** The hash `queue` and `execute` take in place of the full description. */
export function descriptionHash(description: string): Hex {
  return keccak256(toBytes(description));
}

/**
 * The title and body of a description. By convention (Tally's, among others)
 * the first line is the title, optionally as a markdown heading.
 */
export function splitDescription(description: string): { title: string; body: string } {
  const [first = '', ...rest] = description.trim().split('\n');
  const title = first.replace(/^#+\s*/, '').trim() || 'Untitled proposal';
  return { title, body: rest.join('\n').trim() };
}

/**
 * Every function a proposal is expected to call, across the contracts the
 * timelock owns. Used only to *display* actions; a call that matches none of
 * these is shown raw, never hidden.
 */
export const governableAbi = parseAbi([
  // ProtocolConfig
  'function setParams((uint16 feeBps, uint16 minSeats, uint16 maxSeats, uint64 joinWindow, uint64 settleWindow, uint128 minStake, uint128 maxStake, address treasury) params)',
  'function setRulesHash(bytes32 rulesHash)',
  'function setPayoutSchedule(uint16[] payoutBps)',
  'function setRandomnessOracle(address oracle)',
  'function setAttestor(address attestor, bool allowed)',
  'function setAttestorThreshold(uint32 threshold)',
  'function setGuardian(address guardian)',
  'function setRemoteChain(uint32 chainId, address messenger, bytes32 peer)',
  // GameEscrow
  'function pause()',
  'function unpause()',
  // FeeRouter
  'function setTreasury(address treasury)',
  'function setStakerBps(uint16 stakerBps)',
  // StakedLms
  'function setCooldown(uint64 cooldown)',
  'function sweepStray(address to)',
  // TimelockController
  'function updateDelay(uint256 delay)',
  'function grantRole(bytes32 role, address account)',
  'function revokeRole(bytes32 role, address account)',
  // LmsGovernor (GovernorSettings, GovernorVotesQuorumFraction)
  'function setVotingDelay(uint48 votingDelay)',
  'function setVotingPeriod(uint32 votingPeriod)',
  'function setProposalThreshold(uint256 proposalThreshold)',
  'function updateQuorumNumerator(uint256 quorumNumerator)',
  // Ownable2Step, on any of them
  'function transferOwnership(address owner)',
  'function acceptOwnership()',
  // A token transfer out of the treasury
  'function transfer(address to, uint256 amount)',
]);

/** Named `TimelockController` roles, so a role change reads as what it is. */
const ROLE_NAMES: Record<string, string> = Object.fromEntries(
  [
    ['DEFAULT_ADMIN_ROLE', `0x${'00'.repeat(32)}`],
    ['PROPOSER_ROLE', keccak256(toBytes('PROPOSER_ROLE'))],
    ['EXECUTOR_ROLE', keccak256(toBytes('EXECUTOR_ROLE'))],
    ['CANCELLER_ROLE', keccak256(toBytes('CANCELLER_ROLE'))],
  ].map(([name, hash]) => [hash!, name!]),
);

export interface DescribedCall {
  /** A known contract's name, or the checksummed address. */
  target: string;
  /** `name(arg, arg)`, or the raw selector and data when the call is not recognised. */
  call: string;
  /** ETH sent with the call, in wei. Zero for every expected governance call. */
  value: bigint;
  recognised: boolean;
}

/**
 * What one action of a proposal does, in readable form.
 *
 * `labels` names the addresses the reader already knows (the vault, the
 * escrow, …). Arguments are shown in full, addresses included: a voter has to
 * be able to check exactly where something points.
 */
export function describeCall(
  target: Address,
  value: bigint,
  calldata: Hex,
  labels: Readonly<Record<string, string>> = {},
): DescribedCall {
  const checksummed = getAddress(target);
  const name = labels[checksummed.toLowerCase()] ?? checksummed;
  try {
    const { functionName, args } = decodeFunctionData({ abi: governableAbi as Abi, data: calldata });
    const shown = (args ?? []).map((arg) => formatArg(arg));
    if ((functionName === 'grantRole' || functionName === 'revokeRole') && typeof args?.[0] === 'string') {
      shown[0] = ROLE_NAMES[args[0].toLowerCase()] ?? shown[0]!;
    }
    return { target: name, call: `${functionName}(${shown.join(', ')})`, value, recognised: true };
  } catch {
    const selector = calldata.slice(0, 10);
    const rest = calldata.length > 10 ? ` + ${(calldata.length - 10) / 2} bytes` : '';
    return { target: name, call: calldata === '0x' ? '(plain ETH transfer)' : `${selector}${rest}`, value, recognised: false };
  }
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'bigint') return arg.toString();
  if (Array.isArray(arg)) return `[${arg.map(formatArg).join(', ')}]`;
  if (arg && typeof arg === 'object') {
    return `{ ${Object.entries(arg)
      .map(([key, value]) => `${key}: ${formatArg(value)}`)
      .join(', ')} }`;
  }
  return String(arg);
}
