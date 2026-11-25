import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  NO_COMMITMENT,
  commitMove,
  commitTypedData,
  DEFAULT_RULES,
  grantTypedData,
  TRANSCRIPT_VERSION,
  hashRules,
  hashTranscript,
  revealTypedData,
  type Move,
  type PublicMatchState,
  type Transcript,
} from '@lms/consensus';
import { Match, moveLogFromHistory, rankingHash, replayMatch, type ChainRecord } from '@lms/engine';
import { Prng, readerStrategy } from '@lms/engine/bots';
import { evidenceBundle, evidenceHash, verifyMatch, verifyOnChain } from '../src/game/verify.js';
import { bytes32 } from './helpers.js';

const CHAIN_ID = 11155111;

/** The wallet at a seat, and the session key it grants. */
function player(label: string, seat: number) {
  const account = (kind: string) => privateKeyToAccount(keccak256(toHex(`${kind}:${label}:${seat}`)));
  return { wallet: account('wallet'), key: account('key') };
}

/** `transcript` with every seat's grant, commits and reveals signed, as a staked match has them. */
async function signed(label: string, transcript: Transcript): Promise<Transcript> {
  const players = transcript.seats.map((seat) => player(label, seat.index));
  const grants = await Promise.all(
    players.map(async ({ wallet, key }) => {
      const grant = {
        wallet: wallet.address,
        sessionKey: key.address,
        domain: 'play.test',
        uri: 'https://play.test',
        chainId: CHAIN_ID,
        issuedAt: 0,
        expiresAt: 3_600,
        nonce: bytes32('grant'),
      };
      return { grant, signature: await wallet.signTypedData(grantTypedData(grant)) };
    }),
  );
  const rounds = await Promise.all(
    transcript.rounds.map(async ({ record }) => ({
      record,
      proofs: await Promise.all(
        record.moves.map(async (move) => {
          const place = { matchId: transcript.matchId, round: record.round, seat: move.index };
          const { key } = players[move.index]!;
          return {
            index: move.index,
            commitSignature:
              move.commitment === NO_COMMITMENT ? null : await key.signTypedData(commitTypedData(CHAIN_ID, place, move.commitment)),
            revealSignature: move.revealed ? await key.signTypedData(revealTypedData(CHAIN_ID, place, move)) : null,
            receivedAt: 1,
          };
        }),
      ),
    })),
  );
  return { ...transcript, botSeats: [], grants, rounds };
}

/** Plays a full match and returns what the server would have broadcast. */
function finishedMatch(label: string) {
  const match = new Match({
    matchId: bytes32(`match:${label}`),
    seats: Array.from({ length: 5 }, (_, index) => ({
      index,
      address: player(label, index).wallet.address,
      chainId: CHAIN_ID,
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
  // Every seat a house bot, so nothing in the transcript needs a signature until `signed` adds them.
  const transcript: Transcript = {
    version: TRANSCRIPT_VERSION,
    matchId: match.matchId,
    chainId: CHAIN_ID,
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

describe('a result announced before the match ended', () => {
  it('is rejected, though its rounds replay to it', () => {
    const { state, result } = finishedMatch('cut');
    const cut: PublicMatchState = { ...state, history: state.history.slice(0, 1) };
    const replay = replayMatch(
      { matchId: cut.matchId, seats: cut.players, seed: cut.seed, rules: cut.rules },
      moveLogFromHistory(cut.history),
    );
    expect(replay.result.historyRoot).not.toBe(result.historyRoot);
    expect(verifyMatch(cut, replay.result)).toMatchObject({ ok: false, reason: expect.stringMatching(/whole match/) });
  });
});

describe('verification from chain', () => {
  it('fetches the transcript the escrow names and checks it against the escrow', async () => {
    const transcript = await signed('chain', finishedMatch('chain').transcript);
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
