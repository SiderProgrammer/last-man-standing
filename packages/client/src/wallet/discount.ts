import type { Address, Hex } from 'viem';
import { ZERO_ADDRESS } from '@lms/consensus';
import { gameEscrowAbi, lmsTokenAbi, protocolConfigAbi } from '@lms/contracts';
import type { DiscountTerms } from '../ui/views.js';
import { signLmsPermit } from './permit.js';
import type { Wallet } from './wallet.js';

/**
 * Paying part of a match fee in LMS: up to half of it, at the rate
 * governance sets, with the LMS escrowed and burned when the match settles.
 * Loaded with the lobby's discount option.
 */

/** The rate and this wallet's LMS, or null when governance has the discount off. */
export async function discountTerms(wallet: Wallet, escrow: Address): Promise<DiscountTerms | null> {
  const config = await wallet.rpc.readContract({ address: escrow, abi: gameEscrowAbi, functionName: 'config' });
  const [token, rate] = await Promise.all([
    wallet.rpc.readContract({ address: config, abi: protocolConfigAbi, functionName: 'lmsToken' }),
    wallet.rpc.readContract({ address: config, abi: protocolConfigAbi, functionName: 'lmsPerEthDiscount' }),
  ]);
  if (token === ZERO_ADDRESS || rate === 0n) return null;
  const balance = await wallet.rpc.readContract({
    address: token,
    abi: lmsTokenAbi,
    functionName: 'balanceOf',
    args: [wallet.address],
  });
  return { token, rate, balance };
}

/**
 * What `lmsIn` takes off a seat's fee in `matchId` now, and how much of it
 * the escrow would use: never more than buys the largest discount allowed.
 */
export async function quoteDiscount(
  wallet: Wallet,
  escrow: Address,
  matchId: Hex,
  lmsIn: bigint,
): Promise<{ discount: bigint; lmsUsed: bigint }> {
  const [discount, lmsUsed] = await wallet.rpc.readContract({
    address: escrow,
    abi: gameEscrowAbi,
    functionName: 'quoteLmsDiscount',
    args: [matchId, lmsIn],
  });
  return { discount, lmsUsed };
}

/**
 * Takes the seat paying `stake - discount` in ETH and `lmsUsed` in LMS: a
 * permit for the LMS, signed for free, and one transaction that uses it.
 * The escrow prices the discount again as it lands, so a rate changed since
 * the quote fails the simulation here rather than charging a different sum.
 */
export async function joinWithLms(
  wallet: Wallet,
  escrow: Address,
  token: Address,
  matchId: Hex,
  stake: bigint,
  quote: { discount: bigint; lmsUsed: bigint },
): Promise<Hex> {
  const chain = await wallet.onHub();
  const { deadline, v, r, s } = await signLmsPermit(wallet, token, escrow, quote.lmsUsed);
  const { request } = await wallet.rpc.simulateContract({
    account: wallet.address,
    address: escrow,
    abi: gameEscrowAbi,
    functionName: 'joinWithLmsPermit',
    args: [matchId, quote.lmsUsed, deadline, v, r, s],
    value: stake - quote.discount,
  });
  return wallet.client.writeContract({ ...request, chain });
}
