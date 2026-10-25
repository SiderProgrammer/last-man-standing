import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { AUTH_PREFIX, type ClientMessage, type ServerMessage } from '@lms/protocol';
import {
  CloseCode,
  Gateway,
  Heartbeat,
  KeyedLimiter,
  Lobby,
  MemoryArchive,
  TokenBucket,
  nullRelayer,
  parseClientMessage,
  peerFrom,
  type GatewayLimits,
  type Peer,
  type Pingable,
  type Socket,
} from '@lms/server';
import { lastOfType } from './helpers.js';

const account = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const BYTES32 = `0x${'ab'.repeat(32)}` as const;
const ADDRESS = `0x${'cd'.repeat(20)}` as const;

/** A socket that records what it was sent and how it was closed. */
class FakeSocket implements Socket {
  readyState = 1;
  bufferedAmount = 0;
  readonly raw: string[] = [];
  closedWith: { code: number; reason: string } | null = null;
  private listeners: { message?: (data: unknown) => void; close?: () => void } = {};

  get sent(): ServerMessage[] {
    return this.raw.map((data) => JSON.parse(data) as ServerMessage);
  }

  send(data: string): void {
    this.raw.push(data);
  }

  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
    this.listeners.close?.();
  }

  onMessage(listener: (data: unknown) => void): void {
    this.listeners.message = listener;
  }

  onClose(listener: () => void): void {
    this.listeners.close = listener;
  }

  async text(data: string): Promise<void> {
    this.listeners.message?.(data);
    await new Promise((resolve) => setImmediate(resolve));
  }

  deliver(message: ClientMessage): Promise<void> {
    return this.text(JSON.stringify(message));
  }

  lastError(): string | undefined {
    return lastOfType(this.sent, 'error')?.message;
  }
}

function harness(
  limits: Partial<GatewayLimits> = {},
  extra: { verify?: () => Promise<boolean> } = {},
) {
  const clock = { now: 0 };
  const lobby = new Lobby({ archive: new MemoryArchive(), relayer: nullRelayer, commitMs: 10_000, revealMs: 5_000 });
  const gateway = new Gateway({
    lobby,
    chainId: 11155111,
    now: () => clock.now,
    directory: () => ({ open: [], live: [] }),
    limits,
    ...(extra.verify ? { verify: extra.verify } : {}),
  });
  const connect = (peer: Peer = { ip: '10.0.0.1' }) => {
    const socket = new FakeSocket();
    const admitted = gateway.accept(socket, peer);
    return { socket, admitted };
  };
  return { gateway, lobby, clock, connect };
}

async function login(socket: FakeSocket): Promise<void> {
  const nonce = lastOfType(socket.sent, 'hello')?.nonce;
  const signature = await account.signMessage({ message: `${AUTH_PREFIX}${nonce}` });
  await socket.deliver({ type: 'auth', address: account.address, signature });
}

describe('token bucket', () => {
  it('allows the burst, refuses past it, and refills at the rate', () => {
    const bucket = new TokenBucket(2, 3, 0);
    expect([bucket.take(0), bucket.take(0), bucket.take(0), bucket.take(0)]).toEqual([true, true, true, false]);
    expect(bucket.take(499)).toBe(false);
    expect(bucket.take(500)).toBe(true);
    expect(bucket.full(10_000)).toBe(true);
  });
});

describe('keyed limiter', () => {
  it('keeps keys apart', () => {
    const limiter = new KeyedLimiter(1, 1);
    expect(limiter.take('a', 0)).toBe(true);
    expect(limiter.take('a', 0)).toBe(false);
    expect(limiter.take('b', 0)).toBe(true);
  });

  it('forgets refilled keys on sweep, so fresh keys cannot grow it forever', () => {
    const limiter = new KeyedLimiter(1, 1);
    limiter.take('a', 0);
    limiter.take('b', 0);
    limiter.sweep(500);
    expect(limiter.size).toBe(2);
    limiter.sweep(1_000);
    expect(limiter.size).toBe(0);
  });

  it('refuses unknown keys past its ceiling, and still serves known ones', () => {
    const limiter = new KeyedLimiter(1, 5, 2);
    limiter.take('a', 0);
    limiter.take('b', 0);
    expect(limiter.take('c', 0)).toBe(false);
    expect(limiter.take('a', 0)).toBe(true);
  });
});

