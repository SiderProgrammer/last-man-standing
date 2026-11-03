import type { Address, Hex } from 'viem';
import { claimableEpochRange, lmsTokenAbi, rewardVestingAbi, rewardsDistributorAbi, stakedLmsAbi } from '@lms/contracts';
import type { PlayRewards, StakingPosition, Vesting } from '../ui/staking.js';
import { signLmsPermit } from './permit.js';
import type { Wallet } from './wallet.js';

/**
 * The staking vault and play-mining, through the player's own wallet: what
 * the staking panel reads and sends. Its own module, loaded with that panel,
 * so the contracts' ABIs stay out of the main bundle.
 */

/** Everything the staking panel shows, read in one round trip. */
export async function stakingPosition(wallet: Wallet, vault: Address): Promise<StakingPosition> {
  const at = { address: vault, abi: stakedLmsAbi } as const;
  const mine = [wallet.address] as const;
  const lms = await wallet.rpc.readContract({ ...at, functionName: 'underlying' });
  const [lmsBalance, staked, votes, delegate, earned, cooldown, [pendingAssets, unlockAt], block] = await Promise.all([
    wallet.rpc.readContract({ address: lms, abi: lmsTokenAbi, functionName: 'balanceOf', args: mine }),
    wallet.rpc.readContract({ ...at, functionName: 'balanceOf', args: mine }),
    wallet.rpc.readContract({ ...at, functionName: 'getVotes', args: mine }),
    wallet.rpc.readContract({ ...at, functionName: 'delegates', args: mine }),
    wallet.rpc.readContract({ ...at, functionName: 'earned', args: mine }),
    wallet.rpc.readContract({ ...at, functionName: 'cooldown' }),
    wallet.rpc.readContract({ ...at, functionName: 'unstakeOf', args: mine }),
    wallet.rpc.getBlock(),
  ]);
  return {
    lmsBalance,
    staked,
    votes,
    self: wallet.address,
    delegate,
    earned,
    cooldown: Number(cooldown),
    pending: { assets: pendingAssets, unlockAt: Number(unlockAt) },
    chainTime: Number(block.timestamp),
  };
}

/**
 * Stakes `amount` LMS in one transaction: an EIP-2612 signature grants the
 * vault its allowance, and `depositWithPermit` uses it straight away. The
 * signature is free, so a player sees one signing prompt and one
 * transaction instead of an approval and a deposit.
 */
export async function stake(wallet: Wallet, vault: Address, amount: bigint): Promise<Hex> {
  const chain = await wallet.onHub();
  const lms = await wallet.rpc.readContract({ address: vault, abi: stakedLmsAbi, functionName: 'underlying' });
  const { deadline, v, r, s } = await signLmsPermit(wallet, lms, vault, amount);
  const { request } = await wallet.rpc.simulateContract({
    account: wallet.address,
    address: vault,
    abi: stakedLmsAbi,
    functionName: 'depositWithPermit',
    args: [amount, deadline, v, r, s],
  });
  return wallet.client.writeContract({ ...request, chain });
}

/**
 * Hands this wallet's votes to `delegatee`, or takes them back with its own
 * address. The sLMS stays here and keeps earning; only the votes move.
 */
export async function delegateVotes(wallet: Wallet, vault: Address, delegatee: Address): Promise<Hex> {
  const chain = await wallet.onHub();
  const { request } = await wallet.rpc.simulateContract({
    account: wallet.address,
    address: vault,
    abi: stakedLmsAbi,
    functionName: 'delegate',
    args: [delegatee],
  });
  return wallet.client.writeContract({ ...request, chain });
}

/** Burns `amount` sLMS now and starts the cooldown on the LMS behind it. */
export async function requestUnstake(wallet: Wallet, vault: Address, amount: bigint): Promise<Hex> {
  const chain = await wallet.onHub();
  const { request } = await wallet.rpc.simulateContract({
    account: wallet.address,
    address: vault,
    abi: stakedLmsAbi,
    functionName: 'requestUnstake',
    args: [amount],
  });
  return wallet.client.writeContract({ ...request, chain });
}

/** Withdraws unstaked LMS once the cooldown has passed. */
export async function claimUnstaked(wallet: Wallet, vault: Address): Promise<Hex> {
  const chain = await wallet.onHub();
  const { request } = await wallet.rpc.simulateContract({
    account: wallet.address,
    address: vault,
    abi: stakedLmsAbi,
    functionName: 'claim',
    args: [wallet.address],
  });
  return wallet.client.writeContract({ ...request, chain });
}

/**
 * Play-mining LMS this wallet can claim now, and the epochs it comes from.
 * One `eth_call` over every epoch that has ended: the distributor loops.
 */
