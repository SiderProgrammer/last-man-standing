import { describe, expect, it } from 'vitest';
import { encodeFunctionData, getAddress, keccak256, parseAbi, toBytes } from 'viem';
import { describeCall, descriptionHash, governableAbi, splitDescription } from '../src/index.js';

const ROUTER = getAddress('0x00000000000000000000000000000000000000fe');
const SAFE = getAddress('0x00000000000000000000000000000000000005af');

describe('describeCall', () => {
  it('decodes a known setter and labels the target', () => {
    const data = encodeFunctionData({ abi: governableAbi, functionName: 'setStakerBps', args: [6_000] });

    expect(describeCall(ROUTER, 0n, data, { [ROUTER.toLowerCase()]: 'FeeRouter' })).toEqual({
      target: 'FeeRouter',
      call: 'setStakerBps(6000)',
      value: 0n,
      recognised: true,
    });
  });

  it('recognises the quorum floor and the play-mining settings', () => {
    const calls = [
      encodeFunctionData({ abi: governableAbi, functionName: 'setQuorumFloor', args: [2_000_000n] }),
      encodeFunctionData({ abi: governableAbi, functionName: 'setMaxRewardPerEth', args: [50_000n] }),
      encodeFunctionData({ abi: governableAbi, functionName: 'sweep', args: [SAFE] }),
    ];
    for (const data of calls) {
      expect(describeCall(ROUTER, 0n, data, {}).recognised).toBe(true);
    }
  });

  it('shows struct arguments field by field', () => {
    const data = encodeFunctionData({
      abi: governableAbi,
      functionName: 'setParams',
      args: [
        {
          feeBps: 500,
          minSeats: 4,
          maxSeats: 8,
          joinWindow: 900n,
          settleWindow: 7_200n,
          minStake: 1n,
          maxStake: 2n,
          treasury: SAFE,
        },
      ],
    });

    expect(describeCall(ROUTER, 0n, data).call).toBe(
      `setParams({ feeBps: 500, minSeats: 4, maxSeats: 8, joinWindow: 900, settleWindow: 7200, minStake: 1, maxStake: 2, treasury: ${SAFE} })`,
    );
  });

  it('names timelock roles, so ending the veto reads as what it is', () => {
    const data = encodeFunctionData({
      abi: governableAbi,
      functionName: 'revokeRole',
      args: [keccak256(toBytes('CANCELLER_ROLE')), SAFE],
    });

    expect(describeCall(ROUTER, 0n, data).call).toBe(`revokeRole(CANCELLER_ROLE, ${SAFE})`);
  });

  it('shows an unrecognised call raw, and flags it, rather than hiding it', () => {
    const data = encodeFunctionData({
      abi: parseAbi(['function sweepEverything(address to)']),
      functionName: 'sweepEverything',
      args: [SAFE],
    });

    const described = describeCall(ROUTER, 5n, data);
    expect(described.recognised).toBe(false);
    expect(described.call).toMatch(/^0x[0-9a-f]{8} \+ 32 bytes$/);
    expect(described.value).toBe(5n);
    expect(described.target).toBe(ROUTER);
  });

  it('describes a plain ETH transfer', () => {
    expect(describeCall(SAFE, 10n, '0x').call).toBe('(plain ETH transfer)');
  });
});

describe('descriptions', () => {
  it('takes the first line as the title, without a markdown heading', () => {
    expect(splitDescription('# Raise the staker share\n\nFees are high enough.')).toEqual({
      title: 'Raise the staker share',
      body: 'Fees are high enough.',
    });
    expect(splitDescription('   ').title).toBe('Untitled proposal');
  });

  it('hashes the description as the governor does', () => {
    expect(descriptionHash('Move the guardian')).toBe(keccak256(toBytes('Move the guardian')));
  });
});
