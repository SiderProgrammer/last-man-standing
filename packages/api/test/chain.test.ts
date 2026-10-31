import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { withdrawalFromWire, withdrawalToWire } from '@lms/api';

const PLAYER: Address = `0x${'aa'.repeat(20)}`;
/** WETH on Base Sepolia. */
const WETH: Address = '0x4200000000000000000000000000000000000006';

describe('withdrawal over the wire', () => {
  it('survives the trip as decimal strings', () => {
    const withdrawal = {
      player: PLAYER,
      hubChainId: 8453n,
      destinationChainId: 42161n,
      recipient: PLAYER,
      outputToken: WETH,
      maxFee: 12_345n,
      nonce: 7n,
      deadline: 1_793_403_468n,
    };
    const wire = JSON.parse(JSON.stringify(withdrawalToWire(withdrawal)));
    expect(withdrawalFromWire(wire)).toEqual(withdrawal);
  });
});
