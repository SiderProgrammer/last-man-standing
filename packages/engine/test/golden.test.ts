import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NO_COMMITMENT,
  hashRound,
  hashRules,
  hashTranscript,
  type RoundRecord,
  type Transcript,
} from '@lms/protocol';
import { Match, auditTranscript, moveLogFromHistory, rankingHash, replayMatch } from '@lms/engine';

/**
 * Frozen whole-match transcripts, written once by `scripts/gen-golden.mjs`.
 *
 * Each is replayed here twice, by the live state machine (`Match`, fed the
 * same commits and reveals) and by the independent replay (`replayMatch`),
 * and both must reproduce every round record and the result exactly. The
 * Solidity side (`GoldenTranscript.t.sol`) rebuilds every round hash and the
 * root from the same file. `Match` and `replay` stay two implementations on
 * purpose (TODO §3.4); these transcripts are what holds them to one answer.
 *
 * The hashes below are pinned as well as the files, so regenerating the
 * fixtures shows up in review as a change to this test, not just to data.
 */
interface Golden {
  transcriptHash: `0x${string}`;
  transcript: Transcript;
  chain: { rulesHash: `0x${string}`; rounds: Array<{ hash: `0x${string}` }> };
}

const PINNED = {
  'four-seats': {
    rounds: 13,
    historyRoot: '0x244a13608cf7970238b69d8e15a9df878e50ddfb8c24da56c4ec6b4d3e59cba3',
  },
  'eight-seats': {
    rounds: 22,
    historyRoot: '0x848eb95b10fe926fa9b9c0d19f775d229ae0633c2f21f9dd22f529cda4f7c219',
  },
} as const;

function load(name: keyof typeof PINNED): Golden {
  const file = new URL(`../../../contracts/test/fixtures/golden/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(file, 'utf8')) as Golden;
}

function setupOf(transcript: Transcript) {
  return { matchId: transcript.matchId, seats: transcript.seats, seed: transcript.seed, rules: transcript.rules };
}

describe.each(Object.keys(PINNED) as Array<keyof typeof PINNED>)('golden transcript %s', (name) => {
  const golden = load(name);
  const { transcript } = golden;
  const records = transcript.rounds.map((round) => round.record);

  it('is the frozen match', () => {
    expect(transcript.result.rounds).toBe(PINNED[name].rounds);
    expect(transcript.result.historyRoot).toBe(PINNED[name].historyRoot);
    expect(hashTranscript(transcript)).toBe(golden.transcriptHash);
    expect(hashRules(transcript.rules)).toBe(golden.chain.rulesHash);
  });

  it('replays through Match, fed the same commits and reveals', () => {
    const match = new Match(setupOf(transcript));
    const replayed: RoundRecord[] = [];
    for (const record of records) {
      for (const move of record.moves) {
        if (move.commitment !== NO_COMMITMENT) match.submitCommit(move.index, move.commitment);
      }
      match.openRevealPhase();
      for (const move of record.moves) {
        if (move.revealed) match.submitReveal(move.index, { action: move.action, target: move.target, salt: move.salt });
      }
      replayed.push(match.resolve());
    }
    expect(replayed).toEqual(records);
    expect(match.result()).toEqual(transcript.result);
  });

  it('replays through replayMatch to the same rounds and result', () => {
    const { result, rounds } = replayMatch(setupOf(transcript), moveLogFromHistory(records));
    expect(rounds).toEqual(records);
    expect(result).toEqual(transcript.result);
  });

  it('gives the Solidity side the round hashes the records carry', () => {
    expect(golden.chain.rounds.map((round) => round.hash)).toEqual(records.map((record) => record.hash));
    records.forEach((record) => expect(hashRound(record.round, transcript.seats.length, record)).toBe(record.hash));
  });

  it('passes the audit a browser runs, signatures and all', async () => {
    const audit = await auditTranscript(transcript, {
      chain: {
        seed: transcript.seed,
        rulesHash: hashRules(transcript.rules),
        seats: transcript.seats.map((seat) => seat.address),
        rounds: transcript.result.rounds,
        historyRoot: transcript.result.historyRoot,
        rankingHash: rankingHash(transcript.result.ranking),
        transcriptHash: golden.transcriptHash,
      },
    });
    expect(audit.problems).toEqual([]);
  });
});
