import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { AUTH_PREFIX, type ClientMessage, type ServerMessage } from '@lms/protocol';
import { Gateway, Lobby, MemoryArchive, nullRelayer } from '@lms/server';
import type { Socket } from '@lms/server';

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);

/** In-process stand-in for a `ws` socket. */
class FakeSocket implements Socket {
  readyState = 1;
  readonly sent: ServerMessage[] = [];
  private listeners: { message?: (data: unknown) => void; close?: () => void } = {};

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }

  on(event: 'message' | 'close', listener: never): void {
    if (event === 'message') this.listeners.message = listener as (data: unknown) => void;
    else this.listeners.close = listener as () => void;
  }

  async deliver(message: ClientMessage): Promise<void> {
    this.listeners.message?.(JSON.stringify(message));
    // The gateway verifies signatures asynchronously; let the microtasks drain.
    await new Promise((resolve) => setImmediate(resolve));
  }

  close(): void {
    this.listeners.close?.();
  }

  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const message = this.sent[i];
      if (message?.type === type) return message as Extract<ServerMessage, { type: T }>;
    }
    return undefined;
  }
}

function harness() {
  const lobby = new Lobby({
    archive: new MemoryArchive(),
    relayer: nullRelayer,
    commitMs: 10_000,
    revealMs: 5_000,
    startingChips: 500,
  });
  const gateway = new Gateway({ lobby, chainId: 11155111, now: () => 0 });
  const socket = new FakeSocket();
  gateway.accept(socket);
  return { lobby, gateway, socket };
}

async function login(socket: FakeSocket): Promise<void> {
  const hello = socket.last('hello');
  const signature = await account.signMessage({ message: `${AUTH_PREFIX}${hello?.nonce}` });
  await socket.deliver({ type: 'auth', address: account.address, signature });
}

describe('gateway', () => {
  it('greets a new connection with a login nonce', () => {
    const { socket } = harness();
    expect(socket.last('hello')?.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(socket.last('hello')?.chainId).toBe(11155111);
  });

  it('accepts a wallet signature over the issued nonce', async () => {
    const { socket } = harness();
    await login(socket);
    expect(socket.last('authed')?.address).toBe(account.address);
  });

  it('rejects a signature over a different nonce', async () => {
    const { socket } = harness();
    const signature = await account.signMessage({ message: `${AUTH_PREFIX}not-the-nonce` });
    await socket.deliver({ type: 'auth', address: account.address, signature });

    expect(socket.last('authed')).toBeUndefined();
    expect(socket.last('error')?.message).toMatch(/does not match the nonce/);
  });

  it('refuses to act before authentication', async () => {
    const { socket } = harness();
    await socket.deliver({ type: 'practice', bots: 3 });
    expect(socket.last('error')?.message).toMatch(/authenticate/);
  });

  it('seats the caller in a practice lobby', async () => {
    const { socket, lobby } = harness();
    await login(socket);
    await socket.deliver({ type: 'practice', bots: 3 });

    expect(lobby.size).toBe(1);
    expect(socket.last('state')?.you).toBe(0);
    expect(socket.last('state')?.chips).toBe(500);
    expect(socket.last('state')?.state.players).toHaveLength(4);
  });

  it('reports a malformed frame instead of dropping the socket', async () => {
    const { socket } = harness();
    await login(socket);
    socket.deliver({} as ClientMessage);
    await new Promise((resolve) => setImmediate(resolve));
    expect(socket.last('error')?.code).toBe('REJECTED');
  });

  it('detaches a closed socket from its room', async () => {
    const { socket, lobby, gateway } = harness();
    await login(socket);
    await socket.deliver({ type: 'practice', bots: 3 });
    const before = socket.sent.length;

    socket.close();
    expect(gateway.connections).toBe(0);

    lobby.tick(60_000);
    // No further frames can reach a detached client.
    expect(socket.sent.length).toBe(before);
  });
});
