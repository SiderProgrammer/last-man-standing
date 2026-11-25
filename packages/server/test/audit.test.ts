import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import {
  Action,
  NO_COMMITMENT,
  commitTypedData,
  hashRules,
  hashTranscript,
  type Transcript,
} from '@lms/consensus';
import { auditTranscript, moveLogFromHistory, rankingHash, replayMatch, type ChainRecord } from '@lms/engine';
import { bytes32 } from './helpers.js';
import { TestPlayer, playSigned as played } from './players.js';

const CHAIN_ID = 84532;

const playSigned = (label: string, players?: TestPlayer[]) => played(label, CHAIN_ID, players);

/** `transcript` with its result, and every record's hash, made to agree with a replay of its rounds. */
function resettled(transcript: Transcript): Transcript {
  const replay = replayMatch(transcript, moveLogFromHistory(transcript.rounds.map((round) => round.record)));
  return {
    ...transcript,
    rounds: transcript.rounds.map((round, i) => ({ ...round, record: { ...round.record, hash: replay.rounds[i]!.hash } })),
    result: replay.result,
  };
}

function chainOf(transcript: Transcript): ChainRecord {
  return {
    seed: transcript.seed,
    rulesHash: hashRules(transcript.rules),
    seats: transcript.seats.map((seat) => seat.address),
    rounds: transcript.result.rounds,
    historyRoot: transcript.result.historyRoot,
    rankingHash: rankingHash(transcript.result.ranking),
    transcriptHash: hashTranscript(transcript),
  };
}

const clone = (transcript: Transcript): Transcript => JSON.parse(JSON.stringify(transcript)) as Transcript;

