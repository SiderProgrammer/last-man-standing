import { formatUnits, getAddress, isAddress, parseUnits, type Address } from 'viem';
import { ZERO_ADDRESS, sameAddress, type StakingInfo } from '@lms/protocol';

/**
 * Pure builders for the staking panel: what to show for a given on-chain
 * position. The applier in `screens/staking.ts` reads the chain and writes the
 * result into the page; everything in between is here, so it runs in node.
 */

/** One wallet's stake, as read from `StakedLms` and `LmsToken`. */
export interface StakingPosition {
  /** Unstaked LMS in the wallet. */
  lmsBalance: bigint;
  /** sLMS held. */
  shares: bigint;
  /** What those shares redeem for, in LMS. Always equal to `shares`: one sLMS is one LMS. */
  value: bigint;
  /** Votes this wallet casts: its own stake, unless delegated away, plus any delegated to it. */
  votes: bigint;
  /** The wallet itself, to tell self-delegation from delegating away. */
  self: Address;
  /** Who this wallet's stake votes through. Zero if it has never held sLMS. */
  delegate: Address;
  /** ETH from match fees, waiting to be claimed. */
  earned: bigint;
  /** Seconds between requesting an unstake and withdrawing it. */
  cooldown: number;
  /** LMS on its way out, fixed when requested. `assets` is zero when there is none. */
  pending: { assets: bigint; unlockAt: number };
  /**
   * The latest block's timestamp. The contract unlocks against this, not the
   * browser's clock, which can be wrong — and on a fork or devnet, far off.
   */
  chainTime: number;
}

/** Play-mining LMS a wallet can claim now, from `RewardsDistributor.claimable`. */
export interface PlayRewards {
  claimable: bigint;
  /** The epochs it comes from: what `claim` is called with. */
  epochs: bigint[];
}

export interface StakingPanelInput {
  info: StakingInfo | null;
  connected: boolean;
  position: StakingPosition | null;
  /** Null when the server names no distributor, or the read failed. */
  playRewards?: PlayRewards | null;
  /** Used only when there is no position to take the chain's time from. */
  nowSeconds: number;
  /** A read that failed, usually a wallet on the wrong chain. */
  error: string | null;
}

export interface StakingPanel {
  visible: boolean;
  /** ETH waiting to be claimed, for the header pill. */
  rewards: string;
  claimRewardsVisible: boolean;
  /** Play-mining line: what has been earned by playing, or empty to hide it. */
  playRewards: string;
  claimPlayVisible: boolean;
  /** Where this wallet's votes go, or empty when it has no stake to delegate. */
  delegation: string;
  delegateDisabled: boolean;
  /** "Back to me": only once the votes have gone to someone else. */
  undelegateVisible: boolean;
  summary: string;
  stakeDisabled: boolean;
  unstakeDisabled: boolean;
  pending: { text: string; withdrawVisible: boolean };
  status: string;
}

export function stakingPanel(input: StakingPanelInput): StakingPanel {
  const hidden: StakingPanel = {
    visible: Boolean(input.info),
    rewards: '—',
    claimRewardsVisible: false,
    playRewards: '',
    claimPlayVisible: false,
    delegation: '',
    delegateDisabled: true,
    undelegateVisible: false,
    summary: '',
    stakeDisabled: true,
    unstakeDisabled: true,
    pending: { text: '', withdrawVisible: false },
    status: input.connected ? (input.error ?? 'Reading your stake…') : 'Connect a wallet to see your stake.',
  };
  const position = input.position;
  if (!input.info || !input.connected || !position || input.error) return hidden;

  const now = position.chainTime;
  const unlocked = position.pending.assets > 0n && now >= position.pending.unlockAt;

  return {
    visible: true,
    rewards: `${formatLms(position.earned, 6)} ETH earned`,
    claimRewardsVisible: position.earned > 0n,
    ...playRewardsLine(input.info, input.playRewards ?? null),
    ...delegationLine(position),
    summary:
      position.shares > 0n
        ? `Staked ${formatLms(position.value)} LMS · ${formatLms(position.votes)} votes · ${formatLms(position.lmsBalance)} LMS in wallet`
        : `Nothing staked yet · ${formatLms(position.lmsBalance)} LMS in wallet`,
    stakeDisabled: position.lmsBalance === 0n,
    unstakeDisabled: position.shares === 0n,
    pending:
      position.pending.assets === 0n
        ? { text: '', withdrawVisible: false }
        : unlocked
          ? { text: `${formatLms(position.pending.assets)} LMS ready to withdraw.`, withdrawVisible: true }
          : {
              text: `${formatLms(position.pending.assets)} LMS unlocking in ${formatDuration(position.pending.unlockAt - now)}.`,
              withdrawVisible: false,
            },
    status: `Unstaking takes ${formatDuration(position.cooldown)}. Your vote stops the moment you request it.`,
  };
}

