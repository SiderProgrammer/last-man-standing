import { describe, expect, it } from 'vitest';
import { encodeFunctionData, hashTypedData } from 'viem';
import { gameEscrowAbi } from '../src/chain/abis.js';
import {
  delegationCode,
  isDelegatedTo,
  joinCall,
  sessionCallDigest,
  sessionCallKind,
  sessionCallTypedData,
  withdrawForCall,
} from '../src/chain/session.js';

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

describe('sessionCallKind', () => {
  const ESCROW = TARGET;
  const scope = { escrow: ESCROW, account: ACCOUNT };
  const MATCH = `0x${'cd'.repeat(32)}` as const;

  it('names a join and a withdrawal for the account', () => {
    expect(sessionCallKind(joinCall(ESCROW, MATCH, 10n ** 15n), scope)).toBe('join');
    expect(sessionCallKind(withdrawForCall(ESCROW, ACCOUNT), scope)).toBe('withdrawFor');
  });

  it('refuses what the delegate refuses', () => {
    // Another contract.
    expect(sessionCallKind(joinCall(ACCOUNT, MATCH, 1n), scope)).toBeNull();
    // A withdrawal that pays someone else, or carries value.
    expect(sessionCallKind(withdrawForCall(ESCROW, ESCROW), scope)).toBeNull();
    expect(sessionCallKind({ ...withdrawForCall(ESCROW, ACCOUNT), value: 1n }, scope)).toBeNull();
    // Any other escrow call, and trailing bytes after a join.
    const withdraw = encodeFunctionData({ abi: gameEscrowAbi, functionName: 'withdraw', args: [ESCROW] });
    expect(sessionCallKind({ target: ESCROW, value: 0n, data: withdraw }, scope)).toBeNull();
    const join = joinCall(ESCROW, MATCH, 1n);
    expect(sessionCallKind({ ...join, data: `${join.data}00` }, scope)).toBeNull();
    expect(sessionCallKind({ target: ESCROW, value: 1n, data: '0x' }, scope)).toBeNull();
  });
});

describe('delegation code', () => {
  it('is the 7702 designator followed by the delegate', () => {
    expect(delegationCode(TARGET)).toBe(`0xef0100${TARGET.slice(2)}`);
    expect(isDelegatedTo(`0xEF0100${TARGET.slice(2).toUpperCase()}`, TARGET)).toBe(true);
    expect(isDelegatedTo(delegationCode(ACCOUNT), TARGET)).toBe(false);
    expect(isDelegatedTo('0x', TARGET)).toBe(false);
    expect(isDelegatedTo(undefined, TARGET)).toBe(false);
  });
});
