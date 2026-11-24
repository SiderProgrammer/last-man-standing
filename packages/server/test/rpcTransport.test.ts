import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { errorMessage } from '@lms/api';
import { spokeRouterAbi } from '@lms/contracts';
import { createPublicClient } from 'viem';
import { keySigner, narrowerRange, readClient, rpcTransport, viemTxPort } from '@lms/server';

const KEY = 'alch_0123456789abcdefghijk';
const ROUTER = '0x00000000000000000000000000000000000000e5' as const;

let server: Server | null = null;

/** An RPC that answers every request with `status` and `body`, as a JSON-RPC error when `body` is an object. */
async function rpc(status: number, body: string | { code: number; message: string }): Promise<string> {
  const running = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => (text += String(chunk)));
    request.on('end', () => {
      response.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' });
      response.end(
        typeof body === 'string' ? body : JSON.stringify({ jsonrpc: '2.0', id: (JSON.parse(text) as { id: number }).id, error: body }),
      );
    });
  });
  server = running;
  await new Promise<void>((resolve) => running.listen(0, '127.0.0.1', resolve));
  return `127.0.0.1:${(running.address() as AddressInfo).port}`;
}

afterEach(async () => {
  const running = server;
  server = null;
  if (running) await new Promise((resolve) => running.close(resolve));
});

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.unreachable('should have failed'),
    (error: unknown) => error,
  );
}

/** What `error` looks like however it is logged or sent: its message, and everything `console.error` prints of it. */
function printed(error: unknown): string {
  return `${errorMessage(error)}\n${inspect(error, { depth: 10, showHidden: true })}`;
}

const readHub = (url: string) =>
  readClient(84532, url).readContract({ address: ROUTER, abi: spokeRouterAbi, functionName: 'hubChainId' });

describe('rpcTransport', () => {
  it('hides the key when the RPC answers with an error, and keeps what the RPC said', async () => {
    const host = await rpc(200, { code: -32602, message: 'this block range should work: [0x10, 0x19]' });
    const error = await failure(readClient(421614, `http://${host}/v2/${KEY}`).getLogs({ fromBlock: 0n, toBlock: 999n }));
    expect(printed(error)).not.toContain(KEY);
    expect(errorMessage(error)).toContain(`http://${host}/[hidden]`);
    expect(errorMessage(error)).toContain('this block range should work');
    // The filler narrows its range by reading this error.
    expect(narrowerRange(error, 1_000n)).toBe(10n);
  });

  it('hides it under a contract read, which wraps the error in others', async () => {
    const host = await rpc(200, { code: -32602, message: 'no' });
    expect(printed(await failure(readHub(`http://${host}/v2/${KEY}`)))).not.toContain(KEY);
  });

  it('hides it when the RPC answers with an HTTP error that echoes it', async () => {
    const host = await rpc(400, `unknown project ${KEY}`);
    const text = printed(await failure(readHub(`http://${host}/v2/${KEY}`)));
    expect(text).not.toContain(KEY);
    expect(text).toContain('unknown project [hidden]');
  });

  it('hides it when the RPC cannot be reached', async () => {
    const host = await rpc(200, '');
    await new Promise((resolve) => server?.close(resolve));
    server = null;
    const client = createPublicClient({ transport: rpcTransport(`http://${host}/v2/${KEY}`) });
    expect(printed(await failure(client.getChainId()))).not.toContain(KEY);
  });

  it('hides a key in the query string, and credentials', async () => {
    const host = await rpc(200, { code: -32602, message: 'no' });
    expect(printed(await failure(readHub(`http://${host}/?apikey=${KEY}`)))).not.toContain(KEY);
    const text = printed(await failure(readHub(`http://user:${KEY}@${host}/a/b`)));
    expect(text).not.toContain(KEY);
  });

  it('hides it from what the transaction sender throws', async () => {
    const host = await rpc(200, { code: -32602, message: 'no' });
    const port = viemTxPort({ signer: keySigner(`0x${'11'.repeat(32)}`), chainId: 84532, rpcUrl: `http://${host}/v2/${KEY}` });
    const call = { address: ROUTER, abi: spokeRouterAbi, functionName: 'hubChainId', args: [] };
    expect(printed(await failure(port.simulate(call)))).not.toContain(KEY);
  });

  it('leaves the answer of a working RPC alone', async () => {
    const running = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x14a34' }));
    });
    server = running;
    await new Promise<void>((resolve) => running.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(running.address() as AddressInfo).port}/v2/${KEY}`;
    expect(await readClient(84532, url).getChainId()).toBe(84532);
  });

  it('is the only way the server reaches an RPC', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : [path];
      });
    const importers = files(src).filter((path) =>
      [...readFileSync(path, 'utf8').matchAll(/import\s*\{([^}]*)\}\s*from 'viem'/g)].some(([, names]) =>
        /\b(?:http|webSocket|custom|fallback)\b/.test(names ?? ''),
      ),
    );
    expect(importers).toEqual([join(src, 'chain', 'viem.ts')]);
  });
});
