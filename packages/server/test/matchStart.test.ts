import { describe, expect, it } from 'vitest';
import { Lobby, MemoryArchive, Room, nullRelayer, type Client } from '@lms/server';
import { FakeClient, HUMAN, setupWithBots } from './helpers.js';

const COMMIT_MS = 10_000;
const READY_MS = 30_000;

/** A staked room whose four seats are all players, with a ready phase. */
function readyRoom(now = 0): { room: Room; seats: `0x${string}`[] } {
  const setup = setupWithBots(4, 'ready');
  const room = new Room(setup, { commitMs: COMMIT_MS, revealMs: 5_000, botSeats: [], readyMs: READY_MS, staked: true }, now);
  return { room, seats: setup.seats.map((seat) => seat.address) };
}

describe('the ready phase', () => {
  it("holds round 1's clock until every player has connected, then starts it", () => {
    const { room, seats } = readyRoom();
    expect(room.deadline).toBe(READY_MS + COMMIT_MS);

    const clients = seats.map((address) => new FakeClient(address));
    for (const client of clients.slice(0, 3)) room.attach(client, 1_000);
    expect(clients[0]?.view()?.waitingFor).toEqual([3]);
    expect(room.deadline).toBe(READY_MS + COMMIT_MS);

    room.attach(clients[3] as FakeClient, 5_000);
    expect(room.deadline).toBe(5_000 + COMMIT_MS);
    expect(clients[0]?.view()?.waitingFor).toEqual([]);
  });

  it('counts a spectator for nothing', () => {
    const { room } = readyRoom();
    room.attach(new FakeClient(null), 1_000);
    room.attach(new FakeClient('0x00000000000000000000000000000000000000ee'), 1_000);
    expect(room.absent()).toEqual([0, 1, 2, 3]);
  });

  it('starts without the absent once the wait runs out, on the clock it always had', () => {
    const { room, seats } = readyRoom();
    const here = new FakeClient(seats[0] as `0x${string}`);
    room.attach(here, 0);
    room.tick(READY_MS);
    expect(here.view()?.waitingFor).toEqual([]);
    expect(room.deadline).toBe(READY_MS + COMMIT_MS);

    // Nobody but seat 0 commits; the round still resolves on time.
    room.tick(READY_MS + COMMIT_MS);
    room.tick(READY_MS + COMMIT_MS + 5_000);
    expect(room.match.history).toHaveLength(1);
  });

  it('has no ready phase in a practice room', () => {
    const lobby = new Lobby({ archive: new MemoryArchive(), relayer: nullRelayer, commitMs: COMMIT_MS, revealMs: 5_000, readyMs: READY_MS });
    const room = lobby.createPractice(HUMAN, 3, 0);
    expect(room.deadline).toBe(COMMIT_MS);
  });
});

describe('opening a staked room', () => {
  function lobbyExpecting(expected: Set<string>, live: string[] = []) {
    return new Lobby({
      archive: new MemoryArchive(),
      relayer: nullRelayer,
      commitMs: COMMIT_MS,
      revealMs: 5_000,
      expects: (matchId) => expected.has(matchId.toLowerCase()),
      onLive: (room) => live.push(room.matchId),
    });
  }

  it('holds a watch for a lobby that has no room yet, and attaches it when the room opens', () => {
    const setup = setupWithBots(4, 'held');
    const live: string[] = [];
    const lobby = lobbyExpecting(new Set([setup.matchId.toLowerCase()]), live);
    const watcher = new FakeClient(HUMAN);

    expect(lobby.attach(setup.matchId, watcher, 0)).toBeNull();
    expect(watcher.last('waiting')).toEqual({ type: 'waiting', matchId: setup.matchId });

    lobby.adopt(setup, [], 1_000);
    expect(watcher.last('state')?.state.matchId).toBe(setup.matchId);
    expect(live).toEqual([setup.matchId]);
  });

  it('forgets a held watch when its client goes', () => {
    const setup = setupWithBots(4, 'held-gone');
    const lobby = lobbyExpecting(new Set([setup.matchId.toLowerCase()]));
    const watcher = new FakeClient(HUMAN);
    lobby.attach(setup.matchId, watcher, 0);
    lobby.detach(watcher);

    lobby.adopt(setup, [], 1_000);
    expect(watcher.last('state')).toBeUndefined();
  });

  it('still refuses a watch for a match nobody expects', () => {
    const lobby = lobbyExpecting(new Set());
    const client: Client = { address: null, send: () => undefined };
    expect(() => lobby.attach(setupWithBots(4, 'nobody').matchId, client)).toThrow(/unknown match/);
  });
});
