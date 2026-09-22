import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { AUTH_PREFIX, type ClientMessage, type LobbyInfo, type ServerMessage } from '@lms/protocol';
import { Gateway, Lobby, MemoryArchive, nullRelayer } from '@lms/server';
import type { SignatureVerifier, Socket } from '@lms/server';
import { lastOfType } from './helpers.js';

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);

/** In-process stand-in for a `ws` socket. */
class FakeSocket implements Socket {
  readyState = 1;
  readonly sent: ServerMessage[] = [];
  private listeners: { message?: (data: unknown) => void; close?: () => void } = {};

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }

  onMessage(listener: (data: unknown) => void): void {
    this.listeners.message = listener;
  }

  onClose(listener: () => void): void {
    this.listeners.close = listener;
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
    return lastOfType(this.sent, type);
  }
}

const ESCROW = `0x${'ab'.repeat(20)}` as const;

function openLobby(): LobbyInfo {
  return {
    matchId: `0x${'cd'.repeat(32)}`,
    stake: '1000000000000000',
    seatCount: 2,
    maxSeats: 4,
    minSeats: 2,
    joinDeadline: 1_800_000_000,
    status: 'open',
    players: [{ address: account.address, chainId: 11155111 }],
  };
}

interface Extras {
  escrow: `0x${string}` | null;
  directory: () => { open: LobbyInfo[]; live: LobbyInfo[] };
  verify: SignatureVerifier;
  sessionDelegate: `0x${string}` | null;
}

function harness(extras: Partial<Extras> = {}) {
  const lobby = new Lobby({
    archive: new MemoryArchive(),
    relayer: nullRelayer,
    commitMs: 10_000,
    revealMs: 5_000,
    startingChips: 500,
  });
  const gateway = new Gateway({
    lobby,
    chainId: 11155111,
    now: () => 0,
    escrow: extras.escrow ?? null,
    directory: extras.directory ?? (() => ({ open: [], live: [] })),
    ...(extras.verify ? { verify: extras.verify } : {}),
    sessionDelegate: extras.sessionDelegate ?? null,
  });
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

  it('advertises the escrow so the client knows where to stake', () => {
    const { socket } = harness({ escrow: ESCROW });
    expect(socket.last('hello')?.escrow).toBe(ESCROW);
  });

  it('reports practice-only mode when no escrow is configured', () => {
    const { socket } = harness();
    expect(socket.last('hello')?.escrow).toBeNull();
  });

  it('serves the chain lobby directory', async () => {
    const info = openLobby();
    const { socket } = harness({ escrow: ESCROW, directory: () => ({ open: [info], live: [] }) });
    await login(socket);
    await socket.deliver({ type: 'lobbies' });

    expect(socket.last('lobbies')?.open).toEqual([info]);
    expect(socket.last('lobbies')?.live).toEqual([]);
  });

  it('serves an empty directory when the server runs without a chain', async () => {
    const { socket } = harness();
    await login(socket);
    await socket.deliver({ type: 'lobbies' });
    expect(socket.last('lobbies')).toEqual({ type: 'lobbies', open: [], live: [] });
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

  it('advertises the session delegate so the client can offer one-click play', () => {
    const delegate = `0x${'99'.repeat(20)}` as const;
    const { socket } = harness({ sessionDelegate: delegate });
    expect(socket.last('hello')?.sessionDelegate).toBe(delegate);
  });

  it('advertises no delegate when the server cannot verify one', () => {
    const { socket } = harness();
    expect(socket.last('hello')?.sessionDelegate).toBeNull();
  });

  /**
   * A 7702-delegated account logs in with a session key, so the signature does
   * not recover to the account address and only an ERC-1271 call can settle it.
   * The gateway must ask the injected verifier rather than assume `ecrecover`.
   */
  it('accepts a login the injected verifier approves but ecrecover would not', async () => {
    const asked: Array<{ address: string; message: string }> = [];
    const stranger = privateKeyToAccount(`0x${'22'.repeat(32)}`);
    const { socket } = harness({
      verify: async (args) => {
        asked.push({ address: args.address, message: args.message });
        return true;
      },
    });

    const nonce = socket.last('hello')?.nonce ?? '';
    // Signed by a different key entirely: stands in for a session key.
    const signature = await stranger.signMessage({ message: `${AUTH_PREFIX}${nonce}` });
    await socket.deliver({ type: 'auth', address: account.address, signature });

    expect(socket.last('authed')?.address).toBe(account.address);
    expect(asked).toEqual([{ address: account.address, message: `${AUTH_PREFIX}${nonce}` }]);
  });

  it('rejects a login the verifier refuses', async () => {
    const { socket } = harness({ verify: async () => false });

    const nonce = socket.last('hello')?.nonce ?? '';
    const signature = await account.signMessage({ message: `${AUTH_PREFIX}${nonce}` });
    await socket.deliver({ type: 'auth', address: account.address, signature });

    expect(socket.last('authed')).toBeUndefined();
    expect(socket.last('error')?.code).toBe('REJECTED');
  });
});
