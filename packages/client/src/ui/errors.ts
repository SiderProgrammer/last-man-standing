import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, decodeErrorResult, formatEther, type Hex } from 'viem';
import { contractErrorsAbi } from '@lms/contracts';
import { errorFirstLine } from '@lms/api';

/**
 * What went wrong, in words a player can act on.
 *
 * A wallet or viem error carries a paragraph of detail, and a revert reads
 * "The contract function joinWithToken reverted" or "custom error 0x2def1a76"
 * when the ABI the call was made with does not name the error: a session
 * key's `InvalidSession` from the delegate, a token's balance check under a
 * permit. Every custom error our contracts have is decoded here, whichever
 * contract it came from, and the common ones are said plainly.
 */
export function explainError(error: unknown): string {
  if (error instanceof BaseError) {
    if (error.walk((cause) => cause instanceof UserRejectedRequestError)) return 'You cancelled it in your wallet.';
    const revert = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const decoded = revertOf(revert);
      if (decoded) return say(decoded.name, decoded.args);
      if (revert.reason) return `The transaction would fail: ${revert.reason}.`;
    }
    // Raw revert data anywhere in the chain, as a node reports an estimate that failed.
    const data = revertData(error);
    if (data) {
      const decoded = decode(data);
      if (decoded) return say(decoded.name, decoded.args);
    }
    if (/insufficient funds/i.test(error.message)) return 'Not enough ETH in your wallet for this and its gas.';
    if (error.shortMessage) return error.shortMessage.split('\n')[0] ?? error.shortMessage;
  }
  return errorFirstLine(error);
}

type Decoded = { name: string; args: readonly unknown[] };

function revertOf(revert: ContractFunctionRevertedError): Decoded | null {
  if (revert.data?.errorName && revert.data.errorName !== 'Error' && revert.data.errorName !== 'Panic') {
    return { name: revert.data.errorName, args: revert.data.args ?? [] };
  }
  // The call's own ABI did not know it: try every error we have.
  const raw = (revert as { raw?: Hex }).raw;
  return raw ? decode(raw) : null;
}

function decode(data: Hex): Decoded | null {
  try {
    const { errorName, args } = decodeErrorResult({ abi: contractErrorsAbi, data });
    return { name: errorName, args: (args ?? []) as readonly unknown[] };
  } catch {
    return null;
  }
}

/** Revert data some node error in the chain carries, as hex. */
function revertData(error: BaseError): Hex | null {
  let found: Hex | null = null;
  error.walk((cause) => {
    const data = (cause as { data?: unknown } | null)?.data;
    if (typeof data === 'string' && /^0x[0-9a-fA-F]{8}/.test(data)) found = data as Hex;
    else if (data && typeof data === 'object' && typeof (data as { data?: unknown }).data === 'string') {
      const inner = (data as { data: string }).data;
      if (/^0x[0-9a-fA-F]{8}/.test(inner)) found = inner as Hex;
    }
    return false;
  });
  return found;
}

const lms = (wei: unknown) => (typeof wei === 'bigint' ? `${Number(formatEther(wei)).toLocaleString('en-GB', { maximumFractionDigits: 2 })} LMS` : 'LMS');

/** The plain-words version of each error a player can run into. Anything else is named. */
const MESSAGES: Record<string, (args: readonly unknown[]) => string> = {
  // Lobbies
  LobbyFull: () => 'That lobby filled up before your stake landed.',
  JoinWindowClosed: () => 'That lobby has stopped taking seats: its join window closed.',
  MatchNotOpen: () => 'That lobby is no longer taking seats.',
  AlreadyJoined: () => 'You already have a seat in that lobby.',
  NotRostered: () => 'Only the players the queue matched can take a seat at that table.',
  IncorrectStake: () => 'The stake sent does not match the lobby’s stake.',
  StakeOutOfRange: () => 'That stake is outside the range lobbies allow.',
  SeatsOutOfRange: () => 'That table size is not allowed.',
  UnknownMatch: () => 'That lobby does not exist on-chain.',
  CannotCancelYet: () => 'That lobby cannot be cancelled yet: it can still start.',
  NotEnoughPlayers: () => 'Not enough players have joined yet.',
  LobbyNotReady: () => 'That lobby is not ready to start yet.',
  WrongStatus: () => 'The match has moved on since this page last looked. Refresh and try again.',
  EnforcedPause: () => 'Staked play is paused by the guardian right now. Collecting winnings still works.',
  GovernancePause: () => 'Staked play is paused by governance right now. Collecting winnings still works.',
  SequencerDown: () => 'The network’s sequencer is down: try again once it is back.',
  SequencerGracePeriod: () => 'The network’s sequencer has just come back: try again in a few minutes.',
  // Results and money
  ChallengeWindowOpen: () => 'The challenge window is still open: this can be done once it closes.',
  ChallengeWindowClosed: () => 'The challenge window has closed.',
  AlreadyDisputed: () => 'You already disputed this result.',
  NotSeated: () => 'You do not have a seat in this match.',
  NothingToWithdraw: () => 'Nothing is waiting for you to collect.',
  BelowMinimumWithdrawal: () => 'This balance is under the smallest amount that can be collected this way.',
  // Session keys and one-click play
  InvalidSession: () => 'Your one-click session is not valid here any more. Turn one-click play on again, or use your wallet.',
  SessionExpired: () => 'Your one-click session has expired. Turn one-click play on again, or use your wallet.',
  SessionNotPermitted: () => 'Your one-click session cannot make this call.',
  SpendCapExceeded: () => 'This would go over your one-click spending cap.',
  ValueCapExceeded: () => 'This stake is over your one-click per-call cap.',
  BadNonce: () => 'Another one-click call went first. Try again.',
  WrongNonce: () => 'Another one-click call went first. Try again.',
  // Tokens, permits and swaps
  ERC20InsufficientBalance: (args) => `You hold ${lms(args[1])}, less than the ${lms(args[2])} this needs.`,
  ERC20InsufficientAllowance: () => 'The token allowance is too small. Approve it again and retry.',
  ERC2612ExpiredSignature: () => 'The signed permit had already expired when it arrived. Try again.',
  DeadlinePassed: () => 'The price expired before the transaction landed. Quote it again.',
  SlippageExceeded: () => 'The price moved past the most you agreed to pay. Quote it again.',
  DiscountOff: () => 'The LMS fee discount is off right now.',
  NoDiscount: () => 'There is no discount to apply to this join.',
  // Staking and rewards
  StillCoolingDown: () => 'Your unstake is still cooling down.',
  NothingToClaim: () => 'Nothing to claim yet.',
  NothingToRelease: () => 'Nothing has vested yet.',
  ZeroAmount: () => 'Enter an amount greater than zero.',
  ZeroAddress: () => 'An address is missing (the zero address is not allowed).',
  // Governance
  GovernorAlreadyCastVote: () => 'You have already voted on this proposal.',
  GovernorInsufficientProposerVotes: () => 'You do not hold enough votes to make a proposal.',
  GovernorUnexpectedProposalState: () => 'The proposal is not in the stage this needs. Refresh and try again.',
  // Avatars
  AlreadyMinted: () => 'This wallet has already minted its avatar.',
  SoldOut: () => 'Every avatar has been minted.',
  // Across
  HubRecipientRequired: () => 'A contract wallet cannot join from this chain as itself. Join from the hub instead.',
};

function say(name: string, args: readonly unknown[]): string {
  const message = MESSAGES[name];
  if (message) return message(args);
  // Named, at least: "InvalidStakeRange" reads as "Invalid stake range".
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return `The transaction would fail: ${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}
