import { errorFirstLine, sharesForUnstake } from '@lms/protocol';
import { app, dom } from '../context.js';
import { toast } from '../ui/chrome.js';
import { parseLms, stakingPanel, type StakingPosition } from '../ui/staking.js';

/**
 * The staking panel: stake, unstake, withdraw, and claim the ETH that
 * staking earns.
 *
 * Reads the chain through the player's own wallet. Every write simulates
 * first, so a revert reads as its reason.
 */

let position: StakingPosition | null = null;
let busy = false;

export function wireStakingControls(): void {
  dom.stakingMax.onclick = () => {
    if (position) dom.stakingAmount.value = maxText(position);
  };
  dom.stakeLms.onclick = () => void act('Staked.', stake());
  dom.unstakeLms.onclick = () => void act('Unstake requested. Your vote stops now.', unstake());
  dom.withdrawUnstaked.onclick = () => void act('Withdrawn to your wallet.', withdraw());
  dom.claimRewards.onclick = () => void act('ETH sent to your wallet.', claimRewards());
}

export async function renderStakingPanel(): Promise<void> {
  const wallet = app.wallet;
  const info = app.staking;
  let error: string | null = null;

  if (wallet && info) {
    try {
      position = await wallet.stakingPosition(info.vault);
    } catch (err) {
      position = null;
      // Almost always a wallet pointed at a chain the vault is not on.
      error = `Could not read your stake: ${errorFirstLine(err)}`;
    }
  } else {
    position = null;
  }

  const view = stakingPanel({
    info,
    connected: Boolean(wallet),
    position,
    nowSeconds: Math.floor(Date.now() / 1000),
    error,
  });
  dom.stakingPanel.classList.toggle('hidden', !view.visible);
  dom.stakingRewards.textContent = view.rewards;
  dom.claimRewards.classList.toggle('hidden', !view.claimRewardsVisible);
  dom.claimRewards.disabled = busy;
  dom.stakingSummary.textContent = view.summary;
  dom.stakeLms.disabled = busy || view.stakeDisabled;
  dom.unstakeLms.disabled = busy || view.unstakeDisabled;
  dom.stakingMax.disabled = busy || !position;
  dom.withdrawUnstaked.disabled = busy;
  dom.unstakeStatus.textContent = view.pending.text;
  dom.withdrawUnstaked.classList.toggle('hidden', !view.pending.withdrawVisible);
  dom.stakingStatus.textContent = view.status;
}

/** Runs one transaction, keeping the panel's buttons closed until it is mined. */
async function act(done: string, pending: Promise<`0x${string}` | null>): Promise<void> {
  if (busy) return;
  busy = true;
  void renderStakingPanel();
  try {
    const hash = await pending;
    if (hash && app.wallet) {
      await app.wallet.waitFor(hash);
      toast(done);
      dom.stakingAmount.value = '';
    }
  } catch (error) {
    console.error('[staking]', error);
    toast(errorFirstLine(error));
  } finally {
    busy = false;
    void renderStakingPanel();
  }
}

async function stake(): Promise<`0x${string}` | null> {
  const wallet = app.wallet;
  const vault = app.staking?.vault;
  if (!wallet || !vault) return null;
  const amount = parseLms(dom.stakingAmount.value);
  if (amount === null) throw new Error('Enter how much LMS to stake.');
  return wallet.stake(vault, amount);
}

async function unstake(): Promise<`0x${string}` | null> {
  const wallet = app.wallet;
  const vault = app.staking?.vault;
  if (!wallet || !vault || !position) return null;
  const amount = parseLms(dom.stakingAmount.value);
  if (amount === null) throw new Error('Enter how much LMS to unstake.');
  return wallet.requestUnstake(vault, sharesForUnstake(amount, position.shares, position.value));
}

async function claimRewards(): Promise<`0x${string}` | null> {
  const wallet = app.wallet;
  const vault = app.staking?.vault;
  if (!wallet || !vault) return null;
  return wallet.claimRewards(vault);
}

async function withdraw(): Promise<`0x${string}` | null> {
  const wallet = app.wallet;
  const vault = app.staking?.vault;
  if (!wallet || !vault) return null;
  return wallet.claimUnstaked(vault);
}

/**
 * "Max" fills whichever side has something to move: the wallet balance to
 * stake, or else the whole position to unstake.
 */
function maxText(current: StakingPosition): string {
  const wei = current.lmsBalance > 0n ? current.lmsBalance : current.value;
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}
