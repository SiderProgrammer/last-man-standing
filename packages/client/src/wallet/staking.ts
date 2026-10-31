import { parseSignature, type Address, type Hex } from 'viem';
import { claimableEpochRange, lmsTokenAbi, rewardsDistributorAbi, stakedLmsAbi } from '@lms/protocol';
import type { PlayRewards, StakingPosition } from '../ui/staking.js';
import { PERMIT_SECONDS, type Wallet } from './wallet.js';

/**
 * The staking vault and play-mining, through the player's own wallet: what
 * the staking panel reads and sends. Its own module, loaded with that panel,
 * so the contracts' ABIs stay out of the main bundle.
 */

/** Everything the staking panel shows, read in one round trip. */
export async function stakingPosition(wallet: Wallet, vault: Address): Promise<StakingPosition> {
  const lms = await wallet.rpc.readContract({ address: vault, abi: stakedLmsAbi, functionName: 'underlying' });
  const [lmsBalance, staked, votes, delegate, earned, cooldown, [pendingAssets, unlockAt], block] = await Promise.all([
    wallet.rpc.readContract({ address: lms, abi: lmsTokenAbi, functionName: 'balanceOf', args: [wallet.address] }),
    wallet.rpc.readContract({ address: vault, abi: stakedLmsAbi, functionName: 'balanceOf', args: [wallet.address] }),
    wallet.rpc.readContract({ address: vault, abi: stakedLmsAbi, functionName: 'getVotes', args: [wallet.address] }),
    wallet.rpc.readContract({ address: vault, abi: stakedLmsAbi, functionName: 'delegates', args: [wallet.address] }),
    wallet.rpc.readContract({ address: vault, abi: stakedLmsAbi, functionName: 'earned', args: [wallet.address] }),
    wallet.rpc.readContract({ address: vault, abi: stakedLmsAbi, functionName: 'cooldown' }),
    wallet.rpc.readContract({ address: vault, abi: stakedLmsAbi, functionName: 'unstakeOf', args: [wallet.address] }),
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
  const [name, nonce] = await Promise.all([
    wallet.rpc.readContract({ address: lms, abi: lmsTokenAbi, functionName: 'name' }),
    wallet.rpc.readContract({ address: lms, abi: lmsTokenAbi, functionName: 'nonces', args: [wallet.address] }),
  ]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + PERMIT_SECONDS);
  const signature = await wallet.client.signTypedData({
    account: wallet.signer,
    domain: { name, version: '1', chainId: wallet.chainId, verifyingContract: lms },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: { owner: wallet.address, spender: vault, value: amount, nonce, deadline },
  });
  const { r, s, v, yParity } = parseSignature(signature);

  const { request } = await wallet.rpc.simulateContract({
    account: wallet.address,
    address: vault,
    abi: stakedLmsAbi,
    functionName: 'depositWithPermit',
    args: [amount, deadline, Number(v ?? BigInt(yParity + 27)), r, s],
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
  const [firstEpoch, epochLength, programEpochs, block] = await Promise.all([
    wallet.rpc.readContract({ address: distributor, abi: rewardsDistributorAbi, functionName: 'firstEpoch' }),
    wallet.rpc.readContract({ address: distributor, abi: rewardsDistributorAbi, functionName: 'epochLength' }),
    wallet.rpc.readContract({ address: distributor, abi: rewardsDistributorAbi, functionName: 'PROGRAM_EPOCHS' }),
    wallet.rpc.getBlock(),
  ]);
  const range = claimableEpochRange(firstEpoch, epochLength, programEpochs, block.timestamp);
  if (!range) return { claimable: 0n, epochs: [] };
  const [claimable, epochs] = await wallet.rpc.readContract({
    address: distributor,
    abi: rewardsDistributorAbi,
    functionName: 'claimable',
    args: [wallet.address, range.from, range.to],
  });
  return { claimable, epochs: [...epochs] };
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
