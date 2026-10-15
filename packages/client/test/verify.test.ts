import { describe, expect, it } from 'vitest';
import { commitMove, DEFAULT_RULES, type Move, type PublicMatchState } from '@lms/protocol';
import { Match, Prng, readerStrategy } from '@lms/engine';
import { matchesChain, verifyMatch } from '../src/game/verify.js';
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
  return { state: match.publicState(), result: match.result() };
}

describe('in-browser verification', () => {
  it('reproduces a genuine result from the broadcast alone', () => {
    const { state, result } = finishedMatch('genuine');
    const verification = verifyMatch(state, result);
    expect(verification.ok).toBe(true);
    expect(verification.root).toBe(result.historyRoot);
    expect(matchesChain(verification, result.historyRoot)).toBe(true);
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

  it('flags a chain root that differs from the replay', () => {
    const { state, result } = finishedMatch('chain');
    expect(matchesChain(verifyMatch(state, result), bytes32('some other root'))).toBe(false);
  });
});
