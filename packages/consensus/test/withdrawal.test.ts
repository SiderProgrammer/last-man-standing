import { describe, expect, it } from 'vitest';
import { hashTypedData, type Address } from 'viem';
import { WITHDRAWAL_TYPES, withdrawalDomain } from '@lms/consensus';

const PLAYER: Address = `0x${'aa'.repeat(20)}`;

describe('withdrawal typed data', () => {
  /**
   * Frozen, and the same vector as `BridgeJoinReceiver.t.sol`'s
   * `test_withdrawalDigest_frozenVector`: what a wallet signs here is what the
   * receiver checks.
   */
  it('hashes to the digest the receiver checks', () => {
    const digest = hashTypedData({
      domain: withdrawalDomain(`0x${'11'.repeat(20)}`),
      types: WITHDRAWAL_TYPES,
      primaryType: 'Withdrawal',
      message: {
        player: PLAYER,
        hubChainId: 84532n,
        destinationChainId: 421614n,
        recipient: `0x${'bb'.repeat(20)}`,
        outputToken: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73',
        maxFee: 10n ** 15n,
        nonce: 3n,
        deadline: 1_800_000_000n,
      },
    });
    expect(digest).toBe('0x5c24035ab95701f0bcca63331fc1c2ba82b5cb6496e7c6b90d93b33359b63b13');
  });
});
