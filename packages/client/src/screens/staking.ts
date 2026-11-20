import { formatUnits } from 'viem';
import { chainInfo } from '@lms/contracts';

import { app, dom, store } from '../context.js';
import { toast } from '../ui/chrome.js';
import {
  cooldownRestartWarning,
  faucetLine,
  formatLms,
  parseDelegatee,
  parseLms,
  stakingPanel,
  type FaucetState,
  type PlayRewards,
  type StakingPosition,
  type Vesting,
} from '../ui/staking.js';
import * as stakingCalls from '../wallet/staking.js';
import { switchToHub } from '../wallet/flows.js';
import type { Wallet } from '../wallet/wallet.js';
import { chainNow } from '../io/chainClock.js';
import { explainError } from '../ui/errors.js';

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
let faucet: FaucetState | null = null;
let busy = false;
/**
 * Renders overlap (a login, a store change, a drip and the timer can each
 * start one), and each paints after its reads come back: only the latest
 * started may paint, so a slow, older read never paints over a newer one.
 */
let renders = 0;

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

/**
 * After the faucet paid this wallet: reads again until the panel shows it.
 * The wallet's node can trail the server's by a block or two, so the first
 * read may still see the wallet unpaid; it gives up after about ten seconds,
 * and the panel's own timer catches up from there.
 */
export async function refreshAfterDrip(): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await renderStakingPanel();
    if (faucet?.dripped) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

export async function renderStakingPanel(): Promise<void> {
  const render = ++renders;
  const wallet = app.wallet;
  const info = app.staking;
  let error: string | null = null;

  // A guest has no LMS and no chain: nothing to read, and no network to switch.
  const guest = Boolean(wallet?.isGuest);
  const wrongChain = !guest && Boolean(wallet && info && wallet.chainId !== app.chainId);
  const hub = chainInfo(app.chainId).name;
  dom.stakingWrongChain.classList.toggle('hidden', !wrongChain);
  if (wrongChain && wallet) {
    // The vault lives on the hub. A wallet on a spoke plays from there
    // perfectly well, but stakes LMS on the hub: say so up front, with the
    // one button that fixes it, rather than leave every control greyed out.
    error = `Switch to ${hub} to stake.`;
    dom.stakingWrongChainText.textContent = wallet.canSwitchChain
      ? `Your wallet is on ${chainInfo(wallet.chainId).name}. LMS is staked, claimed and voted with on ${hub}.`
      : `Your wallet is on ${chainInfo(wallet.chainId).name} and signs there only. LMS is staked, claimed and voted with on ${hub}.`;
    dom.stakingSwitch.textContent = `Switch to ${hub}`;
    dom.stakingSwitch.classList.toggle('hidden', !wallet.canSwitchChain);
  } else if (guest) {
    error = info?.faucet
      ? `Connect a wallet to stake LMS. On testnet, a wallet with ${hub} ETH gets free LMS the first time it signs in.`
      : 'Connect a wallet to stake LMS.';
  }

  // Read into locals, and kept only if no newer render started meanwhile.
  let read: StakingPosition | null = null;
  if (!error && wallet && info) {
    try {
      read = await stakingCalls.stakingPosition(wallet, info.vault);
    } catch (err) {
      // Almost always a wallet pointed at a chain the vault is not on.
      error = `Could not read your stake: ${explainError(err)}`;
    }
  }

  // The stake read fine, so a failure here is the distributor's, the vesting
  // contract's or the faucet's alone: show the rest.
  const extras = wallet && !guest && info && !error;
  const [readRewards, readVesting, readFaucet] = await Promise.all([
    extras && info.rewards
      ? stakingCalls.playRewards(wallet, info.rewards).catch((err: unknown) => {
          console.warn('[staking] could not read play rewards', err);
          return null;
        })
      : null,
    extras && info.rewards
      ? stakingCalls.vesting(wallet, info.rewards).catch((err: unknown) => {
          console.warn('[staking] could not read vesting', err);
          return null;
        })
      : null,
    extras && info.faucet
      ? stakingCalls.faucetState(wallet, info.faucet).catch((err: unknown) => {
          console.warn('[staking] could not read the faucet', err);
          return null;
        })
      : null,
  ]);
  if (render !== renders) return;
  position = read;
  playRewards = readRewards;
  vesting = readVesting;
  faucet = readFaucet;

  dom.faucetStatus.textContent = faucetLine(faucet, hub);
  dom.faucetRow.classList.toggle('hidden', !dom.faucetStatus.textContent);

  const view = stakingPanel({
    info,
    connected: Boolean(wallet),
    position,
    playRewards,
    vesting,
    nowSeconds: chainNow(),
    error,
    hubName: hub,
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
      await app.wallet.waitFor(hash, 'Staking');
      toast(done, 'success');
      dom.stakingAmount.value = '';
    }
  } catch (error) {
    console.error('[staking]', error);
    toast(explainError(error), 'error');
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
  if (position && amount > position.lmsBalance) throw new Error(`You hold ${formatLms(position.lmsBalance, 2, 'down')} LMS.`);
  return stakingCalls.stake(at.wallet, at.vault, amount);
}

async function unstake(): Promise<`0x${string}` | null> {
  const at = walletAndVault();
  if (!at || !position) return null;
  const amount = parseLms(dom.stakingAmount.value);
  if (amount === null) throw new Error('Enter how much LMS to unstake.');
  if (amount > position.staked) throw new Error(`You have ${formatLms(position.staked, 2, 'down')} LMS staked.`);
  // A new request joins the one already unlocking and starts its clock again.
  const warning = cooldownRestartWarning(position);
  if (warning && !window.confirm(`${warning} Unstake anyway?`)) return null;
  return stakingCalls.requestUnstake(at.wallet, at.vault, amount);
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
