import { describe, expect, it } from 'vitest';
import {
  commitMove,
  DEFAULT_RULES,
  TRANSCRIPT_VERSION,
  hashRules,
  hashTranscript,
  type Move,
  type PublicMatchState,
  type Transcript,
} from '@lms/protocol';
import { Match, rankingHash, type ChainRecord } from '@lms/engine';
import { Prng, readerStrategy } from '@lms/engine/bots';
import { evidenceBundle, evidenceHash, verifyMatch, verifyOnChain } from '../src/game/verify.js';
import { bytes32 } from './helpers.js';

/** Plays a full match and returns what the server would have broadcast. */
function finishedMatch(label: string) {
  const match = new Match({
    matchId: bytes32(`match:${label}`),
    seats: Array.from({ length: 5 }, (_, index) => ({
      index,
      address: `0x${(index + 1).toString(16).padStart(40, '0')}` as `0x${string}`,
      chainId: 11155111,
    })),
    seed: bytes32(`seed:${label}`),
    rules: DEFAULT_RULES,
  });
  const strategy = readerStrategy(new Prng(bytes32(`strategy:${label}`)));
  while (!match.finished) {
    const round = match.round;
    const moves = new Map<number, Move & { salt: `0x${string}` }>();
    for (const seat of match.alive) {
      const move = { ...strategy(seat, match), salt: bytes32(`salt:${label}:${round}:${seat}`) };
      moves.set(seat, move);
      match.submitCommit(seat, commitMove(match.matchId, round, seat, move));
    }
    match.openRevealPhase();
    // Seat 4 goes silent from round 2, so the no-show path is replayed too.
    for (const [seat, move] of moves) if (!(seat === 4 && round > 1)) match.submitReveal(seat, move);
    match.resolve();
  }
  // Every seat a house bot, so nothing in the transcript needs a signature.
  const transcript: Transcript = {
    version: TRANSCRIPT_VERSION,
    matchId: match.matchId,
    chainId: 11155111,
    seed: match.seed,
    rules: match.rules,
    seats: [...match.seats],
    botSeats: match.seats.map((seat) => seat.index),
    receiptSigner: null,
    grants: [],
    rounds: match.history.map((record) => ({ record, proofs: [] })),
    result: match.result(),
  };
  return { state: match.publicState(), result: match.result(), transcript };
}

/** What the escrow would hold for `transcript`, had it been settled honestly. */
function chainFor(transcript: Transcript): ChainRecord {
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

/** A server that answers every transcript request with `body`. */
function serving(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe('in-browser verification', () => {
  it('reproduces a genuine result from the broadcast alone', () => {
    const { state, result } = finishedMatch('genuine');
    const verification = verifyMatch(state, result);
    expect(verification.ok).toBe(true);
    expect(verification.root).toBe(result.historyRoot);
  });

  it('rejects a ranking the rounds did not produce', () => {
    const { state, result } = finishedMatch('ranking');
    const forged = { ...result, ranking: [...result.ranking].reverse() };
    expect(verifyMatch(state, forged)).toMatchObject({ ok: false, reason: expect.stringMatching(/ranking/) });
  });

  it('rejects a history whose published salts were altered', () => {
    const { state, result } = finishedMatch('salts');
    const tampered: PublicMatchState = structuredClone(state);
    const first = tampered.history[0]?.moves[0];
    if (first) first.salt = bytes32('forged');
    expect(verifyMatch(tampered, result)).toMatchObject({ ok: false, reason: expect.stringMatching(/root/) });
  });
});

describe('verification from chain', () => {
  it('fetches the transcript the escrow names and checks it against the escrow', async () => {
    const { transcript } = finishedMatch('chain');
    const requested: string[] = [];
    const fetcher = (async (url: string) => {
      requested.push(url);
      return new Response(JSON.stringify(transcript));
    }) as unknown as typeof fetch;
    const chain = chainFor(transcript);
    const { audit } = await verifyOnChain({ chain, server: 'https://game.test', fetcher });
    expect(requested).toEqual([`https://game.test/transcripts/${chain.transcriptHash}`]);
    expect(audit).toMatchObject({ ok: true, problems: [] });
  });

  it('fails when the server serves another transcript than the escrow stored', async () => {
    const { transcript } = finishedMatch('swap');
    const other = finishedMatch('other').transcript;
    const { audit } = await verifyOnChain({ chain: chainFor(transcript), server: '', fetcher: serving(other) });
    expect(audit.ok).toBe(false);
    expect(audit.problems).toContain('the transcript does not hash to the one the escrow stored');
  });

  it('fails, rather than passing, when the transcript cannot be fetched', async () => {
    const { transcript } = finishedMatch('missing');
    const { audit } = await verifyOnChain({ chain: chainFor(transcript), server: '', fetcher: serving({}, 404) });
    expect(audit.ok).toBe(false);
    expect(audit.problems[0]).toMatch(/could not be fetched: the server answered 404/);
  });

  it('hashes an evidence bundle the same whatever order its fields were built in', () => {
    const audit = { ok: false, problems: ['round 2: something'], root: bytes32('root') };
    const move = { action: 1 as const, target: 2, salt: bytes32('salt') };
    const bundle = evidenceBundle(bytes32('m'), bytes32('t'), audit, { seat: 1, moves: new Map([[2, move]]) });
    expect(bundle.moves).toEqual([{ round: 2, ...move }]);
    // The same bundle with its keys in reverse order, as another parser might hand it back.
    const reversed = (value: object): object =>
      Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, Array.isArray(v) || typeof v !== 'object' || v === null ? v : reversed(v)]));
    const reordered = { ...(reversed(bundle) as typeof bundle), moves: bundle.moves.map((m) => reversed(m)) } as typeof bundle;
    expect(Object.keys(reordered)[0]).toBe('moves');
    expect(evidenceHash(reordered)).toBe(evidenceHash(bundle));
  });
});
