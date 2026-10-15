import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { AUTH_PREFIX, MAX_CLIENT_FRAME_BYTES, type ClientMessage, type ServerMessage } from '@lms/protocol';
import {
  Gateway,
  Lobby,
  MemoryArchive,
  nullRelayer,
  nullSessionRelayer,
  type SessionRelayer,
  type Socket,
} from '@lms/server';
import { FakeClient, HUMAN, botSeats, lastOfType, setupWithBots } from './helpers.js';

const COMMIT_MS = 10_000;
const REVEAL_MS = 5_000;

function lobbyWith(extra: { maxPracticeRooms?: number } = {}): Lobby {
  return new Lobby({
    archive: new MemoryArchive(),
    relayer: nullRelayer,
    commitMs: COMMIT_MS,
    revealMs: REVEAL_MS,
    ...extra,
  });
}

describe('settlement announcement', () => {
  it('tells watchers how a staked match settled', async () => {
    const lobby = lobbyWith();
    const room = lobby.adopt(setupWithBots(4, 'settle'), botSeats(4), 0);
    const watcher = new FakeClient(null);
    room.attach(watcher);

    let now = 1;
    while (!room.finished) {
      now += COMMIT_MS + 1;
      room.tick(now);
    }
    // `finalise` is asynchronous: settle, archive, then announce.
    await new Promise((resolve) => setImmediate(resolve));

    expect(watcher.last('settled')).toEqual({ type: 'settled', matchId: room.matchId, tx: null });
  });
});

describe('practice limits', () => {
  it('keeps one practice room per wallet, replacing the old one', () => {
    const lobby = lobbyWith();
    const first = lobby.createPractice(HUMAN, 3, 0);
    const second = lobby.createPractice(HUMAN, 3, 0);

    expect(lobby.size).toBe(1);
    expect(lobby.get(first.matchId)).toBeNull();
    expect(lobby.get(second.matchId)).toBe(second);
  });

  it('refuses new practice rooms past the global ceiling', () => {
    const lobby = lobbyWith({ maxPracticeRooms: 2 });
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
  const lobby = lobbyWith();
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
