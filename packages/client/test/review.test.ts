import { describe, expect, it } from 'vitest';
import { commitMove, DEFAULT_RULES, MatchPhase, type Move } from '@lms/consensus';
import { type ReviewedMatch } from '@lms/api';
import { Match } from '@lms/engine';
import { Prng, readerStrategy } from '@lms/engine/bots';
import { reviewOf } from '../src/game/review.js';
import { verifyMatch } from '../src/game/verify.js';
import { ordinal, placeLabel } from '../src/ui/format.js';
import { bytes32 } from './helpers.js';

/** Plays a full match, and returns its live final snapshot and what the archive keeps of it. */
function archived(label: string) {
  const seats = Array.from({ length: 4 }, (_, index) => ({
    index,
    address: `0x${(index + 0xa1).toString(16).padStart(40, '0')}` as `0x${string}`,
    chainId: 11155111,
  }));
  const seed = bytes32(`seed:${label}`);
  const match = new Match({ matchId: bytes32(`match:${label}`), seats, seed, rules: DEFAULT_RULES });
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
    for (const [seat, move] of moves) match.submitReveal(seat, move);
    match.resolve();
  }
  const live = match.publicState();
  const result = match.result();
  const record: ReviewedMatch = {
    result,
    history: live.history,
    seats,
    rules: DEFAULT_RULES,
    seed,
    staked: false,
    settledTx: null,
    finishedAt: 1_700_000_000_000,
  };
  return { live, result, record };
}

describe('reopening an archived match', () => {
  it('rebuilds the table exactly as the match left it', () => {
    const { live, record } = archived('table');
    const { state } = reviewOf(record, null);

    expect(state.phase).toBe(MatchPhase.Finished);
    expect(state.players).toEqual(live.players);
    expect(state.history).toEqual(live.history);
    expect(state.historyRoot).toBe(live.historyRoot);
  });

  it('still verifies in the browser', () => {
    const { result, record } = archived('verify');
    expect(verifyMatch(reviewOf(record, null).state, result).ok).toBe(true);
  });

  it('turns the ranking into seats and finds the viewer by address, ignoring case', () => {
    const { result, record } = archived('ranking');
    const second = result.ranking[1] as `0x${string}`;
    const review = reviewOf(record, second.toUpperCase().replace('0X', '0x') as `0x${string}`);

    expect(review.ranking.map((seat) => record.seats[seat]?.address)).toEqual(result.ranking);
    expect(review.you).toBe(review.ranking[1]);
  });

  it('opens as a spectator for a wallet that did not sit', () => {
    const { record } = archived('spectator');
    expect(reviewOf(record, `0x${'ee'.repeat(20)}`).you).toBeNull();
  });
});

describe('history labels', () => {
  it('names the place a player finished in', () => {
    expect(placeLabel(1, 4)).toBe('Won');
    expect(placeLabel(2, 4)).toBe('2nd of 4');
    expect(placeLabel(0, 4)).toBe('Played');
  });

  it('writes ordinals the English way', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 111].map(ordinal)).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '111th',
    ]);
  });
});
