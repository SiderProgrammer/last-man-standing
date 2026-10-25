import { describe, expect, it } from 'vitest';
import { Action, MatchPhase, commitMove, type SealedMove } from '@lms/protocol';
import { Room } from '@lms/server';
import { HUMAN, botSeats, bytes32, setupWithBots } from './helpers.js';

const OPTIONS = { commitMs: 10_000, revealMs: 5_000, botSeats: botSeats(4) };

function move(label: string): SealedMove {
  return { action: Action.Guard, target: 0, salt: bytes32(label) };
}

describe('held moves', () => {
  it('reveals a held move for a player who never comes back', () => {
    const room = new Room(setupWithBots(4, 'held'), OPTIONS, 0);
    const sealed = move('held');
    room.submitCommit(HUMAN, commitMove(room.matchId, 1, 0, sealed), 1, sealed);

    // All committed, so the reveal opened — and the held move with it.
    expect(room.match.history).toHaveLength(1);
    const mine = room.match.history[0]?.moves.find((entry) => entry.index === 0);
    expect(mine).toMatchObject({ action: Action.Guard, revealed: true, salt: sealed.salt });
  });

  it('refuses a held move that does not open the commitment', () => {
    const room = new Room(setupWithBots(4, 'mismatch'), OPTIONS, 0);
    const committed = move('one');
    expect(() =>
      room.submitCommit(HUMAN, commitMove(room.matchId, 1, 0, committed), 1, move('another')),
    ).toThrow(/does not open the commitment/);
    expect(room.match.phase).toBe(MatchPhase.Commit);
  });

  /**
   * The server opens held moves itself, on the room clock, where a refusal has
   * no client to go back to. One the rules forbid has to be turned away while
   * the player is still there to hear it.
   */
  it('refuses a held move the rules forbid before keeping the commitment', () => {
    const room = new Room(setupWithBots(4, 'self-strike'), OPTIONS, 0);
    const self: SealedMove = { action: Action.Strike, target: 0, salt: bytes32('self') };
    expect(() => room.submitCommit(HUMAN, commitMove(room.matchId, 1, 0, self), 1, self)).toThrow(
      /cannot strike itself/,
    );
    expect(room.match.publicState().committed).not.toContain(0);
  });

  it('refuses a held Guard straight after a Guard', () => {
    const room = new Room(setupWithBots(4, 'held-cooldown'), OPTIONS, 0);
    const first = move('first');
    room.submitCommit(HUMAN, commitMove(room.matchId, 1, 0, first), 1, first);
    expect(room.match.round).toBe(2);

    const again = move('again');
    expect(() => room.submitCommit(HUMAN, commitMove(room.matchId, 2, 0, again), 2, again)).toThrow(
      /cannot guard again yet/,
    );
    expect(room.match.publicState().committed).not.toContain(0);
  });
});
