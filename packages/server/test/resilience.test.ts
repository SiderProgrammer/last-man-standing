import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  Action,
  AUTH_PREFIX,
  MAX_CLIENT_FRAME_BYTES,
  MatchPhase,
  commitMove,
  type ClientMessage,
  type SealedMove,
  type ServerMessage,
} from '@lms/protocol';
import {
  Gateway,
  Lobby,
  MemoryArchive,
  MemoryJournal,
  nullRelayer,
  nullSessionRelayer,
  type Room,
  type SessionRelayer,
  type Socket,
} from '@lms/server';
import { FakeClient, HUMAN, botSeats, bytes32, lastOfType, setupWithBots } from './helpers.js';

const COMMIT_MS = 10_000;
const REVEAL_MS = 5_000;

function lobbyWith(journal: MemoryJournal, extra: { maxPracticeRooms?: number } = {}): Lobby {
  return new Lobby({
    archive: new MemoryArchive(),
    relayer: nullRelayer,
    commitMs: COMMIT_MS,
    revealMs: REVEAL_MS,
    journal,
    ...extra,
  });
}

function sealedFor(room: Room, label: string): SealedMove {
  const opponent = room.match.alive.find((seat) => seat !== 0) ?? 1;
  return { action: Action.Attack, target: opponent, salt: bytes32(`${label}:${room.match.round}`) };
}

/** Plays the human seat for one round: commit, then reveal once the window opens. */
function playRound(room: Room, now: number, label: string): number {
  const move = sealedFor(room, label);
  room.submitCommit(HUMAN, commitMove(room.matchId, room.match.round, 0, move), now);
  // Bots committed at round start, so the human's commit opens the reveal.
  expect(room.match.phase).toBe(MatchPhase.Reveal);
  room.submitReveal(HUMAN, move, now + 1);
  return now + 2;
}

describe('round journal', () => {
  it('rebuilds a staked room exactly as it was', async () => {
    const journal = new MemoryJournal();
    const before = lobbyWith(journal);
    const room = before.adopt(setupWithBots(4, 'journal'), botSeats(4), 1_000);

    let now = playRound(room, 2_000, 'j');
    now = playRound(room, now + 100, 'j');
    // Leave round 3 half done: the human has committed, the reveal is open.
    const move = sealedFor(room, 'j');
    room.submitCommit(HUMAN, commitMove(room.matchId, room.match.round, 0, move), now + 100);

    const after = lobbyWith(journal);
    expect(await after.restore(now + 200)).toBe(1);
    const rebuilt = after.get(room.matchId) as Room;

    const { history: a, ...restA } = room.match.publicState();
    const { history: b, ...restB } = rebuilt.match.publicState();
    expect(restB).toEqual(restA);
    expect(b.map((record) => record.hash)).toEqual(a.map((record) => record.hash));

    // And it keeps playing: the human's reveal lands on the rebuilt room.
    rebuilt.submitReveal(HUMAN, move, now + 300);
    expect(rebuilt.match.history).toHaveLength(3);
  });

  it('records a clock tick that moved the phase, and replays it', async () => {
    const journal = new MemoryJournal();
    const room = lobbyWith(journal).adopt(setupWithBots(4, 'tick'), botSeats(4), 0);
    const move = sealedFor(room, 't');
    room.submitCommit(HUMAN, commitMove(room.matchId, 1, 0, move), 1);
    // The human never reveals; the clock closes the window and resolves.
    room.tick(REVEAL_MS + 2);
    expect(room.match.history).toHaveLength(1);

    const [entry] = await journal.live();
    expect(entry?.events.map((event) => event.kind)).toEqual(['commit', 'tick']);

    const after = lobbyWith(journal);
    await after.restore(REVEAL_MS + 3);
    const rebuilt = after.get(room.matchId) as Room;
    expect(rebuilt.match.round).toBe(2);
    expect(rebuilt.match.historyRoot).toBe(room.match.historyRoot);
  });

  it('gives the open window its full length after a restart', async () => {
    const journal = new MemoryJournal();
    const room = lobbyWith(journal).adopt(setupWithBots(4, 'grace'), botSeats(4), 0);
    room.submitCommit(HUMAN, commitMove(room.matchId, 1, 0, sealedFor(room, 'g')), 1);
    expect(room.match.phase).toBe(MatchPhase.Reveal);

    // The server was down far longer than the reveal window.
    const restartedAt = 60_000;
    const after = lobbyWith(journal);
    await after.restore(restartedAt);
    const rebuilt = after.get(room.matchId) as Room;

    expect(rebuilt.deadline).toBe(restartedAt + REVEAL_MS);
    rebuilt.tick(restartedAt + 1);
    expect(rebuilt.match.history).toHaveLength(0);
  });

  it('journals staked rooms only', async () => {
    const journal = new MemoryJournal();
    lobbyWith(journal).createPractice(HUMAN, 3, 0);
    expect(await journal.live()).toEqual([]);
  });

  it('forgets a room once its result is archived, and tells watchers how it settled', async () => {
    const journal = new MemoryJournal();
    const lobby = lobbyWith(journal);
    const room = lobby.adopt(setupWithBots(4, 'settle'), botSeats(4), 0);
    const watcher = new FakeClient(null);
    room.attach(watcher);

    let now = 1;
    while (!room.finished) {
      now += COMMIT_MS + 1;
      room.tick(now);
    }
    // `finalise` is asynchronous: settle, archive, then close and announce.
    await new Promise((resolve) => setImmediate(resolve));

    expect(await journal.live()).toEqual([]);
    expect(watcher.last('settled')).toEqual({ type: 'settled', matchId: room.matchId, tx: null });
  });
});

