import { parseSignature, type Address, type Hex } from 'viem';
import { lmsTokenAbi } from '@lms/contracts';
import { PERMIT_SECONDS, type Wallet } from './wallet.js';

/** An EIP-2612 permit, split the way `depositWithPermit` and `joinWithLmsPermit` take it. */
export interface Permit {
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

/**
 * Signs an EIP-2612 permit letting `spender` take `value` of LMS from this
 * wallet. Free: a signature, not a transaction, which the contract it is
 * for spends in the same call as the transfer — one prompt and one
 * transaction instead of an approval and then the call.
 */
export async function signLmsPermit(wallet: Wallet, lms: Address, spender: Address, value: bigint): Promise<Permit> {
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
    message: { owner: wallet.address, spender, value, nonce, deadline },
  });
  const { r, s, v, yParity } = parseSignature(signature);
  return { deadline, v: Number(v ?? BigInt(yParity + 27)), r, s };
}