describe('frame validation', () => {
  const parse = (frame: unknown) => () => parseClientMessage(JSON.stringify(frame));

  it('passes well-formed frames through, stripping unknown fields', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'watch', matchId: BYTES32, extra: 1 }))).toEqual({
      type: 'watch',
      matchId: BYTES32,
    });
    expect(parseClientMessage(JSON.stringify({ type: 'practice' }))).toEqual({ type: 'practice' });
    expect(parseClientMessage(JSON.stringify({ type: 'practice', bots: 5, difficulty: 'hard' }))).toEqual({
      type: 'practice',
      bots: 5,
      difficulty: 'hard',
    });
  });

  it('rejects a bot difficulty it does not know', () => {
    expect(parse({ type: 'practice', difficulty: 'nightmare' })).toThrow(/difficulty/);
    expect(parse({ type: 'practice', difficulty: 2 })).toThrow(/difficulty/);
  });

  it('rejects an address that is not an address', () => {
    expect(parse({ type: 'auth', address: 'oops', signature: '0x1234' })).toThrow(/address/);
  });

  /** Players send their own joins on L1: the server relays no session call. */
  it('refuses a relayed call outright', () => {
    const relay = { type: 'relay', target: ADDRESS, value: '0', data: '0x', nonce: '0', signature: '0x12' };
    expect(parse(relay)).toThrow(/unsupported message/);
  });

  it('rejects a target outside a uint8 and an unknown action', () => {
    const reveal = { type: 'reveal', action: 1, target: 0, salt: BYTES32 };
    expect(parse(reveal)).not.toThrow();
    expect(parse({ ...reveal, target: 256 })).toThrow(/target/);
    expect(parse({ ...reveal, target: 1.5 })).toThrow(/target/);
    expect(parse({ ...reveal, action: 9 })).toThrow(/unknown action/);
    expect(parse({ ...reveal, salt: '0x12' })).toThrow(/salt/);
  });

  it('validates a held move as strictly as a reveal', () => {
    expect(parse({ type: 'commit', commitment: BYTES32, hold: 'yes' })).toThrow(/hold/);
    expect(parse({ type: 'commit', commitment: BYTES32, hold: { action: 1, target: 999, salt: BYTES32 } })).toThrow(
      /target/,
    );
  });

  it('validates the match and round a move names, and keeps them', () => {
    const reveal = { type: 'reveal', action: 1, target: 0, salt: BYTES32 };
    expect(parseClientMessage(JSON.stringify({ ...reveal, matchId: BYTES32, round: 3 }))).toEqual({
      ...reveal,
      matchId: BYTES32,
      round: 3,
    });
    expect(parse({ ...reveal, round: -1 })).toThrow(/round/);
    expect(parse({ ...reveal, matchId: '0x12' })).toThrow(/matchId/);
    expect(parse({ type: 'commit', commitment: BYTES32, round: 1.5 })).toThrow(/round/);
  });

  it('rejects an unknown message type', () => {
    expect(parse({ type: 'nope' })).toThrow(/unsupported/);
  });
});

describe('admission', () => {
  it('caps sockets per IP and frees the slot on close', () => {
    const { connect } = harness({ maxConnectionsPerIp: 2 });
    const first = connect();
    connect();
    const third = connect();
    expect(third.admitted).toBe(false);
    expect(third.socket.closedWith?.code).toBe(CloseCode.TryAgainLater);
    expect(connect({ ip: '10.0.0.2' }).admitted).toBe(true);

    first.socket.close(1000, 'bye');
    expect(connect().admitted).toBe(true);
  });

  it('caps sockets across the server', () => {
    const { connect, gateway } = harness({ maxConnections: 2 });
    connect({ ip: 'a' });
    connect({ ip: 'b' });
    const refused = connect({ ip: 'c' });
    expect(refused.admitted).toBe(false);
    expect(refused.socket.closedWith?.reason).toMatch(/full/);
    expect(gateway.connections).toBe(2);
  });

  it('limits how fast one IP may open sockets', () => {
    const { connect, clock } = harness({ connectRatePerIp: 1, connectBurstPerIp: 2 });
    expect(connect().admitted).toBe(true);
    expect(connect().admitted).toBe(true);
    expect(connect().socket.closedWith?.reason).toMatch(/too fast/);
    clock.now += 1_000;
    expect(connect().admitted).toBe(true);
  });

  it('enforces the origin allowlist when one is configured', () => {
    const { connect } = harness({ allowedOrigins: ['https://play.example'] });
    expect(connect({ ip: 'a', origin: 'https://play.example' }).admitted).toBe(true);
    expect(connect({ ip: 'a', origin: 'https://evil.example' }).socket.closedWith?.code).toBe(
      CloseCode.PolicyViolation,
    );
    expect(connect({ ip: 'a' }).admitted).toBe(false);
  });
});

describe('login', () => {
  it('closes a socket that never logs in, which expires its nonce', async () => {
    const { connect, gateway, clock } = harness({ loginTimeoutMs: 10_000 });
    const idle = connect();
    const active = connect();
    await login(active.socket);

    clock.now = 9_999;
    gateway.sweep();
    expect(idle.socket.closedWith).toBeNull();
    clock.now = 10_000;
    gateway.sweep();
    expect(idle.socket.closedWith?.reason).toMatch(/login timed out/);
    expect(active.socket.closedWith).toBeNull();
  });

  it('closes a socket after too many failed logins', async () => {
    const { connect } = harness({ maxLoginFailures: 2 }, { verify: async () => false });
    const { socket } = connect();
    const bad = { type: 'auth', address: account.address, signature: '0x1234' } as const;
    await socket.deliver(bad);
    expect(socket.closedWith).toBeNull();
    await socket.deliver(bad);
    expect(socket.closedWith?.reason).toMatch(/failed logins/);
  });

  it('caps login attempts per IP before they reach the verifier', async () => {
    let asked = 0;
    const { connect } = harness(
      { loginRatePerIp: 0.001, loginBurstPerIp: 2, maxLoginFailures: 100 },
      {
        verify: async () => {
          asked += 1;
          return false;
        },
      },
    );
    const bad = { type: 'auth', address: account.address, signature: '0x1234' } as const;
    // Spread across sockets: opening more connections buys no more attempts.
    for (let i = 0; i < 4; i += 1) await connect().socket.deliver(bad);
    expect(asked).toBe(2);
  });
});

