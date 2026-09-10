import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { Gateway, type Socket } from './gateway.js';
import { Lobby } from './lobby.js';
import { createArchive } from './store.js';
import { relayerFromEnv } from './attestor.js';
import { watchChain } from './chain.js';

export { Room, type Client, type RoomOptions } from './room.js';
export { Lobby, type LobbyOptions } from './lobby.js';
export { Gateway, type GatewayOptions, type Socket } from './gateway.js';
export {
  MemoryArchive,
  PostgresArchive,
  createArchive,
  type ArchivedMatch,
  type MatchArchive,
} from './store.js';
export {
  signResult,
  packSignatures,
  createRelayer,
  nullRelayer,
  type Relayer,
} from './attestor.js';
export { watchChain, type ChainWatcherOptions } from './chain.js';
export { config } from './config.js';

const TICK_MS = 250;

export async function main(): Promise<void> {
  const archive = await createArchive(config.databaseUrl);
  const relayer = relayerFromEnv();

  const lobby = new Lobby({
    archive,
    relayer,
    commitMs: config.commitMs,
    revealMs: config.revealMs,
    startingChips: config.startingChips,
  });

  const gateway = new Gateway({ lobby, chainId: config.chainId });

  const http = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, rooms: lobby.size, clients: gateway.connections }));
      return;
    }
    response.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http });
  wss.on('connection', (socket) => gateway.accept(socket as unknown as Socket));

  const ticker = setInterval(() => lobby.tick(), TICK_MS);
  ticker.unref();

  let unwatch: (() => void) | null = null;
  if (config.rpcUrl && config.escrow !== ZERO_ADDRESS) {
    unwatch = watchChain({
      rpcUrl: config.rpcUrl,
      chainId: config.chainId,
      escrow: config.escrow,
      lobby,
    });
    console.log(`[server] watching escrow ${config.escrow} on chain ${config.chainId}`);
  } else {
    console.log('[server] no escrow configured: practice lobbies only');
  }

  http.listen(config.port, () => {
    console.log(`[server] listening on :${config.port}`);
  });

  const shutdown = () => {
    unwatch?.();
    clearInterval(ticker);
    wss.close();
    http.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Only boot when executed directly, so the package can also be imported.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  void main().catch((error: unknown) => {
    console.error('[server] failed to start', error);
    process.exitCode = 1;
  });
}
