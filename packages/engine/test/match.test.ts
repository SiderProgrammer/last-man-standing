import { describe, expect, it } from 'vitest';
import { Action, commitMove, MatchPhase, type SealedMove } from '@lms/consensus';
import { Match, MatchError } from '@lms/engine';
import { always, bytes32, playMatch, setupFor } from './helpers.js';

function sealed(action: SealedMove['action'], target: number, salt: string): SealedMove {
  return { action, target, salt: bytes32(salt) };
}

describe('commit / reveal lifecycle', () => {
  it('starts in the commit phase of round 1 with everyone alive', () => {
    const match = new Match(setupFor(4));
    expect(match.phase).toBe(MatchPhase.Commit);
    expect(match.round).toBe(1);
    expect(match.alive).toEqual([0, 1, 2, 3]);
  });

  it('publishes the commitment set only once the commit window closes', () => {
    const setup = setupFor(4);
    const match = new Match(setup);
    const commitment = commitMove(setup.matchId, 1, 2, sealed(Action.Guard, 0, 'salt-c'));
    match.submitCommit(2, commitment);
    expect(match.publicState().committed).toEqual([2]);
    expect(match.publicState().commitments).toEqual([]);

    match.openRevealPhase();
    expect(match.publicState().commitments).toEqual([{ index: 2, commitment }]);
  });

  it('rejects a reveal that does not match the commitment', () => {
    const setup = setupFor(4);
    const match = new Match(setup);
    const honest = sealed(Action.Guard, 0, 'salt-a');

    match.submitCommit(0, commitMove(setup.matchId, 1, 0, honest));
    match.openRevealPhase();

    expect(() => match.submitReveal(0, sealed(Action.Strike, 1, 'salt-a'))).toThrow(MatchError);
    expect(() => match.submitReveal(0, { ...honest, salt: bytes32('salt-b') })).toThrow(
      /does not match its commitment/,
    );
    // The honest reveal still works: a failed attempt must not consume the slot.
    expect(() => match.submitReveal(0, honest)).not.toThrow();
  });

  it('binds a commitment to its round so it cannot be replayed', () => {
    const setup = setupFor(4);
    const match = new Match(setup);
    const move = sealed(Action.Charge, 0, 'salt-replay');

    // A commitment computed for round 2 must not be revealable in round 1.
    match.submitCommit(0, commitMove(setup.matchId, 2, 0, move));
    match.openRevealPhase();
    expect(() => match.submitReveal(0, move)).toThrow(expect.objectContaining({ code: 'COMMITMENT_MISMATCH', message: expect.stringMatching(/does not match its commitment/) }));
  });

  it('binds a commitment to its seat so it cannot be claimed by another player', () => {
    const setup = setupFor(4);
    const match = new Match(setup);
    const move = sealed(Action.Charge, 0, 'salt-seat');

    match.submitCommit(1, commitMove(setup.matchId, 1, 0, move));
    match.openRevealPhase();
    expect(() => match.submitReveal(1, move)).toThrow(expect.objectContaining({ code: 'COMMITMENT_MISMATCH', message: expect.stringMatching(/does not match its commitment/) }));
  });

  it('refuses a second commitment from the same seat in one round', () => {
    const setup = setupFor(4);
    const match = new Match(setup);
    const commitment = commitMove(setup.matchId, 1, 0, sealed(Action.Guard, 0, 'salt'));

    match.submitCommit(0, commitment);
    expect(() => match.submitCommit(0, commitment)).toThrow(expect.objectContaining({ code: 'ALREADY_COMMITTED', message: expect.stringMatching(/already committed/) }));
  });

  it('refuses a reveal from a seat that never committed', () => {
    const match = new Match(setupFor(4));
    match.openRevealPhase();
    expect(() => match.submitReveal(2, sealed(Action.Charge, 0, 'salt'))).toThrow(expect.objectContaining({ code: 'NO_COMMITMENT', message: expect.stringMatching(/did not commit/) }));
  });

  it('rejects illegal targets at reveal time', () => {
    const setup = setupFor(4);
    const match = new Match(setup);
    match.submitCommit(0, commitMove(setup.matchId, 1, 0, sealed(Action.Strike, 0, 'salt')));
    match.openRevealPhase();
    expect(() => match.submitReveal(0, sealed(Action.Strike, 0, 'salt'))).toThrow(expect.objectContaining({ code: 'INVALID_MOVE', message: expect.stringMatching(/cannot strike itself/) }));
  });

  it('rejects a Guard or Charge its cooldown rules out, and shows the cooldown publicly', () => {
    const setup = setupFor(4);
    const match = new Match(setup);
    const round1 = [sealed(Action.Guard, 0, 'g1'), sealed(Action.Charge, 0, 'c1'), sealed(Action.Guard, 0, 'g2'), sealed(Action.Guard, 0, 'g3')];
    round1.forEach((move, seat) => match.submitCommit(seat, commitMove(setup.matchId, 1, seat, move)));
    match.openRevealPhase();
    round1.forEach((move, seat) => match.submitReveal(seat, move));
    match.resolve();

    const players = match.publicState().players;
    expect(players[0]?.lastAction).toBe(Action.Guard);
    expect(players[1]?.charged).toBe(true);

    const again = sealed(Action.Guard, 0, 'g1-again');
    const stack = sealed(Action.Charge, 0, 'c1-again');
    match.submitCommit(0, commitMove(setup.matchId, 2, 0, again));
    match.submitCommit(1, commitMove(setup.matchId, 2, 1, stack));
    match.openRevealPhase();
    expect(() => match.submitReveal(0, again)).toThrow(expect.objectContaining({ code: 'INVALID_MOVE', message: expect.stringMatching(/cannot guard again yet/) }));
    expect(() => match.submitReveal(1, stack)).toThrow(expect.objectContaining({ code: 'INVALID_MOVE', message: expect.stringMatching(/cannot charge again yet/) }));

    // The lost moves count as no-shows: no Guard, and every strike lands.
    const record = match.resolve();
    expect(record.moves.find((entry) => entry.index === 0)?.revealed).toBe(false);
  });

  it('enforces phase ordering', () => {
    const setup = setupFor(4);
    const match = new Match(setup);
    expect(() => match.submitReveal(0, sealed(Action.Charge, 0, 'salt'))).toThrow(expect.objectContaining({ code: 'BAD_PHASE', message: expect.stringMatching(/expected phase reveal/) }));
    match.openRevealPhase();
    expect(() => match.submitCommit(0, bytes32('x'))).toThrow(expect.objectContaining({ code: 'BAD_PHASE', message: expect.stringMatching(/expected phase commit/) }));
  });

  it('reports when the commit and reveal windows can close early', () => {
    const setup = setupFor(4);
    const match = new Match(setup);
    const move = sealed(Action.Charge, 0, 'salt-early');

    expect(match.allCommitted()).toBe(false);
    for (const seat of match.alive) {
      match.submitCommit(seat, commitMove(setup.matchId, 1, seat, move));
    }
    expect(match.allCommitted()).toBe(true);

    match.openRevealPhase();
    expect(match.allRevealed()).toBe(false);
    for (const seat of match.alive) match.submitReveal(seat, move);
    expect(match.allRevealed()).toBe(true);
  });

  it('does not wait on a seat that missed the commit window', () => {
    const setup = setupFor(4);
    const match = new Match(setup);
    const move = sealed(Action.Charge, 0, 'salt-partial');

    match.submitCommit(0, commitMove(setup.matchId, 1, 0, move));
    match.submitCommit(1, commitMove(setup.matchId, 1, 1, move));
    match.openRevealPhase();

    match.submitReveal(0, move);
    expect(match.allRevealed()).toBe(false);
    match.submitReveal(1, move);
    // Seats 2 and 3 never committed, so there is nothing left to wait for.
    expect(match.allRevealed()).toBe(true);
  });

  it('never leaks a move before the reveal phase', () => {
    const setup = setupFor(4);
    const match = new Match(setup);
    match.submitCommit(0, commitMove(setup.matchId, 1, 0, sealed(Action.Strike, 3, 'salt')));

    const broadcast = JSON.stringify(match.publicState());
    expect(match.publicState().committed).toEqual([0]);
    expect(match.publicState().revealed).toEqual([]);
    // The public snapshot carries seat numbers only, never a pending action.
    expect(broadcast).not.toContain('"action"');
  });

  it('never publishes a salt before the round resolves', () => {
    const setup = setupFor(4);
    const match = new Match(setup);
    const moves = [0, 1, 2, 3].map((seat) => sealed(Action.Charge, 0, `leak-${seat}`));
    moves.forEach((move, seat) => match.submitCommit(seat, commitMove(setup.matchId, 1, seat, move)));
    match.openRevealPhase();
    // Three of four revealed: anyone holding those salts and the fourth would
    // know the round's rolls, so none of them may be in the broadcast yet.
    moves.slice(0, 3).forEach((move, seat) => match.submitReveal(seat, move));

    const broadcast = JSON.stringify(match.publicState());
    for (const move of moves) expect(broadcast).not.toContain(move.salt.slice(2));

    // Once resolved, the salts are published so the rolls can be audited.
    match.submitReveal(3, moves[3] as SealedMove);
    const record = match.resolve();
    expect(record.moves.map((entry) => entry.salt)).toEqual(moves.map((move) => move.salt));
  });

  it('rejects a lobby outside the configured seat range', () => {
    expect(() => new Match(setupFor(3))).toThrow(/outside \[4, 8\]/);
    expect(() => new Match(setupFor(9))).toThrow(/outside \[4, 8\]/);
  });
});

