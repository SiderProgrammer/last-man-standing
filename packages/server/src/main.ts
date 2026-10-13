/**
 * Composition root: reads the config, wires every component together, and
 * starts listening. The only file in the package with side effects at the
 * top level, which is why it is not the one `@lms/server` resolves to.
 */
import { createServer } from 'node:http';
import { createPublicClient, http as httpTransport } from 'viem';
import { WebSocketServer } from 'ws';
import { config, ZERO_ADDRESS } from './config.js';
import { Gateway } from './gateway/gateway.js';
import { Lobby } from './lobby/lobby.js';
import { createArchive } from './lobby/store.js';
import { relayerFromEnv } from './chain/attestor.js';
import { ChainBridge } from './chain/bridge.js';
import { AvatarRegistry, parseCollections } from './chain/avatars.js';
import { createSessionRelayer, nullSessionRelayer } from './chain/relayer.js';
import { parseZapTokens, zapInfo } from './chain/zap.js';
import { FeeKeeper, feeKeeperPolicy, viemFeeRouter } from './chain/feeKeeper.js';
import { airdropResponse, loadAirdropFile, type AirdropBook } from './chain/airdropFile.js';
import { ProposalIndex, proposalsResponse } from './chain/proposals.js';
import { lmsAirdropAbi } from '@lms/protocol';

const TICK_MS = 250;

async function main(): Promise<void> {
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
    replayMs: config.replayMs,
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

  // Pays into the escrow, so it is only offered alongside one.
  const zap = config.onChain
    ? zapInfo(config.zapJoin, config.v4Quoter, parseZapTokens(config.zapTokens))
    : null;

  // Proofs for the client's one-click claim. Served only when the file's root is
  // the one the deployed airdrop checks, so a stale file cannot be offered.
  const airdrop = await loadAirdrop(rpc);

  // Proposals made to the governor, which cannot list its own.
  const proposals =
    config.rpcUrl && config.governor !== ZERO_ADDRESS
      ? ProposalIndex.start({
          rpcUrl: config.rpcUrl,
          chainId: config.chainId,
          governor: config.governor,
          fromBlock: config.governorFromBlock,
        })
      : null;

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
    zap,
    staking:
      config.stakedLms !== ZERO_ADDRESS
        ? {
            vault: config.stakedLms,
            airdrop: airdrop ? config.airdrop : null,
            governor: proposals ? config.governor : null,
            feeRouter: config.feeRouter !== ZERO_ADDRESS ? config.feeRouter : null,
          }
        : null,
  });

  const http = createServer((request, response) => {
    const route = airdropResponse(airdrop, request.url ?? '') ?? proposalsResponse(proposals, request.url ?? '');
    if (route) {
      // Read by the client from its own origin, which is not this one.
      response.writeHead(route.status, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
      response.end(route.body);
      return;
    }
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
  // `ws` speaks `on(event, listener)`; the gateway wants two named methods, so
  // the shapes are bridged here rather than by casting the socket into place.
  wss.on('connection', (socket) =>
    gateway.accept({
      get readyState() {
        return socket.readyState;
      },
      send: (data) => socket.send(data),
      onMessage: (listener) => void socket.on('message', listener),
      onClose: (listener) => void socket.on('close', listener),
    }),
  );

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

  if (zap) {
    console.log(`[server] token joins via ${zap.address}: ${zap.tokens.map((t) => t.symbol).join(', ')}`);
  }

  // Harvests fees on a timer so they reach stakers. Holds no authority:
  // `harvest` is open to anyone and pays only where the router already sends.
  let feeKeeper: FeeKeeper | null = null;
  if (config.rpcUrl && config.keeperPk && config.feeRouter !== ZERO_ADDRESS) {
    const port = await viemFeeRouter({
      rpcUrl: config.rpcUrl,
      chainId: config.chainId,
      router: config.feeRouter,
      keeperKey: config.keeperPk,
    });
    feeKeeper = new FeeKeeper(port, feeKeeperPolicy(config.feeKeeper));
    feeKeeper.start(config.feeKeeperPollMs);
    console.log(`[server] harvesting fees for router ${config.feeRouter}`);
  }

  if (!avatars.empty) {
    console.log(`[server] avatar collections on chains ${avatars.chains.join(', ')}`);
  }

  http.listen(config.port, () => {
    console.log(`[server] listening on :${config.port}`);
  });

  const shutdown = () => {
    bridge?.stop();
    feeKeeper?.stop();
    proposals?.stop();
    clearInterval(ticker);
    wss.close();
    http.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main().catch((error: unknown) => {
  console.error('[server] failed to start', error);
  process.exitCode = 1;
});

async function loadAirdrop(rpc: ReturnType<typeof createPublicClient> | null): Promise<AirdropBook | null> {
  if (!config.airdropFile || config.airdrop === ZERO_ADDRESS) return null;
  try {
    const book = loadAirdropFile(config.airdropFile);
    if (rpc) {
      const root = await rpc.readContract({ address: config.airdrop, abi: lmsAirdropAbi, functionName: 'merkleRoot' });
      if (root.toLowerCase() !== book.root.toLowerCase()) {
        console.error(`[server] ${config.airdropFile} has root ${book.root}, but the airdrop checks ${root}; not serving it`);
        return null;
      }
    }
    console.log(`[server] serving ${book.size} airdrop claims for ${config.airdrop}`);
    return book;
  } catch (error) {
    console.error('[server] could not load the airdrop file:', error);
    return null;
  }
}
