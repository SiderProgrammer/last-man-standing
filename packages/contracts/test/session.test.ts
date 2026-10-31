import { describe, expect, it } from 'vitest';
import { encodeFunctionData } from 'viem';
import { delegationCode, gameEscrowAbi, isDelegatedTo, joinCall, sessionCallKind, withdrawForCall } from '../src/index.js';

const ACCOUNT = '0x00000000000000000000000000000000000000a1' as const;
const TARGET = '0x00000000000000000000000000000000000000b2' as const;

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
