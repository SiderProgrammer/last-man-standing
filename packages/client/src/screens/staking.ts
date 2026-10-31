import { chainInfo, errorFirstLine } from '@lms/protocol';
import { app, dom, store } from '../context.js';
import { toast } from '../ui/chrome.js';
import { parseDelegatee, parseLms, stakingPanel, type PlayRewards, type StakingPosition } from '../ui/staking.js';
import * as stakingCalls from '../wallet/staking.js';

/**
 * The staking panel: stake, unstake, withdraw, claim the ETH that staking
 * earns, claim the LMS that playing earns, and delegate the votes.
 *
 * Reads the chain through the player's own wallet. Every write simulates
 * first, so a revert reads as its reason.
 */

let position: StakingPosition | null = null;
let playRewards: PlayRewards | null = null;
let busy = false;

export function wireStakingControls(): void {
  dom.stakingMax.onclick = () => {
    if (position) dom.stakingAmount.value = maxText(position);
  };
  dom.stakeLms.onclick = () => void act('Staked.', stake());
  dom.unstakeLms.onclick = () => void act('Unstake requested. Your vote stops now.', unstake());
  dom.withdrawUnstaked.onclick = () => void act('Withdrawn to your wallet.', withdraw());
  dom.claimRewards.onclick = () => void act('ETH sent to your wallet.', claimRewards());
  dom.claimPlayRewards.onclick = () => void act('LMS claimed. It vests over six months; stake it once released to vote.', claimPlayRewards());
  dom.delegateVotes.onclick = () => void act('Votes delegated. Your stake and rewards stay with you.', delegate());
  dom.undelegateVotes.onclick = () => void act('Your votes are back with you.', undelegate());
  store.subscribe(['wallet', 'walletChainId', 'chainId', 'staking'], () => void renderStakingPanel());
}

export async function renderStakingPanel(): Promise<void> {
  const wallet = app.wallet;
  const info = app.staking;
  let error: string | null = null;

  if (wallet && info && wallet.chainId !== app.chainId) {
    // The vault lives on the hub. A wallet on a spoke plays from there
    // perfectly well, but stakes LMS on the hub.
    position = null;
    error = `Staking LMS happens on ${chainInfo(app.chainId).name}. Switch your wallet there to stake or vote.`;
  } else if (wallet && info) {
    try {
      position = await stakingCalls.stakingPosition(wallet, info.vault);
    } catch (err) {
      position = null;
      // Almost always a wallet pointed at a chain the vault is not on.
      error = `Could not read your stake: ${errorFirstLine(err)}`;
    }
  } else {
    position = null;
  }

  playRewards = null;
  if (wallet && info?.rewards && !error) {
    try {
      playRewards = await stakingCalls.playRewards(wallet, info.rewards);
    } catch (err) {
      // The stake read fine, so this is the distributor alone: show the rest.
      console.warn('[staking] could not read play rewards', err);
    }
  }

  const view = stakingPanel({
    info,
    connected: Boolean(wallet),
    position,
    playRewards,
    nowSeconds: Math.floor(Date.now() / 1000),
    error,
  });
  dom.stakingPanel.classList.toggle('hidden', !view.visible);
  dom.stakingRewards.textContent = view.rewards;
  dom.claimRewards.classList.toggle('hidden', !view.claimRewardsVisible);
  dom.claimRewards.disabled = busy;
  dom.playRewards.textContent = view.playRewards;
  dom.claimPlayRewards.classList.toggle('hidden', !view.claimPlayVisible);
  dom.claimPlayRewards.disabled = busy;
  dom.stakingSummary.textContent = view.summary;
  dom.stakeLms.disabled = busy || view.stakeDisabled;
  dom.unstakeLms.disabled = busy || view.unstakeDisabled;
  dom.stakingMax.disabled = busy || !position;
  dom.withdrawUnstaked.disabled = busy;
  dom.unstakeStatus.textContent = view.pending.text;
  dom.withdrawUnstaked.classList.toggle('hidden', !view.pending.withdrawVisible);
  dom.delegationStatus.textContent = view.delegation;
  dom.delegateVotes.disabled = busy || view.delegateDisabled;
  dom.undelegateVotes.classList.toggle('hidden', !view.undelegateVisible);
  dom.undelegateVotes.disabled = busy;
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
  return stakingCalls.stake(wallet, vault, amount);
}

async function unstake(): Promise<`0x${string}` | null> {
  const wallet = app.wallet;
  const vault = app.staking?.vault;
  if (!wallet || !vault || !position) return null;
  const amount = parseLms(dom.stakingAmount.value);
  if (amount === null) throw new Error('Enter how much LMS to unstake.');
  // One sLMS is one LMS; more than the position unstakes all of it.
  return stakingCalls.requestUnstake(wallet, vault, amount < position.staked ? amount : position.staked);
}

async function claimRewards(): Promise<`0x${string}` | null> {
  const wallet = app.wallet;
  const vault = app.staking?.vault;
  if (!wallet || !vault) return null;
  return stakingCalls.claimRewards(wallet, vault);
}

async function claimPlayRewards(): Promise<`0x${string}` | null> {
  const wallet = app.wallet;
  const distributor = app.staking?.rewards;
  if (!wallet || !distributor || !playRewards || playRewards.epochs.length === 0) return null;
  return stakingCalls.claimPlayRewards(wallet, distributor, playRewards.epochs);
}

async function delegate(): Promise<`0x${string}` | null> {
  const wallet = app.wallet;
  const vault = app.staking?.vault;
  if (!wallet || !vault) return null;
  const parsed = parseDelegatee(dom.delegateTo.value);
  if (!parsed.ok) throw new Error(parsed.error);
  const hash = await stakingCalls.delegateVotes(wallet, vault, parsed.address);
  dom.delegateTo.value = '';
  return hash;
}

async function undelegate(): Promise<`0x${string}` | null> {
  const wallet = app.wallet;
  const vault = app.staking?.vault;
  if (!wallet || !vault) return null;
  return stakingCalls.delegateVotes(wallet, vault, wallet.address);
}

async function withdraw(): Promise<`0x${string}` | null> {
  const wallet = app.wallet;
  const vault = app.staking?.vault;
  if (!wallet || !vault) return null;
  return stakingCalls.claimUnstaked(wallet, vault);
}

/**
 * "Max" fills whichever side has something to move: the wallet balance to
 * stake, or else the whole position to unstake.
 */
function maxText(current: StakingPosition): string {
  const wei = current.lmsBalance > 0n ? current.lmsBalance : current.staked;
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}
