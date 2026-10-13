import { describe, expect, it } from 'vitest';
import { Action, MatchPhase, commitMove, type SealedMove } from '@lms/protocol';
import { Lobby, MemoryArchive, MemoryJournal, Room, nullRelayer } from '@lms/server';
import { HUMAN, botSeats, bytes32, setupWithBots } from './helpers.js';

const OPTIONS = { commitMs: 10_000, revealMs: 5_000, botSeats: botSeats(4) };

function move(label: string): SealedMove {
  return { action: Action.Defend, target: 0, salt: bytes32(label) };
}

describe('held moves', () => {
  it('reveals a held move for a player who never comes back', () => {
    const room = new Room(setupWithBots(4, 'held'), OPTIONS, 0);
    const sealed = move('held');
    room.submitCommit(HUMAN, commitMove(room.matchId, 1, 0, sealed), 1, sealed);

    // All committed, so the reveal opened — and the held move with it.
    expect(room.match.history).toHaveLength(1);
    const mine = room.match.history[0]?.moves.find((entry) => entry.index === 0);
    expect(mine).toMatchObject({ action: Action.Defend, revealed: true, salt: sealed.salt });
  });

  it('refuses a held move that does not open the commitment', () => {
    const room = new Room(setupWithBots(4, 'mismatch'), OPTIONS, 0);
    const committed = move('one');
    expect(() =>
      room.submitCommit(HUMAN, commitMove(room.matchId, 1, 0, committed), 1, move('another')),
    ).toThrow(/does not open the commitment/);
    expect(room.match.phase).toBe(MatchPhase.Commit);
  });

  it('replays a held move from the journal after a restart', async () => {
    const journal = new MemoryJournal();
    const lobby = new Lobby({ archive: new MemoryArchive(), relayer: nullRelayer, commitMs: 10_000, revealMs: 5_000, journal });
    const room = lobby.adopt(setupWithBots(4, 'held-journal'), botSeats(4), 0);
    const sealed = move('held-journal');
    room.submitCommit(HUMAN, commitMove(room.matchId, 1, 0, sealed), 1, sealed);

    const after = new Lobby({ archive: new MemoryArchive(), relayer: nullRelayer, commitMs: 10_000, revealMs: 5_000, journal });
    await after.restore(2);
    expect(after.get(room.matchId)?.match.historyRoot).toBe(room.match.historyRoot);
  });
});
