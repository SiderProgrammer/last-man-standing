import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { Action, MatchPhase, commitMove, type SealedMove } from '@lms/protocol';
import type { MatchSetup } from '@lms/engine';
import {
  Lobby,
  MemoryArchive,
  MemoryJournal,
  PostgresJournal,
  Room,
  nullRelayer,
  type JournalEntry,
  type RoomJournal,
  type RoomOptions,
} from '@lms/server';
import { FakeClient, setupWithBots } from './helpers.js';
import { pglite } from './pglite.js';

const COMMIT_MS = 10_000;
const REVEAL_MS = 5_000;

/** Every seat a player: the only kind of room that is journalled. */
function staked(label: string): MatchSetup {
  return setupWithBots(4, label);
}

/** Seat `seat`'s move in `round`: everyone strikes the next seat round. */
function moveOf(round: number, seat: number): SealedMove {
  return { action: Action.Strike, target: (seat + 1) % 4, salt: keccak256(toHex(`salt:${round}:${seat}`)) };
}

/** Commits, then reveals, every living seat's move for the room's round, at `now`. */
function playRound(room: Room, now: number, reveal: readonly number[] = [0, 1, 2, 3]): void {
  const round = room.match.round;
  const aim = { matchId: room.matchId, round };
  const living = room.match.alive;
  for (const seat of living) {
    const address = room.match.seats[seat]?.address as `0x${string}`;
    room.submitCommit(address, commitMove(room.matchId, round, seat, moveOf(round, seat)), now, undefined, aim);
  }
  for (const seat of living) {
    if (!reveal.includes(seat)) continue;
    room.submitReveal(room.match.seats[seat]?.address as `0x${string}`, moveOf(round, seat), now + 1, aim);
  }
}

function journalled(setup: MatchSetup, entries: JournalEntry[], extra: Partial<RoomOptions> = {}): Room {
  return new Room(setup, { commitMs: COMMIT_MS, revealMs: REVEAL_MS, botSeats: [], journal: (entry) => entries.push(entry), ...extra }, 0);
}

describe('room journal replay', () => {
  it('rebuilds a room to the same round, record and commitments', () => {
    const setup = staked('replay');
    const entries: JournalEntry[] = [];
    const room = journalled(setup, entries);
    playRound(room, 100);
    playRound(room, 200);
    // Round 3: committed, reveal open, two of four revealed.
    playRound(room, 300, [0, 1]);
    expect(room.match.phase).toBe(MatchPhase.Reveal);

    const copy = Room.replay(setup, { commitMs: COMMIT_MS, revealMs: REVEAL_MS, botSeats: [] }, entries);
    expect(copy.match.publicState()).toEqual(room.match.publicState());

    // The rest of the round resolves the same way in both.
    for (const target of [room, copy]) {
      const aim = { matchId: target.matchId, round: 3 };
      for (const seat of [2, 3]) target.submitReveal(target.match.seats[seat]?.address as `0x${string}`, moveOf(3, seat), 400, aim);
    }
    expect(copy.match.history).toEqual(room.match.history);
  });

  it('replays the clock: a window that closed on the timer closes again', () => {
    const setup = staked('clock');
    const entries: JournalEntry[] = [];
    const room = journalled(setup, entries);
    const aim = { matchId: room.matchId, round: 1 };
    // Only seat 0 commits; the window closes on the clock.
    room.submitCommit(setup.seats[0]?.address as `0x${string}`, commitMove(room.matchId, 1, 0, moveOf(1, 0)), 10, undefined, aim);
    room.tick(COMMIT_MS + 1);
    room.tick(COMMIT_MS + 1 + REVEAL_MS + 1);
    expect(entries.filter((entry) => entry.kind === 'tick')).toHaveLength(2);

    const copy = Room.replay(setup, { commitMs: COMMIT_MS, revealMs: REVEAL_MS, botSeats: [] }, entries);
    expect(copy.match.history).toEqual(room.match.history);
    expect(copy.match.round).toBe(2);
  });

  it('refuses a journal that does not open the room first', () => {
    expect(() => Room.replay(staked('bad'), { commitMs: 1, revealMs: 1, botSeats: [] }, [{ kind: 'tick', at: 0 }])).toThrow(
      /does not begin with the room opening/,
    );
  });

  it("gives the players their clock back on a rebase, mid-round, without touching the round's moves", () => {
    const setup = staked('rebase');
    const entries: JournalEntry[] = [];
    const room = journalled(setup, entries, { readyMs: 30_000 });
    playRound(room, 100, [0]);
    const before = room.match.publicState();
    room.rebase(1_000_000);
    expect(room.match.publicState()).toEqual(before);
    expect(room.deadline).toBe(1_000_000 + 30_000 + REVEAL_MS);
    expect(entries.at(-1)).toEqual({ kind: 'rebase', at: 1_000_000 });
  });
});

