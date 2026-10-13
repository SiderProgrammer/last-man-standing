import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { describeCall, type ProtocolParams } from '@lms/protocol';
import {
  ACTION_TEMPLATES,
  buildAction,
  proposalDescription,
  proposalProblem,
  type ProposalContext,
} from '../src/ui/proposalBuilder.js';

const at = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const SAFE = at(0x5af);

const PARAMS: ProtocolParams = {
  feeBps: 500,
  minSeats: 4,
  maxSeats: 8,
  joinWindow: 900n,
  settleWindow: 7_200n,
  minStake: 1_000_000_000_000_000n,
  maxStake: 1_000_000_000_000_000_000n,
  treasury: at(0xfe),
};

const CONTEXT: ProposalContext = {
  governor: at(0x60),
  timelock: at(0x71),
  vault: at(0x5a),
  feeRouter: at(0xfe),
  escrow: at(0xe5),
  config: at(0xc0),
  params: PARAMS,
};

/** Builds an action and shows it the way a voter will read it. */
function described(template: string, values: Record<string, string>): string {
  const result = buildAction(template, values, CONTEXT);
  if (!result.ok) throw new Error(result.error);
  const { target, call } = describeCall(result.action.target, result.action.value, result.action.calldata, {
    [CONTEXT.feeRouter!.toLowerCase()]: 'FeeRouter',
    [CONTEXT.config!.toLowerCase()]: 'ProtocolConfig',
    [CONTEXT.vault.toLowerCase()]: 'StakedLms',
    [CONTEXT.governor.toLowerCase()]: 'LmsGovernor',
    [CONTEXT.timelock.toLowerCase()]: 'Timelock',
    [CONTEXT.escrow!.toLowerCase()]: 'GameEscrow',
  });
  return `${target}.${call}`;
}

function error(template: string, values: Record<string, string>, context = CONTEXT): string {
  const result = buildAction(template, values, context);
  if (result.ok) throw new Error('expected a validation error');
  return result.error;
}

describe('buildAction', () => {
  it('encodes each template as the one call it describes', () => {
    expect(described('stakerShare', { percent: '60' })).toBe('FeeRouter.setStakerBps(6000)');
    expect(described('treasury', { to: SAFE })).toBe(`FeeRouter.setTreasury(${SAFE})`);
    expect(described('guardian', { to: SAFE })).toBe(`ProtocolConfig.setGuardian(${SAFE})`);
    expect(described('cooldown', { days: '14' })).toBe('StakedLms.setCooldown(1209600)');
    expect(described('votingPeriod', { days: '3' })).toBe('LmsGovernor.setVotingPeriod(259200)');
    expect(described('unpause', {})).toBe('GameEscrow.unpause()');
    expect(described('removeVeto', { account: SAFE })).toBe(`Timelock.revokeRole(CANCELLER_ROLE, ${SAFE})`);
  });

  it('changes only the fee when setting the protocol fee, resending the rest as it is', () => {
    expect(described('protocolFee', { percent: '2.5' })).toBe(
      `ProtocolConfig.setParams({ feeBps: 250, minSeats: 4, maxSeats: 8, joinWindow: 900, settleWindow: 7200, ` +
        `minStake: 1000000000000000, maxStake: 1000000000000000000, treasury: ${PARAMS.treasury} })`,
    );
  });

  it('enforces the limits the contracts enforce, before a vote is wasted on them', () => {
    expect(error('protocolFee', { percent: '10.01' })).toBe('At most 10%.');
    expect(error('stakerShare', { percent: '101' })).toBe('At most 100%.');
    expect(error('cooldown', { days: '31' })).toBe('Between 1 and 30 days.');
    expect(error('cooldown', { days: '0' })).toBe('Between 1 and 30 days.');
  });

  it('rejects malformed input', () => {
    expect(error('stakerShare', { percent: '1.234' })).toMatch(/two decimals/);
    expect(error('stakerShare', { percent: '-5' })).toMatch(/percentage/);
    expect(error('treasury', { to: '0x123' })).toBe('Enter a valid address.');
    expect(error('cooldown', { days: '7.5' })).toBe('Enter a whole number of days.');
    expect(error('custom', { target: SAFE, calldata: 'deadbeef' })).toMatch(/hex/);
    expect(error('custom', { target: SAFE, calldata: '0x', eth: 'lots' })).toMatch(/ETH/);
    expect(error('nope', {})).toBe('Choose an action.');
  });

  it('says so when this deployment lacks the contract a template needs', () => {
    expect(error('stakerShare', { percent: '50' }, { ...CONTEXT, feeRouter: null })).toMatch(/no fee router/);
    expect(error('protocolFee', { percent: '5' }, { ...CONTEXT, params: null })).toMatch(/current parameters/);
  });

  it('passes a custom call through untouched, ETH included', () => {
    const result = buildAction('custom', { target: SAFE, calldata: '0xdeadbeef', eth: '1.5' }, CONTEXT);
    expect(result).toEqual({
      ok: true,
      action: { target: SAFE, value: 1_500_000_000_000_000_000n, calldata: '0xdeadbeef' },
    });
  });

  it('has a template for every case the builder handles', () => {
    for (const template of ACTION_TEMPLATES) {
      expect(buildAction(template.id, {}, CONTEXT)).not.toEqual({ ok: false, error: 'Choose an action.' });
    }
  });
});

describe('proposal text', () => {
  it('stores the title as a heading the cards read back', () => {
    expect(proposalDescription(' Raise fees ', '  Because.  ')).toBe('# Raise fees\n\nBecause.');
    expect(proposalDescription('Raise fees', '')).toBe('# Raise fees');
  });

  it('needs a one-line title and at least one action', () => {
    const action = { target: SAFE, value: 0n, calldata: '0x' as const };
    expect(proposalProblem('', [action])).toBe('Give the proposal a title.');
    expect(proposalProblem('Title', [])).toBe('Add at least one action.');
    expect(proposalProblem('Two\nlines', [action])).toBe('Keep the title to one line.');
    expect(proposalProblem('#1 priority', [action])).toBeNull();
  });
});
