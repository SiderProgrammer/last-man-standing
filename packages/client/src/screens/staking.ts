import { formatUnits } from 'viem';
import { chainInfo } from '@lms/contracts';
import { errorFirstLine } from '@lms/api';
import { app, dom, store } from '../context.js';
import { toast } from '../ui/chrome.js';
import {
  parseDelegatee,
  parseLms,
  stakingPanel,
  type PlayRewards,
  type StakingPosition,
  type Vesting,
} from '../ui/staking.js';
import * as stakingCalls from '../wallet/staking.js';
import { switchToHub } from '../wallet/flows.js';
import type { Wallet } from '../wallet/wallet.js';

/**
 * The staking panel: stake, unstake, withdraw, claim the ETH that staking
 * earns, claim the LMS that playing earns, release it once it has vested,
 * and delegate the votes.
 *
 * Reads the chain through the player's own wallet. Every write simulates
 * first, so a revert reads as its reason.
 */

let position: StakingPosition | null = null;
let playRewards: PlayRewards | null = null;
let vesting: Vesting | null = null;
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
  dom.releaseVested.onclick = () => void act('Vested LMS released to your wallet. Stake it to vote.', releaseVested());
  dom.delegateVotes.onclick = () => void act('Votes delegated. Your stake and rewards stay with you.', delegate());
  dom.undelegateVotes.onclick = () => void act('Your votes are back with you.', undelegate());
  dom.stakingSwitch.onclick = () => void switchToHub();
  store.subscribe(['wallet', 'walletChainId', 'chainId', 'staking'], () => void renderStakingPanel());
}

export async function renderStakingPanel(): Promise<void> {
  const wallet = app.wallet;
  const info = app.staking;
  let error: string | null = null;

  const wrongChain = Boolean(wallet && info && wallet.chainId !== app.chainId);
  const hub = chainInfo(app.chainId).name;
  dom.stakingWrongChain.classList.toggle('hidden', !wrongChain);
  if (wrongChain && wallet) {
    // The vault lives on the hub. A wallet on a spoke plays from there
    // perfectly well, but stakes LMS on the hub: say so up front, with the
    // one button that fixes it, rather than leave every control greyed out.
    position = null;
    error = `Switch to ${hub} to stake.`;
    dom.stakingWrongChainText.textContent =
      `Your wallet is on ${chainInfo(wallet.chainId).name}. LMS is staked, claimed and voted with on ${hub}.`;
    dom.stakingSwitch.textContent = `Switch to ${hub}`;
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
  vesting = null;
  if (wallet && info?.rewards && !error) {
    const distributor = info.rewards;
    // The stake read fine, so a failure here is the distributor's or the
    // vesting contract's alone: show the rest.
    [playRewards, vesting] = await Promise.all([
      stakingCalls.playRewards(wallet, distributor).catch((err: unknown) => {
        console.warn('[staking] could not read play rewards', err);
        return null;
      }),
      stakingCalls.vesting(wallet, distributor).catch((err: unknown) => {
        console.warn('[staking] could not read vesting', err);
        return null;
      }),
    ]);
  }

  const view = stakingPanel({
    info,
    connected: Boolean(wallet),
    position,
    playRewards,
    vesting,
    nowSeconds: Math.floor(Date.now() / 1000),
    error,
  });
  dom.stakingPanel.classList.toggle('hidden', !view.visible);
  dom.stakingRewards.textContent = wrongChain ? `on ${hub}` : view.rewards;
  dom.stakeLms.title = wrongChain ? `Switch your wallet to ${hub} to stake.` : '';
  dom.claimRewards.classList.toggle('hidden', !view.claimRewardsVisible);
  dom.claimRewards.disabled = busy;
  dom.playRewards.textContent = view.playRewards;
  dom.claimPlayRewards.classList.toggle('hidden', !view.claimPlayVisible);
  dom.claimPlayRewards.disabled = busy;
  dom.vestingStatus.textContent = view.vesting;
  dom.releaseVested.classList.toggle('hidden', !view.releaseVisible);
  dom.releaseVested.disabled = busy;
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

/** The wallet and the staking vault, when there are both to act with. */
function walletAndVault(): { wallet: Wallet; vault: `0x${string}` } | null {
  const wallet = app.wallet;
  const vault = app.staking?.vault;
  return wallet && vault ? { wallet, vault } : null;
}

async function stake(): Promise<`0x${string}` | null> {
  const at = walletAndVault();
  if (!at) return null;
  const amount = parseLms(dom.stakingAmount.value);
  if (amount === null) throw new Error('Enter how much LMS to stake.');
  return stakingCalls.stake(at.wallet, at.vault, amount);
}

async function unstake(): Promise<`0x${string}` | null> {
  const at = walletAndVault();
  if (!at || !position) return null;
  const amount = parseLms(dom.stakingAmount.value);
  if (amount === null) throw new Error('Enter how much LMS to unstake.');
  // One sLMS is one LMS; more than the position unstakes all of it.
  return stakingCalls.requestUnstake(at.wallet, at.vault, amount < position.staked ? amount : position.staked);
}

async function claimRewards(): Promise<`0x${string}` | null> {
  const at = walletAndVault();
  return at && stakingCalls.claimRewards(at.wallet, at.vault);
}

async function claimPlayRewards(): Promise<`0x${string}` | null> {
  const wallet = app.wallet;
  const distributor = app.staking?.rewards;
  if (!wallet || !distributor || !playRewards || playRewards.epochs.length === 0) return null;
  return stakingCalls.claimPlayRewards(wallet, distributor, playRewards.epochs);
}

async function releaseVested(): Promise<`0x${string}` | null> {
  const wallet = app.wallet;
  if (!wallet || !vesting || vesting.epochs.length === 0) return null;
  return stakingCalls.releaseVested(wallet, vesting.address, vesting.epochs);
}

async function delegate(): Promise<`0x${string}` | null> {
  const at = walletAndVault();
  if (!at) return null;
  const parsed = parseDelegatee(dom.delegateTo.value);
  if (!parsed.ok) throw new Error(parsed.error);
  const hash = await stakingCalls.delegateVotes(at.wallet, at.vault, parsed.address);
  dom.delegateTo.value = '';
  return hash;
}

async function undelegate(): Promise<`0x${string}` | null> {
  const at = walletAndVault();
  return at && stakingCalls.delegateVotes(at.wallet, at.vault, at.wallet.address);
}

async function withdraw(): Promise<`0x${string}` | null> {
  const at = walletAndVault();
  return at && stakingCalls.claimUnstaked(at.wallet, at.vault);
}

/**
 * "Max" fills whichever side has something to move: the wallet balance to
 * stake, or else the whole position to unstake.
 */
function maxText(current: StakingPosition): string {
  return formatUnits(current.lmsBalance > 0n ? current.lmsBalance : current.staked, 18);
}