describe('transcript audit', () => {
  it('passes an honest match, checked against the chain and the player\'s own moves', async () => {
    const { transcript, own } = await playSigned('honest');
    const audit = await auditTranscript(transcript, { chain: chainOf(transcript), own });
    expect(audit.problems).toEqual([]);
    expect(audit.ok).toBe(true);
    expect(audit.root).toBe(transcript.result.historyRoot);
    // Every seat played under its grant, and the transcript says so.
    expect(transcript.grants).toHaveLength(4);
    expect(transcript.rounds[0]?.proofs.every((proof) => proof.commitSignature && proof.revealSignature)).toBe(true);
  });

  it('refuses a transcript the escrow did not store', async () => {
    const { transcript } = await playSigned('swapped');
    const chain = { ...chainOf(transcript), transcriptHash: keccak256(toHex('another')) };
    const audit = await auditTranscript(transcript, { chain });
    expect(audit.problems).toContain('the transcript does not hash to the one the escrow stored');
  });

  it('refuses a seed, rules or seats the chain does not have', async () => {
    const { transcript } = await playSigned('setup');
    const chain = chainOf(transcript);
    const audit = await auditTranscript(transcript, {
      chain: { ...chain, seed: bytes32('other seed'), rulesHash: bytes32('other rules'), seats: [...chain.seats].reverse() },
    });
    expect(audit.problems).toEqual(
      expect.arrayContaining([
        'the seed is not the one the oracle delivered',
        'the rules are not the ones the lobby was opened under',
        'the seats are not the ones that staked',
      ]),
    );
  });

  it('catches an altered move, even with every hash recomputed to match', async () => {
    const { transcript } = await playSigned('altered');
    const forged = clone(transcript);
    const move = forged.rounds[0]!.record.moves[1]!;
    move.action = Action.Charge;
    move.target = 0;
    const audit = await auditTranscript(forged, { chain: chainOf(forged) });
    expect(audit.ok).toBe(false);
    expect(audit.problems).toContain("round 1: seat 1's reveal does not open its commitment");
    expect(audit.problems).toContain("round 1: seat 1's reveal is not signed by its player");
  });

  it('catches a commitment no key of the seat\'s wallet signed', async () => {
    const { transcript } = await playSigned('forged-commit');
    const forged = clone(transcript);
    const stranger = new TestPlayer('stranger', CHAIN_ID);
    const record = forged.rounds[0]!.record;
    forged.rounds[0]!.proofs[2]!.commitSignature = await stranger.key.signTypedData(
      commitTypedData(CHAIN_ID, { matchId: forged.matchId, round: 1, seat: 2 }, record.moves[2]!.commitment),
    );
    const audit = await auditTranscript(forged);
    expect(audit.problems).toEqual(["round 1: seat 2's commitment is not signed by its player"]);
  });

  it('catches a grant its wallet did not sign', async () => {
    const { transcript } = await playSigned('forged-grant');
    const forged = clone(transcript);
    forged.grants[3]!.signature = (await new TestPlayer('impostor', CHAIN_ID).grant()).signature;
    const audit = await auditTranscript(forged);
    expect(audit.problems[0]).toMatch(/is not signed by/);
    // And so every move under it is unsigned as far as the audit goes.
    expect(audit.problems.some((problem) => problem.includes("seat 3's commitment is not signed"))).toBe(true);
  });

  it('catches a match cut off before it ended', async () => {
    const { transcript } = await playSigned('cut');
    const cut = resettled({ ...clone(transcript), rounds: clone(transcript).rounds.slice(0, 1) });
    const audit = await auditTranscript(cut, { chain: chainOf(cut) });
    expect(audit.problems).toEqual(['the rounds are not a whole match: it did not end with the last of them']);
  });

  it('catches rounds that follow the end of the match', async () => {
    const { transcript } = await playSigned('longer');
    const longer = clone(transcript);
    longer.rounds.push(clone(transcript).rounds.at(-1)!);
    const audit = await auditTranscript(resettled(longer));
    expect(audit.problems).toContain('the rounds are not a whole match: it did not end with the last of them');
  });

  it('catches a round left out, the next one standing in for it', async () => {
    const { transcript } = await playSigned('dropped');
    const dropped = clone(transcript);
    dropped.rounds.splice(1, 1);
    const audit = await auditTranscript(resettled(dropped));
    expect(audit.problems).toContain('round 2 is not recorded as its moves play out');
  });

  it('catches a seat named twice, which would re-roll the round under its signed move', async () => {
    const { transcript } = await playSigned('twice');
    const twice = clone(transcript);
    const { moves } = twice.rounds[0]!.record;
    moves.push({ ...moves[0]!, commitment: NO_COMMITMENT });
    const audit = await auditTranscript(resettled(twice));
    expect(audit.problems).toContain('round 1 is not recorded as its moves play out');
  });

  it('catches seats passed off as house bots in a staked match, so that nothing need be signed', async () => {
    const { transcript } = await playSigned('bots');
    const forged: Transcript = {
      ...clone(transcript),
      botSeats: [0, 1, 2, 3],
      grants: [],
      rounds: transcript.rounds.map((round) => ({ ...round, proofs: [] })),
    };
    const audit = await auditTranscript(forged, { chain: chainOf(forged) });
    expect(audit.problems).toEqual(['the transcript names house bots, which a staked match never seats']);
  });

  it('passes two wallets that granted the same key, and still tells their seats apart', async () => {
    const [a, b, c, d] = Array.from({ length: 4 }, (_, i) => new TestPlayer(`shared:${i}`, CHAIN_ID)) as [TestPlayer, TestPlayer, TestPlayer, TestPlayer];
    const twin = Object.assign(new TestPlayer('shared:1', CHAIN_ID), { key: a.key });
    const { transcript } = await playSigned('shared', [a, twin, c, d]);
    expect(b.address).toBe(twin.address);
    expect(transcript.grants).toHaveLength(4);
    expect((await auditTranscript(transcript, { chain: chainOf(transcript) })).problems).toEqual([]);

    // The shared key speaks only for the wallets that granted it.
    const without = clone(transcript);
    without.grants = without.grants.filter((signed) => signed.grant.wallet !== a.address);
    const audit = await auditTranscript(without);
    expect(audit.problems).toContain("round 1: seat 0's commitment is not signed by its player");
    expect(audit.problems.some((problem) => problem.includes('seat 1'))).toBe(false);
  });

  it('catches a receipted commitment that was left out, and a counted-out reveal', async () => {
    const { transcript, own } = await playSigned('own');
    const forged = clone(transcript);
    const first = forged.rounds[0]!.record.moves[0]!;
    first.revealed = false;
    const second = forged.rounds[1]!.record.moves[0]!;
    second.commitment = bytes32('nothing');
    second.revealed = false;
    const audit = await auditTranscript(forged, { own });
    expect(audit.problems).toEqual(
      expect.arrayContaining([
        'round 1: you revealed, and the transcript counts you as not revealing',
        'round 2: the server receipted your commitment, and the transcript leaves it out',
      ]),
    );
  });
});
