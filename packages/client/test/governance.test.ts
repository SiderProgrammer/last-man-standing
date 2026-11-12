import { describe, expect, it } from 'vitest';
import { encodeFunctionData, getAddress } from 'viem';
import { ProposalState, governableAbi, type ProposalSummary } from '@lms/contracts';
import { plainCall, proposalCard, proposalIdHex, type ProposalLive } from '../src/ui/governance.js';

const E18 = 10n ** 18n;
const NOW = 1_700_000_000;
const ROUTER = getAddress('0x00000000000000000000000000000000000000fe');

const SUMMARY: ProposalSummary = {
  id: '123456789012345678901234567890',
  proposer: `0x${'aa'.repeat(20)}`,
  targets: [ROUTER],
  values: ['0'],
  calldatas: [encodeFunctionData({ abi: governableAbi, functionName: 'setStakerBps', args: [6_000] })],
  description: '# Raise the staker share\n\nFees have grown.',
  voteStart: NOW - 100,
  voteEnd: NOW + 3 * 86_400,
  block: 1,
};

function live(overrides: Partial<ProposalLive> = {}): ProposalLive {
  return {
    state: ProposalState.Active,
    votes: { for: 6_000n * E18, against: 3_000n * E18, abstain: 1_000n * E18 },
    quorum: 8_000n * E18,
    power: 500n * E18,
    hasVoted: false,
    eta: 0,
    chainTime: NOW,
    ...overrides,
  };
}

describe('proposalCard', () => {
  it('shows the title, body and decoded actions even without a wallet', () => {
    const card = proposalCard(SUMMARY, null, { [ROUTER.toLowerCase()]: 'FeeRouter' });

    expect(card.title).toBe('Raise the staker share');
    expect(card.body).toBe('Fees have grown.');
    expect(card.actions).toEqual([{ target: 'FeeRouter', call: 'setStakerBps(6000)', warning: null, plain: 'Give stakers 60% of every match fee' }]);
    expect(card.you).toBe('Connect a wallet to see the result and vote.');
    expect(card.canVote).toBe(false);
  });

  it('shows an active vote: tallies, quorum progress and the voter\'s power', () => {
    const card = proposalCard(SUMMARY, live(), {});

    expect(card.state).toEqual({ label: 'Active', tone: 'live' });
    expect(card.window).toBe('Voting closes in 3d.');
    expect(card.tally?.shares).toEqual({ for: 60, against: 30, abstain: 10 });
    // For and Abstain count towards quorum; Against does not.
    expect(card.quorum).toBe('Quorum: 7,000 of 8,000 sLMS (87%), counting For and Abstain.');
    expect(card.you).toBe('Your voting power: 500 sLMS.');
    expect(card.canVote).toBe(true);
  });

  it('closes the vote for someone who already voted or had no power at the snapshot', () => {
    expect(proposalCard(SUMMARY, live({ hasVoted: true }), {}).canVote).toBe(false);

    const powerless = proposalCard(SUMMARY, live({ power: 0n }), {});
    expect(powerless.canVote).toBe(false);
    expect(powerless.you).toMatch(/no staked LMS when voting opened/);
  });

  it('explains a pending proposal in terms of power held now', () => {
    const card = proposalCard(
      { ...SUMMARY, voteStart: NOW + 3_600 },
      live({ state: ProposalState.Pending, quorum: null, votes: { for: 0n, against: 0n, abstain: 0n } }),
      {},
    );

    expect(card.window).toBe('Voting opens in 1h.');
    expect(card.quorum).toBe('Quorum is fixed when voting opens.');
    expect(card.you).toBe('You will vote with the 500 sLMS you hold when voting opens.');
    expect(card.canVote).toBe(false);
  });

  it('gives a pending vote a visible, closed button that says when it opens', () => {
    const card = proposalCard(
      { ...SUMMARY, voteStart: NOW + 86_400 },
      live({ state: ProposalState.Pending, quorum: null }),
      {},
    );
    expect(card.voteOpens).toBe('Voting opens in 1d');
    expect(card.canVote).toBe(false);
    expect(proposalCard(SUMMARY, live(), {}).voteOpens).toBeNull();
  });

  it('always shows when the vote opens and closes', () => {
    expect(proposalCard(SUMMARY, null, {}).timeline).toMatch(/^Voting .+ → .+$/);
  });

  it('times the vote by the clock, and says why, when the chain cannot be read', () => {
    const card = proposalCard(SUMMARY, null, {}, { now: NOW, reason: 'Switch your wallet to Base to see the result and vote.' });
    expect(card.window).toBe('Voting closes in 3d.');
    expect(card.you).toBe('Switch your wallet to Base to see the result and vote.');
    expect(proposalCard(SUMMARY, null, {}, { now: NOW + 4 * 86_400, reason: '' }).window).toBe('Voting has closed.');
  });

  it('offers queue once passed, and execute only after the timelock delay', () => {
    expect(proposalCard(SUMMARY, live({ state: ProposalState.Succeeded }), {}).canQueue).toBe(true);

    const waiting = proposalCard(SUMMARY, live({ state: ProposalState.Queued, eta: NOW + 86_400 }), {});
    expect(waiting.canExecute).toBe(false);
    expect(waiting.window).toBe('In the timelock: executable in 1d. The Safe can still veto it.');

    const ready = proposalCard(SUMMARY, live({ state: ProposalState.Queued, eta: NOW }), {});
    expect(ready.canExecute).toBe(true);
  });

  it('warns about calls it cannot decode and about ETH sent', () => {
    const card = proposalCard({ ...SUMMARY, values: ['1000000000000000000'], calldatas: ['0xdeadbeef'] }, null, {});

    expect(card.actions[0]?.warning).toBe(
      'Not a recognised governance call — check the target and data yourself. Sends 1 ETH.',
    );
  });
});

