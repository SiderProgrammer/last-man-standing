import { createServer } from 'node:http';
import { createPublicClient, http as httpTransport } from 'viem';
import { WebSocketServer } from 'ws';
import { config, ZERO_ADDRESS } from './config.js';
import { Gateway, type Socket } from './gateway.js';
import { Lobby } from './lobby.js';
import { createArchive } from './store.js';
import { relayerFromEnv } from './attestor.js';
import { ChainBridge } from './chain.js';
import { AvatarRegistry, parseCollections } from './avatars.js';
import { createSessionRelayer, nullSessionRelayer } from './relayer.js';

export { Room, type Client, type RoomOptions } from './room.js';
export { Lobby, type LobbyOptions } from './lobby.js';
export { Gateway, type GatewayOptions, type Socket, type SignatureVerifier } from './gateway.js';
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
export { ChainBridge, type ChainBridgeOptions } from './chain.js';
export {
  createSessionRelayer,
  nullSessionRelayer,
  type ChainRelayerOptions,
  type SessionCall,
  type SessionRelayer,
} from './relayer.js';
export {
  AvatarRegistry,
  parseCollections,
  type AvatarCollection,
  type AvatarRegistryOptions,
  type AvatarSubject,
} from './avatars.js';
export { config } from './config.js';

const TICK_MS = 250;

export async function main(): Promise<void> {
  const archive = await createArchive(config.databaseUrl);
  const relayer = relayerFromEnv();

  const avatarCollections = parseCollections(config.avatarCollections);
  const avatars = new AvatarRegistry({
    collections: avatarCollections,
    gateway: config.ipfsGateway,
  });

  const lobby = new Lobby({
    archive,
    relayer,
    commitMs: config.commitMs,
    revealMs: config.revealMs,
    startingChips: config.startingChips,
    avatars,
  });

  const bridge = config.onChain
    ? ChainBridge.start({
        rpcUrl: config.rpcUrl,
        chainId: config.chainId,
        escrow: config.escrow,
        lobby,
        ...(config.keeperPk ? { keeperKey: config.keeperPk } : {}),
      })
    : null;

  // With an RPC the gateway can verify ERC-1271 logins, which is what lets a
  // 7702-delegated account log in with a session key instead of prompting the
  // player's wallet on every reconnect. Without one, EOA signatures still work.
  const rpc = config.rpcUrl
    ? createPublicClient({ transport: httpTransport(config.rpcUrl) })
    : null;

  // Pays gas for session-authorised calls. It holds no authority over any
  // player account: the delegate checks the session signature on-chain.
  const sessionRelayer =
    rpc && config.keeperPk && config.sessionDelegate !== ZERO_ADDRESS
      ? createSessionRelayer({
          rpcUrl: config.rpcUrl,
          chainId: config.chainId,
          relayerKey: config.keeperPk,
        })
      : nullSessionRelayer;

  const gateway = new Gateway({
    lobby,
    chainId: config.chainId,
    escrow: config.onChain ? config.escrow : null,
    directory: () => bridge?.directory() ?? { open: [], live: [] },
    avatarCollections: avatarCollections.map(({ chainId, address }) => ({ chainId, address })),
    ...(rpc ? { verify: (args) => rpc.verifyMessage(args) } : {}),
    // Only offered when logins can actually be verified on-chain.
    sessionDelegate: rpc && config.sessionDelegate !== ZERO_ADDRESS ? config.sessionDelegate : null,
    relayer: sessionRelayer,
  });

  const http = createServer((request, response) => {
    if (request.url === '/health') {
      const directory = bridge?.directory() ?? { open: [], live: [] };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: true,
          rooms: lobby.size,
          clients: gateway.connections,
          onChain: config.onChain,
          lobbies: { open: directory.open.length, live: directory.live.length },
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http });
  wss.on('connection', (socket) => gateway.accept(socket as unknown as Socket));

  const ticker = setInterval(() => lobby.tick(), TICK_MS);
  ticker.unref();

  console.log(
    config.onChain
      ? `[server] watching escrow ${config.escrow} on chain ${config.chainId}`
      : '[server] no escrow configured: practice lobbies only',
  );

  if (sessionRelayer.enabled) {
    console.log(`[server] relaying session calls through ${config.sessionDelegate}`);
  }

  if (!avatars.empty) {
    console.log(`[server] avatar collections on chains ${avatars.chains.join(', ')}`);
  }

  http.listen(config.port, () => {
    console.log(`[server] listening on :${config.port}`);
  });

  const shutdown = () => {
    bridge?.stop();
    clearInterval(ticker);
    wss.close();
    http.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

// Only boot when executed directly, so the package can also be imported.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  void main().catch((error: unknown) => {
    console.error('[server] failed to start', error);
    process.exitCode = 1;
  });
}
