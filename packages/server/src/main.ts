/**
 * Composition root: reads the config, wires every component together, and
 * starts listening. The only file in the package with side effects at the
 * top level, which is why it is not the one `@lms/server` resolves to.
 */
import { createServer } from 'node:http';
import { createPublicClient, http as httpTransport } from 'viem';
import { WebSocketServer } from 'ws';
import { MAX_CLIENT_FRAME_BYTES } from '@lms/protocol';
import { config, ZERO_ADDRESS } from './config.js';
import { Gateway } from './gateway/gateway.js';
import { Heartbeat } from './gateway/heartbeat.js';
import { peerFrom } from './gateway/peer.js';
import { VerifyPool, layeredVerifier } from './gateway/verifyPool.js';
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
import { Analyst } from './analyst/analyst.js';
import { geminiModel } from './analyst/gemini.js';
import { AnalystLimits } from './analyst/limits.js';

const TICK_MS = 250;
/** How often unauthenticated sockets and stale rate-limit state are cleared. */
const SWEEP_MS = 1_000;
/** A socket that misses a ping for this long is terminated. */
const HEARTBEAT_MS = 30_000;

async function main(): Promise<void> {
  const archive = await createArchive(config.databaseUrl);
  const relayer = relayerFromEnv();

  const avatarCollections = parseCollections(config.avatarCollections);
  const avatars = new AvatarRegistry({
    collections: avatarCollections,
    gateway: config.ipfsGateway,
  });

  const styles = await createStyleBook(config.databaseUrl);
  const lobby = new Lobby({
    archive,
    relayer,
    commitMs: config.commitMs,
    revealMs: config.revealMs,
    replayMs: config.replayMs,
    avatars,
    styles,
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
  // Either way an EOA login is settled by local recovery on the verify pool,
  // and only a signature that does not recover is put to the RPC.
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

  const verifyPool = new VerifyPool(config.verifyThreads);

  // Reads finished matches from the archive and nothing else; see `analyst/analyst.ts`.
  const analystLimits = new AnalystLimits({
    perWalletPerHour: config.analyst.quotaPerHour,
    maxConcurrent: config.analyst.maxConcurrent,
    dailyBudgetUsd: config.analyst.dailyBudgetUsd,
    requestsPerMinute: config.analyst.requestsPerMinute,
    requestsPerDay: config.analyst.requestsPerDay,
  });
  const analyst = config.analyst.enabled
    ? new Analyst({
        archive,
        model: geminiModel({
          apiKey: config.analyst.geminiApiKey,
          baseUrl: config.analyst.geminiBaseUrl,
          timeoutMs: config.analyst.timeoutMs,
          maxRetries: config.analyst.maxRetries,
        }),
        modelId: config.analyst.model,
        effort: config.analyst.effort,
        maxTokens: config.analyst.maxTokens,
        deadlineMs: config.analyst.deadlineMs,
        limits: analystLimits,
        styles,
      })
    : undefined;

  const gateway = new Gateway({
    lobby,
    chainId: config.chainId,
    escrow: config.onChain ? config.escrow : null,
    directory: () => bridge?.directory() ?? { open: [], live: [] },
    avatarCollections: avatarCollections.map(({ chainId, address }) => ({ chainId, address })),
    verify: layeredVerifier(verifyPool.verify, rpc ? (args) => rpc.verifyMessage(args) : undefined),
    // Only offered when logins can actually be verified on-chain.
    sessionDelegate: rpc && config.sessionDelegate !== ZERO_ADDRESS ? config.sessionDelegate : null,
    relayer: sessionRelayer,
    ...(analyst ? { analyst } : {}),
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
      ...config.gatewayLimits,
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
          analyst: analyst
            ? {
                model: config.analyst.model,
                requestsToday: analystLimits.requests,
                spentTodayUsd: Math.round(analystLimits.spent * 1e4) / 1e4,
              }
            : null,
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });

  const wss = new WebSocketServer({
    server: http,
    // `ws` defaults to 100 MiB. Refusing at the transport means an oversized
    // frame is never buffered at all; the gateway's own check stays as the
    // backstop for anything that reaches it some other way.
    maxPayload: MAX_CLIENT_FRAME_BYTES,
    // Compression costs memory per socket and opens decompression bombs, for
    // frames that are a few hundred bytes of JSON.
    perMessageDeflate: false,
  });
  const heartbeat = new Heartbeat();
  // `ws` speaks `on(event, listener)`; the gateway wants two named methods, so
  // the shapes are bridged here rather than by casting the socket into place.
  wss.on('error', (error) => console.error('[server] websocket server error:', error.message));
  wss.on('connection', (socket, request) => {
    // First, before anything can fail: `ws` reports protocol violations — a
    // frame over `maxPayload`, invalid UTF-8, a bad opcode — as an `error`
    // event, and one with no listener is thrown, taking the whole process
    // down on one malformed frame. With a listener, `ws` closes that socket.
    socket.on('error', () => undefined);
    const admitted = gateway.accept(
      {
        get readyState() {
          return socket.readyState;
        },
        get bufferedAmount() {
          return socket.bufferedAmount;
        },
        send: (data) => socket.send(data),
        close: (code, reason) => socket.close(code, reason),
        onMessage: (listener) => void socket.on('message', listener),
        onClose: (listener) => void socket.on('close', listener),
      },
      peerFrom(request, config.trustProxy),
    );
    if (!admitted) return;
    const pingable = {
      ping: () => socket.ping(),
      terminate: () => socket.terminate(),
      onPong: (listener: () => void) => void socket.on('pong', listener),
    };
    heartbeat.track(pingable);
    socket.on('close', () => heartbeat.untrack(pingable));
  });

  const ticker = setInterval(() => lobby.tick(), TICK_MS);
  ticker.unref();
  const sweeper = setInterval(() => {
    gateway.sweep();
    analystLimits.sweep(Date.now());
  }, SWEEP_MS);
  sweeper.unref();
  const beat = setInterval(() => heartbeat.sweep(), HEARTBEAT_MS);
  beat.unref();

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

  console.log(
    analyst
      ? `[server] match analyst on ${config.analyst.model} at ${config.analyst.effort} effort, ` +
          `${config.analyst.requestsPerMinute} requests a minute, ${config.analyst.requestsPerDay} a day`
      : '[server] no GEMINI_API_KEY: match analysis unavailable',
  );

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
    clearInterval(sweeper);
    clearInterval(beat);
    wss.close();
    http.close();
    void verifyPool.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main().catch((error: unknown) => {
  console.error('[server] failed to start', error);
  process.exitCode = 1;
});