/**
 * The play-mining line. Hidden without a distributor; with one, it says what
 * is waiting, or how play earns it, since a new player has nothing yet.
 */
function playRewardsLine(
  info: StakingInfo,
  rewards: PlayRewards | null,
): Pick<StakingPanel, 'playRewards' | 'claimPlayVisible'> {
  if (!info.rewards) return { playRewards: '', claimPlayVisible: false };
  if (!rewards || rewards.claimable === 0n) {
    return {
      playRewards: 'Play staked matches to earn LMS: each week is shared out by the fees you paid.',
      claimPlayVisible: false,
    };
  }
  const weeks = rewards.epochs.length;
  return {
    playRewards: `${formatLms(rewards.claimable)} LMS earned by playing, over ${weeks} week${weeks === 1 ? '' : 's'} · claimed as staked LMS`,
    claimPlayVisible: true,
  };
}

/**
 * Where the wallet's votes go. On L1 every vote costs gas, so most small
 * holders are better off handing their votes to someone who votes anyway;
 * the stake and its rewards stay put either way.
 */
function delegationLine(
  position: StakingPosition,
): Pick<StakingPanel, 'delegation' | 'delegateDisabled' | 'undelegateVisible'> {
  if (position.shares === 0n) return { delegation: '', delegateDisabled: true, undelegateVisible: false };
  if (sameAddress(position.delegate, position.self)) {
    return {
      delegation: 'You vote with your own stake. Voting costs gas on L1: you can hand your votes to a delegate instead.',
      delegateDisabled: false,
      undelegateVisible: false,
    };
  }
  if (sameAddress(position.delegate, ZERO_ADDRESS)) {
    return {
      delegation: 'Your stake is not voting: delegate to yourself or to someone else.',
      delegateDisabled: false,
      undelegateVisible: true,
    };
  }
  return {
    delegation: `Your votes go to ${position.delegate}. You keep the stake and its rewards.`,
    delegateDisabled: false,
    undelegateVisible: true,
  };
}

/**
 * A typed delegate, or why it cannot be one. The wallet's own address is
 * allowed — that is how votes come back — but the zero address is not:
 * delegating to it would silently switch the stake's votes off.
 */
export function parseDelegatee(text: string): { ok: true; address: Address } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!isAddress(trimmed)) return { ok: false, error: 'Enter the address to delegate your votes to.' };
  if (sameAddress(trimmed, ZERO_ADDRESS)) return { ok: false, error: 'Delegating to the zero address would switch your votes off.' };
  return { ok: true, address: getAddress(trimmed) };
}

/** An 18-decimal amount (LMS or ETH), readable: thousands separators, at most `decimals` places, no trailing zeros. */
export function formatLms(wei: bigint, decimals = 2): string {
  const [whole = '0', fraction = ''] = formatUnits(wei, 18).split('.');
  const grouped = BigInt(whole).toLocaleString('en-US');
  const trimmed = fraction.slice(0, decimals).replace(/0+$/, '');
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

/** A coarse countdown: the two largest units that matter. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** A typed LMS amount, or null if it is not a positive number. */
export function parseLms(text: string): bigint | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d{0,18})?$/.test(trimmed)) return null;
  const wei = parseUnits(trimmed, 18);
  return wei > 0n ? wei : null;
}

/** The server's HTTP origin, from the WebSocket URL the client connects to. */
export function httpOrigin(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return url.origin;
}
