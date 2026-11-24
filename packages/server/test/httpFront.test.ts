import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { HttpFront } from '@lms/server';

const open: Array<{ close(): unknown }> = [];
afterEach(() => {
  for (const server of open.splice(0)) server.close();
});

async function listening(): Promise<{ front: HttpFront; port: number }> {
  const front = new HttpFront();
  open.push(front.server);
  await front.listen(0);
  return { front, port: (front.server.address() as AddressInfo).port };
}

/** How a handshake ended: accepted, or refused with a status. */
function handshake(port: number): Promise<'open' | number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once('open', () => {
      socket.close();
      resolve('open');
    });
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once('error', reject);
  });
}

describe('a port open before the server is', () => {
  it('passes a health check, and turns everything else away to be retried', async () => {
    const { port } = await listening();

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, starting: true });

    const other = await fetch(`http://127.0.0.1:${port}/proposals`);
    expect(other.status).toBe(503);
    expect(other.headers.get('retry-after')).toBe('5');
    expect(await handshake(port)).toBe(503);
  });

  it('becomes the real server on the same port', async () => {
    const { front, port } = await listening();
    expect(await handshake(port)).toBe(503);

    const wss = new WebSocketServer({ server: front.server });
    open.push(wss);
    front.serve((_request, response) => response.end('playing'));
    await front.listen(0);

    expect(await (await fetch(`http://127.0.0.1:${port}/health`)).text()).toBe('playing');
    expect(await handshake(port)).toBe('open');
  });

  it('rejects when the port is taken', async () => {
    const taken = createServer();
    open.push(taken);
    await new Promise<void>((resolve) => taken.listen(0, resolve));
    const front = new HttpFront();
    await expect(front.listen((taken.address() as AddressInfo).port)).rejects.toThrow(/EADDRINUSE/);
  });
});