export async function playRewards(wallet: Wallet, distributor: Address): Promise<PlayRewards> {
  const { range } = await endedEpochs(wallet, distributor);
  if (!range) return { claimable: 0n, epochs: [] };
  const [claimable, epochs] = await wallet.rpc.readContract({
    address: distributor,
    abi: rewardsDistributorAbi,
    functionName: 'claimable',
    args: [wallet.address, range.from, range.to],
  });
  return { claimable, epochs: [...epochs] };
}

/**
 * The distributor's epochs that have ended by the chain's clock, null before
 * the first has; how long an epoch is, in seconds; and that clock, in unix seconds.
 */
async function endedEpochs(
  wallet: Wallet,
  distributor: Address,
): Promise<{ range: { from: bigint; to: bigint } | null; epochLength: bigint; chainTime: number }> {
  const at = { address: distributor, abi: rewardsDistributorAbi } as const;
  const [firstEpoch, epochLength, programEpochs, block] = await Promise.all([
    wallet.rpc.readContract({ ...at, functionName: 'firstEpoch' }),
    wallet.rpc.readContract({ ...at, functionName: 'epochLength' }),
    wallet.rpc.readContract({ ...at, functionName: 'PROGRAM_EPOCHS' }),
    wallet.rpc.getBlock(),
  ]);
  return {
    range: claimableEpochRange(firstEpoch, epochLength, programEpochs, block.timestamp),
    epochLength,
    chainTime: Number(block.timestamp),
  };
}

/** Claims play-mining rewards for `epochs`, vesting to this wallet over six months. */
export async function claimPlayRewards(wallet: Wallet, distributor: Address, epochs: readonly bigint[]): Promise<Hex> {
  const chain = await wallet.onHub();
  const { request } = await wallet.rpc.simulateContract({
    account: wallet.address,
    address: distributor,
    abi: rewardsDistributorAbi,
    functionName: 'claim',
    args: [wallet.address, [...epochs]],
  });
  return wallet.client.writeContract({ ...request, chain });
}

/** Pays the ETH this wallet has earned from fees to itself. */
export async function claimRewards(wallet: Wallet, vault: Address): Promise<Hex> {
  const chain = await wallet.onHub();
  const { request } = await wallet.rpc.simulateContract({
    account: wallet.address,
    address: vault,
    abi: stakedLmsAbi,
    functionName: 'claimRewards',
    args: [wallet.address],
  });
  return wallet.client.writeContract({ ...request, chain });
}

/**
 * What this wallet's claimed play-mining rewards are doing in `RewardVesting`.
 *
 * A tranche exists only for an epoch that has ended, so the epochs read are
 * the distributor's ended ones; one read per epoch, a few dozen at most for
 * a year of weekly epochs.
 */
export async function vesting(wallet: Wallet, distributor: Address): Promise<Vesting> {
  const [address, { range, epochLength, chainTime }] = await Promise.all([
    wallet.rpc.readContract({ address: distributor, abi: rewardsDistributorAbi, functionName: 'vesting' }),
    endedEpochs(wallet, distributor),
  ]);
  const none: Vesting = { address, held: 0n, releasable: 0n, epochs: [], fullyVestedAt: 0, chainTime };
  if (!range) return none;

  const contract = { address, abi: rewardVestingAbi } as const;
  const epochs: bigint[] = [];
  for (let epoch = range.from; epoch <= range.to; epoch += 1n) epochs.push(epoch);
  const [[releasable, ready], duration, tranches] = await Promise.all([
    wallet.rpc.readContract({ ...contract, functionName: 'releasableIn', args: [wallet.address, range.from, range.to] }),
    wallet.rpc.readContract({ ...contract, functionName: 'VESTING_DURATION' }),
    Promise.all(
      epochs.map((epoch) => wallet.rpc.readContract({ ...contract, functionName: 'trancheOf', args: [wallet.address, epoch] })),
    ),
  ]);

  let held = 0n;
  let fullyVestedAt = 0;
  tranches.forEach(([amount, released], i) => {
    if (amount <= released) return;
    held += amount - released;
    // `vestingStart`: the moment the tranche's epoch ended.
    const end = Number((epochs[i]! + 1n) * epochLength + duration);
    fullyVestedAt = Math.max(fullyVestedAt, end);
  });
  return { address, held, releasable, epochs: [...ready], fullyVestedAt, chainTime };
}

/** Pays this wallet what has vested in `epochs`, as liquid LMS. */
export async function releaseVested(wallet: Wallet, vestingAddress: Address, epochs: readonly bigint[]): Promise<Hex> {
  const chain = await wallet.onHub();
  const { request } = await wallet.rpc.simulateContract({
    account: wallet.address,
    address: vestingAddress,
    abi: rewardVestingAbi,
    functionName: 'release',
    args: [wallet.address, [...epochs]],
  });
  return wallet.client.writeContract({ ...request, chain });
}
