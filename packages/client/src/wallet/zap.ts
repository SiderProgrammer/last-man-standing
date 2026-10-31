import { erc20Abi, type Address, type Hex } from 'viem';
import { ZERO_ADDRESS, v4QuoterAbi, zapJoinAbi, type ZapPathKey } from '@lms/protocol';
import type { Wallet } from './wallet.js';

/**
 * Paying a stake in a token through `ZapJoin`: pricing the route, the
 * allowance, and the join. Loaded when a player picks a token to pay with.
 */

/**
 * What `path` charges for exactly `stakeWei` of ETH, in the token's units.
 *
 * The quoter executes the swap and reverts with the result, so this is a
 * simulation rather than a read — and costs nothing and signs nothing.
 */
export async function quoteZap(wallet: Wallet, quoter: Address, path: readonly ZapPathKey[], stakeWei: bigint): Promise<bigint> {
  const { result } = await wallet.rpc.simulateContract({
    address: quoter,
    abi: v4QuoterAbi,
    functionName: 'quoteExactOutput',
    args: [{ exactCurrency: ZERO_ADDRESS, path: [...path], exactAmount: stakeWei }],
  });
  return result[0];
}

export function tokenBalance(wallet: Wallet, token: Address): Promise<bigint> {
  return wallet.rpc.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [wallet.address],
  });
}

export function tokenAllowance(wallet: Wallet, token: Address, spender: Address): Promise<bigint> {
  return wallet.rpc.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [wallet.address, spender],
  });
}

/**
 * Sets the allowance to exactly `amount`, and waits for it.
 *
 * USDT refuses to move an allowance from one non-zero value to another, and
 * every token join leaves the unused slippage allowance behind, so the second
 * USDT join would fail. When the direct approval does not simulate and an
 * allowance is outstanding, it is zeroed first — one extra prompt, only for
 * the tokens that need it.
 */
export async function approveToken(wallet: Wallet, token: Address, spender: Address, amount: bigint): Promise<void> {
  const chain = await wallet.onHub();
  const approve = (value: bigint) =>
    wallet.rpc.simulateContract({
      account: wallet.address,
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, value],
    });

  let simulation;
  try {
    simulation = await approve(amount);
  } catch (error) {
    if ((await tokenAllowance(wallet, token, spender)) === 0n) throw error;
    const reset = await approve(0n);
    await wallet.waitFor(await wallet.client.writeContract({ ...reset.request, chain }));
    simulation = await approve(amount);
  }
  await wallet.waitFor(await wallet.client.writeContract({ ...simulation.request, chain }));
}

/** Swaps the route's first token for the stake and takes the seat, in one transaction. */
export async function joinWithToken(wallet: Wallet, 
  zap: Address,
  matchId: Hex,
  path: readonly ZapPathKey[],
  maxAmountIn: bigint,
  deadline: bigint,
): Promise<Hex> {
  const chain = await wallet.onHub();
  const { request } = await wallet.rpc.simulateContract({
    account: wallet.address,
    address: zap,
    abi: zapJoinAbi,
    functionName: 'joinWithToken',
    args: [matchId, [...path], maxAmountIn, deadline],
  });
  return wallet.client.writeContract({ ...request, chain });
}
