import { errorFirstLine, sharesForUnstake, type AirdropAllocation } from '@lms/protocol';
import { app, dom } from '../context.js';
import { toast } from '../ui/chrome.js';
import { parseLms, stakingPanel, type AirdropState, type StakingPosition } from '../ui/staking.js';

/**
 * The staking panel: claim the airdrop, stake, unstake, withdraw.
 *
 * Reads the chain through the player's own wallet and the airdrop proof from
 * the game server; neither is trusted for anything the contracts do not check
 * themselves. Every write simulates first, so a revert reads as its reason.
 */

let serverOrigin = '';
let position: StakingPosition | null = null;
/** Allocation fetched for this address, so a re-render does not refetch it. */
let allocation: { address: string; claim: AirdropAllocation | null } | null = null;
let busy = false;

export function wireStakingControls(origin: string): void {
  serverOrigin = origin;
  dom.airdropClaimStake.onclick = () => void act('Claimed and staked.', claimAirdrop(true));
  dom.airdropClaim.onclick = () => void act('Claimed to your wallet.', claimAirdrop(false));
  dom.stakingMax.onclick = () => {
    if (position) dom.stakingAmount.value = maxText(position);
  };
  dom.stakeLms.onclick = () => void act('Staked.', stake());
  dom.unstakeLms.onclick = () => void act('Unstake requested. Your vote stops now.', unstake());
  dom.withdrawUnstaked.onclick = () => void act('Withdrawn to your wallet.', withdraw());
}

export async function renderStakingPanel(): Promise<void> {
  const wallet = app.wallet;
  const info = app.staking;
  let error: string | null = null;
  let airdrop: AirdropState | null = null;

  if (wallet && info) {
    try {
      position = await wallet.stakingPosition(info.vault);
      const claim = info.airdrop ? await fetchAllocation(wallet.address) : null;
      if (info.airdrop && claim) {
        airdrop = { amount: BigInt(claim.amount), claimed: await wallet.airdropClaimed(info.airdrop) };
      }
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
    airdrop,
    nowSeconds: Math.floor(Date.now() / 1000),
    error,
  });
  dom.stakingPanel.classList.toggle('hidden', !view.visible);
  dom.stakingRate.textContent = view.rate;
  dom.stakingSummary.textContent = view.summary;
  dom.airdropRow.classList.toggle('hidden', !view.airdrop.visible);
  dom.airdropText.textContent = view.airdrop.text;
  dom.stakeLms.disabled = busy || view.stakeDisabled;
  dom.unstakeLms.disabled = busy || view.unstakeDisabled;
  dom.stakingMax.disabled = busy || !position;
  dom.airdropClaim.disabled = busy;
  dom.airdropClaimStake.disabled = busy;
  dom.withdrawUnstaked.disabled = busy;
  dom.unstakeStatus.textContent = view.pending.text;
  dom.withdrawUnstaked.classList.toggle('hidden', !view.pending.withdrawVisible);
  dom.stakingStatus.textContent = view.status;
}

async function fetchAllocation(address: string): Promise<AirdropAllocation | null> {
  if (allocation?.address === address) return allocation.claim;
  const response = await fetch(`${serverOrigin}/airdrop/${address}`);
  const claim = response.ok ? ((await response.json()) as AirdropAllocation) : null;
  allocation = { address, claim };
  return claim;
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

async function claimAirdrop(stakeIt: boolean): Promise<`0x${string}` | null> {
  const wallet = app.wallet;
  const airdrop = app.staking?.airdrop;
  if (!wallet || !airdrop) return null;
  const claim = await fetchAllocation(wallet.address);
  if (!claim) throw new Error('No airdrop allocation for this wallet.');
  return wallet.claimAirdrop(airdrop, BigInt(claim.amount), claim.proof, stakeIt);
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