describe('resuming after a restart', () => {
  function lobbyOver(journal: RoomJournal, archive = new MemoryArchive()) {
    return new Lobby({ archive, relayer: nullRelayer, commitMs: COMMIT_MS, revealMs: REVEAL_MS, journal });
  }

  it('resumes a staked room from its journal, where it was, and drops the journal once the match is done', async () => {
    const journal = new MemoryJournal();
    const setup = staked('resume');
    const before = lobbyOver(journal);
    const room = before.adopt(setup, [], 0);
    playRound(room, 100);
    playRound(room, 200, [0, 1]);
    await before.persisted(setup.matchId);
    const state = room.match.publicState();

    // The process dies; a new one resumes the match.
    const archive = new MemoryArchive();
    const after = lobbyOver(journal, archive);
    const watcher = new FakeClient(null);
    const resumed = await after.resume(setup, 5_000_000);
    expect(resumed?.match.publicState()).toEqual(state);
    resumed?.attach(watcher, 5_000_000);
    expect(watcher.view()?.state.round).toBe(2);

    // Played out to the end, it is archived and its journal goes.
    let now = 5_000_000;
    while (!resumed?.finished && now < 50_000_000) {
      now += COMMIT_MS + REVEAL_MS;
      after.tick(now);
    }
    await after.drain();
    expect(await archive.load(setup.matchId)).not.toBeNull();
    expect(await journal.load(setup.matchId)).toEqual([]);
  });

  it('says when a commit is in the journal, which a receipt waits for', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const written: JournalEntry['kind'][] = [];
    const journal: RoomJournal = {
      append: async (_matchId, _seq, entry) => {
        await gate;
        written.push(entry.kind);
      },
      load: async () => [],
      drop: async () => undefined,
    };
    const lobby = lobbyOver(journal);
    const setup = staked('persisted');
    const room = lobby.adopt(setup, [], 0);
    const aim = { matchId: room.matchId, round: 1 };
    room.submitCommit(setup.seats[0]?.address as `0x${string}`, commitMove(room.matchId, 1, 0, moveOf(1, 0)), 10, undefined, aim);

    let done = false;
    const persisted = lobby.persisted(setup.matchId).then(() => {
      done = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toBe(false);
    release();
    await persisted;
    expect(written).toEqual(['open', 'commit']);
  });

  it('has nothing to resume without a journal', async () => {
    expect(await lobbyOver(new MemoryJournal()).resume(staked('none'))).toBeNull();
  });

  it('never journals a room with house bots, which would not replay', () => {
    const journal = new MemoryJournal();
    const lobby = lobbyOver(journal);
    const setup = setupWithBots(4, 'bots');
    lobby.adopt(setup, [1, 2, 3], 0);
    return expect(journal.load(setup.matchId)).resolves.toEqual([]);
  });
});

describe.each([
  ['memory', async (): Promise<RoomJournal> => new MemoryJournal()],
  ['postgres', async (): Promise<RoomJournal> => new PostgresJournal(await pglite())],
])('%s journal', (_name, open) => {
  it('keeps entries in order per match, and forgets a match', async () => {
    const journal = await open();
    const id = keccak256(toHex('journal'));
    const upper = id.toUpperCase().replace('0X', '0x') as `0x${string}`;
    await journal.append(id, 0, { kind: 'open', at: 1 });
    await journal.append(upper, 1, { kind: 'tick', at: 2 });
    expect(await journal.load(id)).toEqual([
      { kind: 'open', at: 1 },
      { kind: 'tick', at: 2 },
    ]);
    await journal.drop(id);
    expect(await journal.load(id)).toEqual([]);
  });
});
