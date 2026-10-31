/**
 * Composition root: reads the config, wires every component together, and
 * starts listening. The only file in the package with side effects at the
 * top level, which is why it is not the one `@lms/server` resolves to.
 */
import { createServer } from 'node:http';
import { createPublicClient, http as httpTransport } from 'viem';
import { WebSocketServer } from 'ws';
import { MAX_CLIENT_FRAME_BYTES, errorMessage } from '@lms/protocol';
import { config, ZERO_ADDRESS } from './config.js';
import { Gateway } from './gateway/gateway.js';
import { Heartbeat } from './gateway/heartbeat.js';
import { peerFrom } from './gateway/peer.js';
import { VerifyPool, layeredVerifier } from './gateway/verifyPool.js';
import { Lobby } from './lobby/lobby.js';
import { openStorage } from './db/storage.js';
import { transcriptResponse } from './lobby/transcripts.js';
import { generatePrivateKey } from 'viem/accounts';
import { attestorReceipts, receiptSigner, relayerFrom } from './chain/attestor.js';
import { keySigner } from './chain/signer.js';
import { viemTxSender, type TxSender } from './chain/txSender.js';
import { AttestorProcess } from './attestor/remote.js';
import { ChainBridge } from './chain/bridge.js';
import { AvatarRegistry, parseCollections } from './chain/avatars.js';
import { parseZapTokens, zapInfo } from './chain/zap.js';
import { CrossChainWatcher, parseSpokes, viemCrossChain } from './chain/crossChain.js';
import { FeeKeeper, feeKeeperPolicy, viemFeeRouter } from './chain/feeKeeper.js';
import { ProposalIndex, proposalsResponse } from './chain/proposals.js';
import { AnalystWorker } from './analyst/remote.js';
import { SessionRelay, viemRelayPort } from './chain/sessionRelay.js';

const TICK_MS = 250;
/** How often unauthenticated sockets and stale rate-limit state are cleared. */
const SWEEP_MS = 1_000;
/** A socket that misses a ping for this long is terminated. */
const HEARTBEAT_MS = 30_000;