describe('practice limits', () => {
  it('keeps one practice room per wallet, replacing the old one', () => {
    const lobby = lobbyWith(new MemoryJournal());
    const first = lobby.createPractice(HUMAN, 3, 0);
    const second = lobby.createPractice(HUMAN, 3, 0);

    expect(lobby.size).toBe(1);
    expect(lobby.get(first.matchId)).toBeNull();
    expect(lobby.get(second.matchId)).toBe(second);
  });

  it('refuses new practice rooms past the global ceiling', () => {
    const lobby = lobbyWith(new MemoryJournal(), { maxPracticeRooms: 2 });
    lobby.createPractice('0x00000000000000000000000000000000000000b1', 3, 0);
    lobby.createPractice('0x00000000000000000000000000000000000000b2', 3, 0);
    expect(() => lobby.createPractice('0x00000000000000000000000000000000000000b3', 3, 0)).toThrow(
      /practice-room limit/,
    );
    // A wallet that already holds one may still swap it for a new one.
    expect(() => lobby.createPractice('0x00000000000000000000000000000000000000b1', 3, 0)).not.toThrow();
  });
});

const account = privateKeyToAccount(`0x${'22'.repeat(32)}`);

class FakeSocket implements Socket {
  readyState = 1;
  readonly sent: ServerMessage[] = [];
  private listener?: (data: unknown) => void;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }

  onMessage(listener: (data: unknown) => void): void {
    this.listener = listener;
  }

  onClose(): void {}

  async raw(data: string): Promise<void> {
    this.listener?.(data);
    await new Promise((resolve) => setImmediate(resolve));
  }

  deliver(message: ClientMessage): Promise<void> {
    return this.raw(JSON.stringify(message));
  }
}

function gatewayHarness(relayer: SessionRelayer, clock = { now: 0 }) {
  const lobby = lobbyWith(new MemoryJournal());
  const gateway = new Gateway({
    lobby,
    chainId: 11155111,
    now: () => clock.now,
    directory: () => ({ open: [], live: [] }),
    relayer,
  });
  const socket = new FakeSocket();
  gateway.accept(socket);
  return { socket, clock };
}

async function login(socket: FakeSocket): Promise<void> {
  const hello = lastOfType(socket.sent, 'hello');
  const signature = await account.signMessage({ message: `${AUTH_PREFIX}${hello?.nonce}` });
  await socket.deliver({ type: 'auth', address: account.address, signature });
}

function collectingRelayer(): SessionRelayer & { collected: string[] } {
  const collected: string[] = [];
  return {
    enabled: true,
    canCollect: true,
    collected,
    submit: () => Promise.reject(new Error('unused')),
    collect: async (target) => {
      collected.push(target);
      return `0x${'ee'.repeat(32)}`;
    },
  };
}

describe('gateway limits', () => {
  it('refuses an oversized frame without parsing it', async () => {
    const { socket } = gatewayHarness(nullSessionRelayer);
    await socket.raw('x'.repeat(MAX_CLIENT_FRAME_BYTES + 1));
    expect(lastOfType(socket.sent, 'error')?.message).toMatch(/too large/);
  });

  it('rate-limits a socket that floods the server, and lets it recover', async () => {
    const { socket, clock } = gatewayHarness(nullSessionRelayer);
    for (let i = 0; i < 40; i += 1) await socket.deliver({ type: 'lobbies' });
    expect(lastOfType(socket.sent, 'error')?.message).toMatch(/slow down/);

    clock.now += 5_000;
    const errors = socket.sent.filter((message) => message.type === 'error').length;
    await socket.deliver({ type: 'lobbies' });
    expect(socket.sent.filter((message) => message.type === 'error').length).toBe(errors + 1);
    // ...that one failed only because the socket never logged in, not the limit.
    expect(lastOfType(socket.sent, 'error')?.message).toMatch(/authenticate/);
  });
});

describe('collect', () => {
  it('advertises whether payouts are pushed', () => {
    expect(lastOfType(gatewayHarness(nullSessionRelayer).socket.sent, 'hello')?.collect).toBe(false);
    expect(lastOfType(gatewayHarness(collectingRelayer()).socket.sent, 'hello')?.collect).toBe(true);
  });

  it('pushes the payout to the logged-in account and no other', async () => {
    const relayer = collectingRelayer();
    const { socket } = gatewayHarness(relayer);
    await login(socket);
    await socket.deliver({ type: 'collect' });

    expect(relayer.collected).toEqual([account.address]);
    expect(lastOfType(socket.sent, 'relayed')?.hash).toBe(`0x${'ee'.repeat(32)}`);
  });

  it('throttles repeated requests, since each can cost the relayer gas', async () => {
    const relayer = collectingRelayer();
    const { socket, clock } = gatewayHarness(relayer);
    await login(socket);
    await socket.deliver({ type: 'collect' });
    await socket.deliver({ type: 'collect' });
    expect(relayer.collected).toHaveLength(1);
    expect(lastOfType(socket.sent, 'error')?.message).toMatch(/just requested/);

    clock.now += 31_000;
    await socket.deliver({ type: 'collect' });
    expect(relayer.collected).toHaveLength(2);
  });

  it('refuses when the server does not push payouts', async () => {
    const { socket } = gatewayHarness(nullSessionRelayer);
    await login(socket);
    await socket.deliver({ type: 'collect' });
    expect(lastOfType(socket.sent, 'error')?.message).toMatch(/does not push payouts/);
  });
});
