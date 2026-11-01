import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import {
  Action,
  DEFAULT_RULES,
  commitMove,
  commitTypedData,
  hashRules,
  hashTranscript,
  revealTypedData,
  type SealedMove,
  type Transcript,
} from '@lms/consensus';
import { auditTranscript, rankingHash, type ChainRecord, type OwnMove } from '@lms/engine';
import { Room } from '@lms/server';
import { bytes32 } from './helpers.js';
import { TestPlayer } from './players.js';

const CHAIN_ID = 84532;

/**
 * Plays a whole match through a real room with every seat a signed player,
 * the way the gateway feeds it, and returns the transcript the room hands
 * the lobby, plus what seat 0's browser remembers.
 */
async function playSigned(label: string) {
  const players = Array.from({ length: 4 }, (_, i) => new TestPlayer(`${label}:${i}`, CHAIN_ID));
  const grants = await Promise.all(players.map((player) => player.grant()));
  const seats = players.map((player, index) => ({ index, address: player.address, chainId: CHAIN_ID }));
  let transcript: Transcript | null = null;
  const room = new Room(
    { matchId: bytes32(`match:${label}`), seats, seed: bytes32(`seed:${label}`), rules: DEFAULT_RULES },
    { commitMs: 10_000, revealMs: 5_000, botSeats: [], chainId: CHAIN_ID, onFinished: (t) => (transcript = t) },
    0,
  );
  const own = new Map<number, OwnMove>();
  let now = 1;
  while (!room.finished) {
    const round = room.match.round;
    const alive = room.match.alive;
    const moves = new Map<number, SealedMove>();
    for (const seat of alive) {
      const target = alive.find((other) => other !== seat) ?? 0;
      const move = { action: round % 3 === 0 ? Action.Guard : Action.Strike, target, salt: bytes32(`${label}:${round}:${seat}`) };
      moves.set(seat, move);
      const place = { matchId: room.matchId, round, seat };
      const commitment = commitMove(room.matchId, round, seat, move);
      const signature = await players[seat]!.key.signTypedData(commitTypedData(CHAIN_ID, place, commitment));
      room.submitCommit(seats[seat]!.address, commitment, now, undefined, undefined, { grant: grants[seat]!, signature });
      if (seat === 0) own.set(round, { ...move, receipt: { receivedAt: now, signature: '0x' }, revealed: true });
    }
    for (const seat of alive) {
      const place = { matchId: room.matchId, round, seat };
      const move = moves.get(seat)!;
      const signature = await players[seat]!.key.signTypedData(revealTypedData(CHAIN_ID, place, move));
      room.submitReveal(seats[seat]!.address, move, now, undefined, { grant: grants[seat]!, signature });
    }
    now += 1_000;
  }
  if (!transcript) throw new Error('the match never finished');
  return { transcript: transcript as Transcript, own: { seat: 0, moves: own } };
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