async function main(): Promise<void> {
  // A promise nobody awaited that rejects would otherwise end the process,
  // taking every room in play with it. Each such rejection is a bug to fix,
  // so it is logged loudly, but one bug must not refund every live match.
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandled rejection:', reason);
  });

  const storage = await openStorage(config.databaseUrl);
  const { archive, styles } = storage;
  console.log(config.databaseUrl ? '[server] archiving to Postgres' : '[server] archiving in memory (ARCHIVE=memory or no DATABASE_URL)');
  // One key per job, and one sender per key: a key's nonces are a single
  // sequence, and `loadConfig` refuses two jobs on one key.
  const senderFor = (privateKey: `0x${string}` | undefined, label: string): TxSender | null =>
    privateKey && config.rpcUrl
      ? viemTxSender({ signer: keySigner(privateKey), chainId: config.chainId, rpcUrl: config.rpcUrl }, { label })
      : null;
  const keeper = senderFor(config.keeperPk, 'keeper');
  // The attestor key lives in a process of its own, which replays every
  // transcript before it signs one; this process only forwards.
  const attestor =
    config.attestorPk && config.onChain
      ? await AttestorProcess.start({
          privateKey: config.attestorPk,
          chainId: config.chainId,
          escrow: config.escrow,
          rpcUrl: config.rpcUrl,
        })
      : null;
  if (attestor) console.log(`[server] attestor ${attestor.address} in its own process`);
  const relayer = relayerFrom(config, attestor, keeper);
  // Staked rooms' receipts come from the attestor. Practice rooms' never do:
  // they are signed with a key of their own that lasts as long as the process.
  const receipts = attestor ? attestorReceipts(attestor) : null;
  const practiceReceipts = receiptSigner(generatePrivateKey(), config.chainId);

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
    styles,
    maxPracticeRooms: config.maxPracticeRooms,
    chainId: config.chainId,
    receiptSigner: receipts?.address ?? null,
    practiceReceiptSigner: practiceReceipts.address,
  });


  const bridge = config.onChain
    ? ChainBridge.start({
        rpcUrl: config.rpcUrl,
        chainId: config.chainId,
        escrow: config.escrow,
        lobby,
        ...(keeper ? { keeper } : {}),
        ...(config.escrowFromBlock !== undefined ? { fromBlock: config.escrowFromBlock } : {}),
        confirmations: config.confirmations,
        archive,
        // A restart loses every room in progress. Matches that were live are
        // aborted and refunded rather than restarted from round one.
        abort: (matchId) => relayer.abort(matchId),
      })
    : null;

  // With an RPC the gateway can verify ERC-1271 signatures, which is what lets
  // a contract wallet sign its session grant. Without one, EOAs still work.
  // Either way an EOA's signature is settled by local recovery on the verify
  // pool, and only a signature that does not recover is put to the RPC.
  const rpc = config.rpcUrl
    ? createPublicClient({ transport: httpTransport(config.rpcUrl) })
    : null;

  // Pays into the escrow, so it is only offered alongside one.
  const zap = config.onChain
    ? zapInfo(config.zapJoin, config.v4Quoter, parseZapTokens(config.zapTokens))
    : null;

  // Spokes bridge stakes into the hub escrow, so likewise.
  const spokes = config.onChain ? parseSpokes(config.spokes, config.chainId) : [];


  // Proposals made to the governor, which cannot list its own.
  const proposals =
    config.rpcUrl && config.governor !== ZERO_ADDRESS
      ? ProposalIndex.start({
          rpcUrl: config.rpcUrl,
          chainId: config.chainId,
          governor: config.governor,
          fromBlock: config.governorFromBlock,
          confirmations: config.confirmations,
        })
      : null;

  const verifyPool = new VerifyPool(config.verifyThreads);

  // One-click play: joins and withdrawals a player's session key signed, sent
  // with the relayer's gas. Needs all of an escrow, a delegate and a key.
  const relay =
    config.onChain && config.sessionDelegate !== ZERO_ADDRESS && config.sessionRelayerPk
      ? new SessionRelay({
          port: viemRelayPort({
            rpcUrl: config.rpcUrl,
            chainId: config.chainId,
            sender: senderFor(config.sessionRelayerPk, 'relay') as TxSender,
          }),
          escrow: config.escrow,
          delegate: config.sessionDelegate,
          quotaPerDay: config.relayQuotaPerDay,
        })
      : null;

  // Reads finished matches from the archive and nothing else, in a worker
  // thread of its own; see `analyst/analyst.ts`.
  const analyst = config.analyst.enabled
    ? new AnalystWorker({
        archive,
        styles,
        config: {
          model: {
            apiKey: config.analyst.geminiApiKey,
            baseUrl: config.analyst.geminiBaseUrl,
            timeoutMs: config.analyst.timeoutMs,
            maxRetries: config.analyst.maxRetries,
          },
          analyst: {
            modelId: config.analyst.model,
            effort: config.analyst.effort,
            maxTokens: config.analyst.maxTokens,
            deadlineMs: config.analyst.deadlineMs,
            maxTurns: config.analyst.maxTurns,
          },
          limits: {
            perWalletPerHour: config.analyst.quotaPerHour,
            maxConcurrent: config.analyst.maxConcurrent,
            dailyBudgetUsd: config.analyst.dailyBudgetUsd,
            requestsPerMinute: config.analyst.requestsPerMinute,
            requestsPerDay: config.analyst.requestsPerDay,
          },
        },
      })
    : undefined;

  const gateway = new Gateway({
    lobby,
    archive,
    chainId: config.chainId,
    escrow: config.onChain ? config.escrow : null,
    directory: () => bridge?.directory() ?? { open: [], live: [] },
    avatarCollections: avatarCollections.map(({ chainId, address }) => ({ chainId, address })),
    verify: layeredVerifier(verifyPool.verify, rpc ? (args) => rpc.verifyMessage(args) : undefined),
    // A contract wallet's grant can only be checked by asking the wallet.
    verifyGrant: layeredVerifier(verifyPool.verifyTyped, rpc ? (args) => rpc.verifyTypedData(args) : undefined),
    verifyKey: { message: verifyPool.verify, typed: verifyPool.verifyTyped },
    ...(receipts ? { receipts } : {}),
    practiceReceipts,
    ...(relay ? { relay } : {}),
    ...(analyst ? { analyst } : {}),
    zap,
    spokes,
    staking:
      config.stakedLms !== ZERO_ADDRESS
        ? {
            vault: config.stakedLms,
            governor: proposals ? config.governor : null,
            feeRouter: config.feeRouter !== ZERO_ADDRESS ? config.feeRouter : null,
            rewards: config.rewardsDistributor !== ZERO_ADDRESS ? config.rewardsDistributor : null,
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
    // Both read by the client from its own origin, which is not this one.
    const answer = (route: { status: number; body: string }) => {
      response.writeHead(route.status, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
      response.end(route.body);
    };
    const route = proposalsResponse(proposals, request.url ?? '');
    if (route) {
      answer(route);
      return;
    }
    if ((request.url ?? '').startsWith('/transcripts/')) {
      transcriptResponse(archive, request.url ?? '').then(
        (found) => answer(found ?? { status: 404, body: '{}' }),
        (error: unknown) => answer({ status: 500, body: JSON.stringify({ error: errorMessage(error) }) }),
      );
      return;
    }
    if (request.url === '/health') {
      const directory = bridge?.directory() ?? { open: [], live: [] };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: true,
          rooms: lobby.size,
          pendingSettlements: lobby.pendingSettlements,
          clients: gateway.connections,
          onChain: config.onChain,
          lobbies: { open: directory.open.length, live: directory.live.length },
          analyst: analyst
            ? {
                model: config.analyst.model,
                requestsToday: analyst.requests,
                spentTodayUsd: Math.round(analyst.spent * 1e4) / 1e4,
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
  }, SWEEP_MS);
  sweeper.unref();
  const beat = setInterval(() => heartbeat.sweep(), HEARTBEAT_MS);
  beat.unref();

  console.log(
    config.onChain
      ? `[server] watching escrow ${config.escrow} on chain ${config.chainId}`
      : '[server] no escrow configured: practice lobbies only',
  );

  if (zap) {
    console.log(`[server] token joins via ${zap.address}: ${zap.tokens.map((t) => t.symbol).join(', ')}`);
  }

  // Tells spoke players how their join landed on the hub. Holds no authority.
  let crossChain: CrossChainWatcher | null = null;
  if (config.onChain && spokes.length > 0) {
    crossChain = new CrossChainWatcher({
      port: viemCrossChain({ rpcUrl: config.rpcUrl, chainId: config.chainId, escrow: config.escrow }),
      hubChainId: config.chainId,
      notify: (player, event) => gateway.notify(player, { type: 'crossChain', event }),
      ...(config.crossChainFromBlock !== undefined ? { fromBlock: config.crossChainFromBlock } : {}),
      confirmations: config.confirmations,
    });
    crossChain.start(4_000);
    console.log(`[server] spokes on chains ${spokes.map((s) => s.chainId).join(', ')}`);
  }

  // Harvests fees on a timer so they reach stakers. Holds no authority:
  // `harvest` is open to anyone and pays only where the router already sends.
  let feeKeeper: FeeKeeper | null = null;
  if (keeper && config.feeRouter !== ZERO_ADDRESS) {
    const port = await viemFeeRouter({
      rpcUrl: config.rpcUrl,
      chainId: config.chainId,
      router: config.feeRouter,
      keeper,
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
    crossChain?.stop();
    proposals?.stop();
    clearInterval(ticker);
    clearInterval(sweeper);
    clearInterval(beat);
    wss.close();
    http.close();
    void verifyPool.close();
    void analyst?.close();
    attestor?.stop();
    void lobby.drain().finally(() => storage.close());
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main().catch((error: unknown) => {
  console.error('[server] failed to start', error);
  process.exitCode = 1;
});
