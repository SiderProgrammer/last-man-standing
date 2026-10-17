/**
 * Composition root: reads the config, wires every component together, and
 * starts listening. The only file in the package with side effects at the
 * top level, which is why it is not the one `@lms/server` resolves to.
 */
import { createServer } from 'node:http';
import { createPublicClient, http as httpTransport, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { WebSocketServer } from 'ws';
import { config, ZERO_ADDRESS } from './config.js';
import { Gateway } from './gateway/gateway.js';
import { WS_SERVER_OPTIONS, attachTransport } from './gateway/transport.js';
import { Lobby } from './lobby/lobby.js';
import { createArchive } from './lobby/store.js';
import { createStyleBook } from './lobby/styles.js';
import { relayerFromEnv } from './chain/attestor.js';
import { ChainBridge } from './chain/bridge.js';
import { AvatarRegistry, parseCollections } from './chain/avatars.js';
import { createSessionRelayer, nullSessionRelayer } from './chain/relayer.js';
import { parseZapTokens, zapInfo } from './chain/zap.js';
import { FeeKeeper, feeKeeperPolicy, viemFeeRouter } from './chain/feeKeeper.js';
import { ProposalIndex, proposalsResponse } from './chain/proposals.js';
import { CrossChainMonitor, parseSpokes, viemHubSource, viemSpokeSource } from './chain/crossChain.js';
import { readClient } from './chain/viem.js';
import { log } from './observability/log.js';
import { collectProcessMetrics, heartbeatTerminated, registry } from './observability/metrics.js';
import { startTracing } from './observability/tracing.js';
import { BalanceWatcher } from './observability/balances.js';

const logger = log.child({ component: 'server' });

const TICK_MS = 250;
/** How often unauthenticated sockets and stale rate-limit state are cleared. */
const SWEEP_MS = 1_000;
/** A socket that misses a ping for this long is terminated. */
const HEARTBEAT_MS = 30_000;

async function main(): Promise<void> {
  // First, so every span created while wiring up is exported.
  const stopTracing = await startTracing();
  collectProcessMetrics();

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
    styles: await createStyleBook(config.databaseUrl),
    maxPracticeRooms: config.maxPracticeRooms,
  });


  const bridge = config.onChain
    ? ChainBridge.start({
        rpcUrl: config.rpcUrl,
        chainId: config.chainId,
        escrow: config.escrow,
        lobby,
        ...(config.keeperPk ? { keeperKey: config.keeperPk } : {}),
        // A restart loses every room in progress. Matches that were live are
        // aborted and refunded rather than restarted from round one.
        abort: (matchId) => relayer.abort(matchId),
      })
    : null;

  // With an RPC the gateway can verify ERC-1271 logins, which is what lets a
  // 7702-delegated account log in with a session key instead of prompting the
  // player's wallet on every reconnect. Without one, EOA signatures still work.
  const rpc = config.rpcUrl
    ? createPublicClient({ transport: httpTransport(config.rpcUrl) })
    : null;

  // Pays gas for session-authorised calls and for pushing payouts. It holds no
  // authority over any player account: the delegate checks the session
  // signature on-chain, and `withdrawFor` only ever pays the account itself.
  const sessionRelayer =
    rpc && config.keeperPk && (config.sessionDelegate !== ZERO_ADDRESS || config.onChain)
      ? createSessionRelayer({
          rpcUrl: config.rpcUrl,
          chainId: config.chainId,
          relayerKey: config.keeperPk,
          ...(config.onChain ? { escrow: config.escrow } : {}),
        })
      : nullSessionRelayer;

  // Pays into the escrow, so it is only offered alongside one.
  const zap = config.onChain
    ? zapInfo(config.zapJoin, config.v4Quoter, parseZapTokens(config.zapTokens))
    : null;


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
            governor: proposals ? config.governor : null,
            feeRouter: config.feeRouter !== ZERO_ADDRESS ? config.feeRouter : null,
          }
        : null,
    limits: {
      maxConnections: config.maxConnections,
      maxConnectionsPerIp: config.maxConnectionsPerIp,
      loginTimeoutMs: config.loginTimeoutMs,
      allowedOrigins: config.allowedOrigins,
    },
  });

  const http = createServer((request, response) => {
    const route = proposalsResponse(proposals, request.url ?? '');
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

  const wss = new WebSocketServer({ server: http, ...WS_SERVER_OPTIONS });
  const heartbeat = attachTransport(wss, gateway, { trustProxy: config.trustProxy });

  const ticker = setInterval(() => lobby.tick(), TICK_MS);
  ticker.unref();
  const sweeper = setInterval(() => gateway.sweep(), SWEEP_MS);
  sweeper.unref();
  const beat = setInterval(() => heartbeatTerminated.inc(heartbeat.sweep()), HEARTBEAT_MS);
  beat.unref();

  if (config.onChain) logger.info('watching escrow', { escrow: config.escrow, chainId: config.chainId });
  else logger.info('no escrow configured: practice lobbies only');

  if (sessionRelayer.enabled) {
    logger.info('relaying session calls', { delegate: config.sessionDelegate });
  }

  if (zap) {
    logger.info('token joins enabled', { zap: zap.address, tokens: zap.tokens.map((t) => t.symbol) });
  }

  // Joins in flight from spokes to the hub. Needs the hub escrow and at least
  // one spoke; without either there is nothing to reconcile.
  const spokes = parseSpokes(config.spokes);
  const crossChain =
    config.onChain && spokes.length > 0
      ? new CrossChainMonitor({
          hubChainId: config.chainId,
          hub: viemHubSource(config.chainId, config.rpcUrl, config.escrow),
          spokes: spokes.map((spoke) => ({
            chainId: spoke.chainId,
            source: viemSpokeSource(spoke.chainId, spoke.rpcUrl, spoke.escrow),
          })),
          stuckAfterMs: config.crossChainStuckMs,
        }).start()
      : null;
  if (crossChain) logger.info('watching cross-chain joins', { spokes: spokes.map((spoke) => spoke.chainId) });

  // Every key the server spends gas from, so an alert fires before one runs dry.
  const wallets: Array<{ role: string; address: Address }> = [];
  if (config.attestorPk) wallets.push({ role: 'attestor', address: privateKeyToAccount(config.attestorPk).address });
  if (config.keeperPk) wallets.push({ role: 'keeper', address: privateKeyToAccount(config.keeperPk).address });
  const balances =
    config.rpcUrl && wallets.length > 0
      ? new BalanceWatcher((address) => readClient(config.chainId, config.rpcUrl).getBalance({ address }), wallets).start()
      : null;

  // Apart from the public port, so players can never reach it.
  const metrics = config.metricsPort
    ? createServer((request, response) => {
        if (request.url !== '/metrics') {
          response.writeHead(404).end();
          return;
        }
        void registry.metrics().then(
          (body) => {
            response.writeHead(200, { 'content-type': registry.contentType });
            response.end(body);
          },
          (error: unknown) => {
            response.writeHead(500).end(String(error));
          },
        );
      })
    : null;
  metrics?.listen(config.metricsPort, config.metricsHost, () => {
    logger.info('metrics listening', { host: config.metricsHost, port: config.metricsPort });
  });

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
    logger.info('harvesting fees', { router: config.feeRouter });
  }

  if (!avatars.empty) {
    logger.info('avatar collections', { chains: avatars.chains });
  }

  http.listen(config.port, () => {
    logger.info('listening', { port: config.port });
  });

  const shutdown = () => {
    bridge?.stop();
    feeKeeper?.stop();
    proposals?.stop();
    clearInterval(ticker);
    clearInterval(sweeper);
    clearInterval(beat);
    crossChain?.stop();
    balances?.stop();
    wss.close();
    http.close();
    metrics?.close();
    void stopTracing();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main().catch((error: unknown) => {
  logger.error('failed to start', { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  process.exitCode = 1;
});
