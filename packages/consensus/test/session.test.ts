import { describe, expect, it } from 'vitest';
import { hashTypedData } from 'viem';
import { sessionCallDigest, sessionCallTypedData } from '@lms/consensus';

const ACCOUNT = '0x00000000000000000000000000000000000000a1' as const;
const TARGET = '0x00000000000000000000000000000000000000b2' as const;

/**
 * Frozen vector, pinned against `SessionKeyDelegate.callDigest` in
 * `contracts/test/unit/SessionKeyDelegate.t.sol`. If the two ever diverge, a
 * session key's signature stops recovering on-chain and every relayed call
 * fails — so, as with the commit hashes, a change here must fail exactly one of
 * the two suites rather than drift silently.
 */
const VECTOR = {
  account: ACCOUNT,
  chainId: 11155111,
  target: TARGET,
  value: 1_000_000_000_000_000n,
  data: '0xdeadbeef',
  nonce: 7n,
} as const;

const EXPECTED = '0xe0bb7f95c30aa264279556d9c60946f8e8fafb1468bbcd98dc74c8c0b13a5075';

describe('sessionCallDigest', () => {
  it('matches the frozen vector the Solidity side is pinned to', () => {
    expect(sessionCallDigest(VECTOR)).toBe(EXPECTED);
  });

  /** The account is the verifying contract, so two players never share a digest. */
  it('binds the digest to the account', () => {
    const other = sessionCallDigest({ ...VECTOR, account: TARGET });
    expect(other).not.toBe(EXPECTED);
  });

  it('binds the digest to the chain', () => {
    expect(sessionCallDigest({ ...VECTOR, chainId: 1 })).not.toBe(EXPECTED);
  });

  it('covers the target, value, calldata and nonce', () => {
    expect(sessionCallDigest({ ...VECTOR, target: ACCOUNT })).not.toBe(EXPECTED);
    expect(sessionCallDigest({ ...VECTOR, value: 0n })).not.toBe(EXPECTED);
    expect(sessionCallDigest({ ...VECTOR, data: '0xdeadbeff' })).not.toBe(EXPECTED);
    expect(sessionCallDigest({ ...VECTOR, nonce: 8n })).not.toBe(EXPECTED);
  });
});

describe('sessionCallTypedData', () => {
  /** What a wallet or key signs is the digest the delegate recovers from. */
  it('hashes to the same digest as the hand-built one', () => {
    expect(hashTypedData(sessionCallTypedData(VECTOR))).toBe(EXPECTED);
  });
});