describe('match completion', () => {
  it('ends with exactly one survivor and a full ranking', () => {
    const { match } = playMatch(setupFor(6, 'completion'), always(Action.Strike));

    expect(match.finished).toBe(true);
    expect(match.alive).toHaveLength(1);

    const ranking = match.ranking();
    expect(ranking).toHaveLength(6);
    expect(new Set(ranking).size).toBe(6);
    expect(ranking[0]).toBe(match.alive[0]);
  });

  it('ranks the survivor first and the earliest casualty last', () => {
    const { match } = playMatch(setupFor(5, 'ordering'), always(Action.Strike));
    const ranking = match.ranking();

    const eliminationRound = (seat: number) => match.playerState(seat).eliminatedInRound;
    const last = ranking[ranking.length - 1] as number;

    expect(match.playerState(ranking[0] as number).alive).toBe(true);
    for (const seat of ranking.slice(1)) {
      expect(eliminationRound(seat as number)).toBeGreaterThan(0);
      expect(eliminationRound(seat as number)).toBeGreaterThanOrEqual(eliminationRound(last));
    }
  });

  it('produces a signable result addressed by wallet', () => {
    const setup = setupFor(4, 'result');
    const { match } = playMatch(setup, always(Action.Strike));
    const result = match.result();

    expect(result.matchId).toBe(setup.matchId);
    expect(result.rounds).toBe(match.history.length);
    expect(result.historyRoot).toBe(match.historyRoot);
    expect(result.ranking).toEqual(match.ranking().map((seat) => setup.seats[seat]?.address));
  });

  it('refuses to rank a match that is still running', () => {
    const match = new Match(setupFor(4));
    expect(() => match.ranking()).toThrow(expect.objectContaining({ code: 'BAD_PHASE', message: expect.stringMatching(/has not finished/) }));
  });

  it('resolves a lobby where some players never reveal', () => {
    const { match } = playMatch(setupFor(6, 'silent'), always(Action.Guard), new Set([1, 4]));
    expect(match.finished).toBe(true);
    expect(match.playerState(1).timeouts).toBeGreaterThan(0);
    expect(match.playerState(4).timeouts).toBeGreaterThan(0);
  });
});
