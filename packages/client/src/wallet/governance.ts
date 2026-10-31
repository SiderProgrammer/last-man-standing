import type { Address, Hex } from 'viem';
import {
  ProposalState,
  descriptionHash,
  gameEscrowAbi,
  lmsGovernorAbi,
  protocolConfigAbi,
  stakedLmsAbi,
  type ProposalStateValue,
  type ProposalSummary,
  type ProtocolParams,
  type VoteSupportValue,
} from '@lms/protocol';
import type { ProposalLive } from '../ui/governance.js';
import type { ProposalAction, ProposalContext } from '../ui/proposalBuilder.js';
import type { Wallet } from './wallet.js';

/**
 * The governor, through the player's own wallet: proposals, votes, and
 * moving a passed proposal through the timelock. Loaded with the governance
 * screen, so the governor's ABIs stay out of the main bundle.
 */

/**
 * A proposal's state and this wallet's part in it.
 *
 * Voting power and quorum are fixed at the snapshot, which is the vote's
 * start. While that is still ahead the governor refuses to look it up, so a
 * pending proposal shows the wallet's power now, read from the vault.
 */
export async function proposalLive(wallet: Wallet, governor: Address, vault: Address, proposal: ProposalSummary): Promise<ProposalLive> {
  const id = BigInt(proposal.id);
  const [state, [against, forVotes, abstain], hasVoted, eta, block] = await Promise.all([
    wallet.rpc.readContract({ address: governor, abi: lmsGovernorAbi, functionName: 'state', args: [id] }),
    wallet.rpc.readContract({ address: governor, abi: lmsGovernorAbi, functionName: 'proposalVotes', args: [id] }),
    wallet.rpc.readContract({
      address: governor,
      abi: lmsGovernorAbi,
      functionName: 'hasVoted',
      args: [id, wallet.address],
    }),
    wallet.rpc.readContract({ address: governor, abi: lmsGovernorAbi, functionName: 'proposalEta', args: [id] }),
    wallet.rpc.getBlock(),
  ]);
  const pending = state === ProposalState.Pending;
  const snapshot = BigInt(proposal.voteStart);
  const [power, quorum] = pending
    ? [
        await wallet.rpc.readContract({ address: vault, abi: stakedLmsAbi, functionName: 'getVotes', args: [wallet.address] }),
        null,
      ]
    : await Promise.all([
        wallet.rpc.readContract({
          address: governor,
          abi: lmsGovernorAbi,
          functionName: 'getVotes',
          args: [wallet.address, snapshot],
        }),
        wallet.rpc.readContract({ address: governor, abi: lmsGovernorAbi, functionName: 'quorum', args: [snapshot] }),
      ]);
  return {
    state: state as ProposalStateValue,
    votes: { for: forVotes, against, abstain },
    quorum,
    power,
    hasVoted,
    eta: Number(eta),
    chainTime: Number(block.timestamp),
  };
}

/** Votes on a proposal, with a reason recorded on-chain when one is given. */
export async function castVote(wallet: Wallet, governor: Address, proposalId: string, support: VoteSupportValue, reason: string): Promise<Hex> {
  const chain = await wallet.onHub();
  const id = BigInt(proposalId);
  if (reason.trim()) {
    const { request } = await wallet.rpc.simulateContract({
      account: wallet.address,
      address: governor,
      abi: lmsGovernorAbi,
      functionName: 'castVoteWithReason',
      args: [id, support, reason.trim()],
    });
    return wallet.client.writeContract({ ...request, chain });
  }
  const { request } = await wallet.rpc.simulateContract({
    account: wallet.address,
    address: governor,
    abi: lmsGovernorAbi,
    functionName: 'castVote',
    args: [id, support],
  });
  return wallet.client.writeContract({ ...request, chain });
}

/**
 * Everything the proposal form needs: where each governed contract is, the
 * config's current parameters, and whether this wallet may propose at all.
 *
 * The governor checks the proposer's votes one second in the past, so that
 * is the number compared against the threshold here too.
 */
export async function proposalContext(wallet: Wallet, 
  governor: Address,
  known: Pick<ProposalContext, 'vault' | 'feeRouter' | 'escrow'>,
): Promise<{ context: ProposalContext; power: bigint; threshold: bigint }> {
  const [timelock, threshold, clock, config] = await Promise.all([
    wallet.rpc.readContract({ address: governor, abi: lmsGovernorAbi, functionName: 'timelock' }),
    wallet.rpc.readContract({ address: governor, abi: lmsGovernorAbi, functionName: 'proposalThreshold' }),
    wallet.rpc.readContract({ address: governor, abi: lmsGovernorAbi, functionName: 'clock' }),
    known.escrow
      ? wallet.rpc.readContract({ address: known.escrow, abi: gameEscrowAbi, functionName: 'config' })
      : Promise.resolve(null),
  ]);
  const [power, params] = await Promise.all([
    clock > 0
      ? wallet.rpc.readContract({
          address: governor,
          abi: lmsGovernorAbi,
          functionName: 'getVotes',
          args: [wallet.address, BigInt(clock - 1)],
        })
      : Promise.resolve(0n),
    config
      ? wallet.rpc.readContract({ address: config, abi: protocolConfigAbi, functionName: 'getParams' })
      : Promise.resolve(null),
  ]);
  return {
    context: { governor, timelock, config, params: params as ProtocolParams | null, ...known },
    power,
    threshold,
  };
}

/** Submits a proposal. Simulated first, so a missing threshold reads as the governor's own error. */
export async function propose(wallet: Wallet, governor: Address, actions: readonly ProposalAction[], description: string): Promise<Hex> {
  const chain = await wallet.onHub();
  const { request } = await wallet.rpc.simulateContract({
    account: wallet.address,
    address: governor,
    abi: lmsGovernorAbi,
    functionName: 'propose',
    args: [
      actions.map((action) => action.target),
      actions.map((action) => action.value),
      actions.map((action) => action.calldata),
      description,
    ],
  });
  return wallet.client.writeContract({ ...request, chain });
}

/**
 * Queues a passed proposal in the timelock, or executes a queued one once
 * its delay is over. Both are open to anyone; the governor re-derives the
 * proposal from exactly these arguments, so they must match what was proposed.
 */
export async function advanceProposal(wallet: Wallet, governor: Address, proposal: ProposalSummary, step: 'queue' | 'execute'): Promise<Hex> {
  const chain = await wallet.onHub();
  const args = [
    proposal.targets,
    proposal.values.map((value) => BigInt(value)),
    proposal.calldatas,
    descriptionHash(proposal.description),
  ] as const;
  if (step === 'queue') {
    const { request } = await wallet.rpc.simulateContract({
      account: wallet.address,
      address: governor,
      abi: lmsGovernorAbi,
      functionName: 'queue',
      args,
    });
    return wallet.client.writeContract({ ...request, chain });
  }
  const { request } = await wallet.rpc.simulateContract({
    account: wallet.address,
    address: governor,
    abi: lmsGovernorAbi,
    functionName: 'execute',
    args,
  });
  return wallet.client.writeContract({ ...request, chain });
}