describe('message limits', () => {
  it('disconnects a socket that keeps sending garbage', async () => {
    const { connect } = harness({ strikeBurst: 3, strikeRate: 0 });
    const { socket } = connect();
    for (let i = 0; i < 3; i += 1) await socket.text('not json');
    expect(socket.closedWith).toBeNull();
    await socket.text('not json');
    expect(socket.closedWith?.code).toBe(CloseCode.PolicyViolation);
  });

  it('keeps a budget for moves that other traffic cannot spend', async () => {
    const { connect } = harness({ messageBurst: 3, messageRate: 0, strikeBurst: 100 });
    const { socket } = connect();
    await login(socket);
    await socket.deliver({ type: 'practice', bots: 3 });
    for (let i = 0; i < 5; i += 1) await socket.deliver({ type: 'lobbies' });
    expect(socket.lastError()).toMatch(/slow down/);

    // The general bucket is empty; a commit still reaches the room.
    const errors = socket.sent.filter((message) => message.type === 'error').length;
    await socket.deliver({ type: 'commit', commitment: BYTES32 });
    expect(socket.sent.filter((message) => message.type === 'error')).toHaveLength(errors);
    expect(lastOfType(socket.sent, 'state')?.state.committed).toContain(0);
  });
});

describe('writes', () => {
  it('closes a client that stops reading instead of buffering for it', async () => {
    const { connect } = harness({ maxBufferedBytes: 100 });
    const { socket } = connect();
    socket.bufferedAmount = 101;
    await socket.deliver({ type: 'lobbies' });
    expect(socket.closedWith?.reason).toMatch(/not reading/);
  });

  it('serialises a broadcast once for every socket at the table', async () => {
    const { connect, lobby } = harness();
    const { socket } = connect({ ip: 'a' });
    const watcher = connect({ ip: 'b' }).socket;
    await login(socket);
    await login(watcher);
    await socket.deliver({ type: 'practice', bots: 3 });
    const room = lobby.roomFor(account.address);
    if (!room) throw new Error('no room');
    await watcher.deliver({ type: 'watch', matchId: room.matchId });

    const message = { type: 'settled', matchId: room.matchId, tx: null } as const;
    const stringify = JSON.stringify;
    let calls = 0;
    JSON.stringify = ((...args: Parameters<typeof stringify>) => {
      calls += 1;
      return stringify(...args);
    }) as typeof JSON.stringify;
    try {
      room.announceSettled(message.tx);
    } finally {
      JSON.stringify = stringify;
    }
    expect(calls).toBe(1);
    expect(lastOfType(watcher.sent, 'settled')?.matchId).toBe(room.matchId);
  });
});

describe('heartbeat', () => {
  class FakePeer implements Pingable {
    pings = 0;
    terminated = false;
    private pong?: () => void;
    ping(): void {
      this.pings += 1;
    }
    terminate(): void {
      this.terminated = true;
    }
    onPong(listener: () => void): void {
      this.pong = listener;
    }
    answer(): void {
      this.pong?.();
    }
  }

  it('terminates a socket that misses a ping, and keeps one that answers', () => {
    const heartbeat = new Heartbeat();
    const live = new FakePeer();
    const dead = new FakePeer();
    heartbeat.track(live);
    heartbeat.track(dead);

    heartbeat.sweep();
    live.answer();
    expect(heartbeat.sweep()).toBe(1);
    expect(dead.terminated).toBe(true);
    expect(live.terminated).toBe(false);
    expect(live.pings).toBe(2);
    expect(heartbeat.size).toBe(1);
  });
});

describe('peer identification', () => {
  const request = (headers: Record<string, string>) => ({ headers, socket: { remoteAddress: '1.2.3.4' } });

  it('ignores X-Forwarded-For unless the proxy is trusted', () => {
    const spoofed = request({ 'x-forwarded-for': '9.9.9.9' });
    expect(peerFrom(spoofed, false).ip).toBe('1.2.3.4');
    expect(peerFrom(request({ 'x-forwarded-for': '5.5.5.5, 10.0.0.1' }), true).ip).toBe('5.5.5.5');
    expect(peerFrom(request({}), true).ip).toBe('1.2.3.4');
  });

  it('carries the origin through', () => {
    expect(peerFrom(request({ origin: 'https://play.example' }), false).origin).toBe('https://play.example');
  });
});
