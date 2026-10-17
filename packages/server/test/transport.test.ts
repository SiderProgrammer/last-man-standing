import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket as NetSocket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MAX_CLIENT_FRAME_BYTES } from '@lms/protocol';
import { Gateway, Lobby, MemoryArchive, WS_SERVER_OPTIONS, attachTransport, nullRelayer } from '@lms/server';

/**
 * The transport against a real `ws` server on a loopback port: the gateway
 * tests use fakes, and the failure this guards against lives in `ws` itself.
 */
let http: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
  http = null;
});

async function serve(): Promise<string> {
  const lobby = new Lobby({ archive: new MemoryArchive(), relayer: nullRelayer, commitMs: 10_000, revealMs: 5_000 });
  const gateway = new Gateway({ lobby, chainId: 1, directory: () => ({ open: [], live: [] }) });
  http = createServer();
  const wss = new WebSocketServer({ server: http, ...WS_SERVER_OPTIONS });
  attachTransport(wss, gateway, { trustProxy: false });
  http.on('close', () => {
    for (const client of wss.clients) client.terminate();
  });
  await new Promise<void>((resolve) => http?.listen(0, '127.0.0.1', resolve));
  return `ws://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

/** Opens a socket and resolves with it once the server's `hello` arrives. */
function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('message', () => resolve(socket));
    socket.once('error', reject);
  });
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', (code) => resolve(code)));
}

describe('websocket transport', () => {
  it('closes a socket that sends an oversized frame, and keeps serving everyone else', async () => {
    const url = await serve();
    const bystander = await connect(url);
    const attacker = await connect(url);

    const code = closed(attacker);
    attacker.send('x'.repeat(MAX_CLIENT_FRAME_BYTES * 4));
    expect(await code).toBe(1009);

    expect(bystander.readyState).toBe(WebSocket.OPEN);
    const late = await connect(url);
    expect(late.readyState).toBe(WebSocket.OPEN);
    bystander.close();
    late.close();
  });

  it('survives a frame that breaks the WebSocket protocol', async () => {
    const url = await serve();
    const attacker = await connect(url);
    const code = closed(attacker);
    // A masked frame with reserved opcode 0x3, written under the client library.
    const raw = (attacker as unknown as { _socket: NetSocket })._socket;
    raw.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0]));
    expect(await code).toBe(1002);

    const next = await connect(url);
    expect(next.readyState).toBe(WebSocket.OPEN);
    next.close();
  });
});