describe('proposal wording', () => {
  it('shows the id in hex, as the CLI and explorers do', () => {
    expect(proposalIdHex('255')).toBe('0xff');
    expect(proposalCard(SUMMARY, null, {}).byline).toMatch(/^0x18ee…/);
  });

  it('says which way a defeated proposal failed', () => {
    const defeated = (votes: ProposalLive['votes']) =>
      proposalCard(SUMMARY, live({ state: ProposalState.Defeated, votes }), {}).window;
    expect(defeated({ for: 1_000n * E18, against: 0n, abstain: 0n })).toBe(
      'Did not pass: quorum was not reached (1,000 of 8,000 sLMS).',
    );
    expect(defeated({ for: 9_000n * E18, against: 9_000n * E18, abstain: 0n })).toBe(
      'Did not pass: no more voted for than against.',
    );
    expect(defeated({ for: 0n, against: 1n * E18, abstain: 0n })).toBe(
      'Did not pass: quorum was not reached, and no more voted for than against.',
    );
  });
});

describe('proposal lifecycle and plain words', () => {
  it('lights the step a proposal is on, and marks where one stopped', () => {
    const steps = (state: ProposalLive['state']) =>
      proposalCard(SUMMARY, live({ state }), {}).steps.map((step) => `${step.label}:${step.state}`);
    expect(steps(ProposalState.Active)).toEqual(['Pending:done', 'Voting:current', 'Passed:todo', 'Queued:todo', 'Executed:todo']);
    expect(steps(ProposalState.Executed)).toEqual(['Pending:done', 'Voting:done', 'Passed:done', 'Queued:done', 'Executed:done']);
    expect(steps(ProposalState.Defeated)).toEqual(['Pending:done', 'Voting:done', 'Defeated:failed', 'Queued:todo', 'Executed:todo']);
  });

  it('says which side you voted on, with your reason', () => {
    expect(proposalCard(SUMMARY, live({ hasVoted: true, vote: { support: 0, reason: 'Too high' } }), {}).you).toBe(
      'You voted Against: “Too high”',
    );
    expect(proposalCard(SUMMARY, live({ hasVoted: true, vote: { support: 2, reason: '' } }), {}).you).toBe('You abstained.');
    expect(proposalCard(SUMMARY, live({ hasVoted: true }), {}).you).toBe('You voted on this proposal.');
  });

  it('puts each action in words, flagging the risky ones', () => {
    expect(plainCall(SUMMARY.calldatas[0]!, null).text).toBe('Give stakers 60% of every match fee');
    const zeroGuardian = plainCall(
      encodeFunctionData({ abi: governableAbi, functionName: 'setGuardian', args: ['0x0000000000000000000000000000000000000000'] }),
      null,
    );
    expect(zeroGuardian.text).toBe('Remove the emergency guardian');
    expect(zeroGuardian.warnings[0]).toMatch(/nobody can pause/);
  });

  it('says only what a setParams changes, against the parameters now', () => {
    const now = {
      feeBps: 500,
      minSeats: 4,
      maxSeats: 8,
      joinWindow: 600n,
      settleWindow: 3_600n,
      minStake: E18 / 1000n,
      maxStake: E18,
      treasury: ROUTER,
    };
    const data = encodeFunctionData({ abi: governableAbi, functionName: 'setParams', args: [{ ...now, feeBps: 250 }] });
    expect(plainCall(data, now).text).toBe('Set the protocol fee to 2.5%');
  });

  it('flags the same call twice in one proposal', () => {
    const twice = { ...SUMMARY, targets: [ROUTER, ROUTER], values: ['0', '0'], calldatas: [SUMMARY.calldatas[0]!, SUMMARY.calldatas[0]!] };
    expect(proposalCard(twice, null, {}).actions[1]?.warning).toMatch(/same call again/);
  });
});
