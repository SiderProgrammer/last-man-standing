import { formatUnits, parseUnits } from 'viem';
import type { StakingInfo } from '@lms/protocol';

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
  votes: bigint;
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

export interface StakingPanelInput {
  info: StakingInfo | null;
  connected: boolean;
  position: StakingPosition | null;
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
