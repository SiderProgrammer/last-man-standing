/**
 * Composition root: reads the config, wires every component together, and
 * starts listening. The only file in the package with side effects at the
 * top level, which is why it is not the one `@lms/server` resolves to.
 */
import type { RequestListener, Server } from 'node:http';
import { createPublicClient } from 'viem';
import { WebSocketServer } from 'ws';
import { MAX_CLIENT_FRAME_BYTES, errorMessage, type StakingInfo } from '@lms/api';
import { config, ZERO_ADDRESS } from './config.js';
import { Gateway } from './gateway/gateway.js';
import { Heartbeat } from './gateway/heartbeat.js';
import { peerFrom } from './gateway/peer.js';
import { VerifyPool, layeredVerifier } from './gateway/verifyPool.js';
import { Lobby } from './lobby/lobby.js';
import { openStorage } from './db/storage.js';
import type { MatchArchive } from './lobby/store.js';
import type { StyleBook } from './lobby/styles.js';
import { transcriptResponse } from './lobby/transcripts.js';
import { generatePrivateKey } from 'viem/accounts';
import { attestorReceipts, receiptSigner, relayerFrom } from './chain/attestor.js';
import { keySigner } from './chain/signer.js';
import { viemTxSender, type TxSender } from './chain/txSender.js';
import { rpcTransport } from './chain/viem.js';
import { AttestorProcess } from './attestor/remote.js';
import { ChainBridge } from './chain/bridge.js';
import { AvatarRegistry, parseCollections } from './chain/avatars.js';
import { ResultIndex } from './chain/results.js';
import { parseZapTokens, zapInfo } from './chain/zap.js';
import { CrossChainWatcher, parseSpokes, viemCrossChain } from './chain/crossChain.js';
import { FeeKeeper, feeKeeperPolicy, viemFeeRouter } from './chain/feeKeeper.js';
import { ProposalIndex, proposalsResponse, wantsFresh } from './chain/proposals.js';
import { AnalystWorker } from './analyst/remote.js';
import { Matchmaker, viemMatchmakerPort } from './lobby/matchmaker.js';
import { DEFAULT_RULES } from '@lms/consensus';
import { ChainWithdrawals, viemWithdrawalPort } from './chain/chainWithdrawals.js';
import { LobbyOpener, viemLobbyOpenerPort } from './chain/lobbyOpener.js';
import { DailyQuota, SessionRelay, viemRelayPort } from './chain/sessionRelay.js';
import { Faucet, viemFaucetPort } from './chain/faucet.js';
import { SpokeFiller, spokeFillerPolicy, spokeRpcs, viemSpokeFiller } from './chain/spokeFiller.js';
import { HttpFront } from './util/httpFront.js';
import { repeat } from './util/poll.js';

const TICK_MS = 250;
/** How often unauthenticated sockets and stale rate-limit state are cleared. */
const SWEEP_MS = 1_000;
/** How often the lobby directory is checked for changes and pushed to clients. */
const LOBBY_PUSH_MS = 1_000;
/** A socket that misses a ping for this long is terminated. */
const HEARTBEAT_MS = 30_000;
/** The WebSocket close code for a server that is restarting. */
const WS_SERVICE_RESTART = 1012;

async function main(): Promise<void> {
  // A promise nobody awaited that rejects would otherwise end the process,
  // taking every room in play with it. Each such rejection is a bug to fix,
  // so it is logged loudly, but one bug must not refund every live match.
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandled rejection:', reason);
  });

  // The attestor key lives in a process of its own, which replays every
  // transcript before it signs one; this process only forwards. Started before
  // the database is claimed: once this server's port opens, a deploy may stop
  // the old one, so what can fail should have failed by then.
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

  const front = new HttpFront();
  // Another server took the database while this one's connection was down:
  // stop, as on SIGTERM, rather than run two. Before `shutdown` exists there
  // is nothing in play to wind down.
  let stop = (): void => process.exit(1);
  const storage = await openStorage(config.databaseUrl, {
    waitMs: config.instanceWaitMs,
    // The old server of a deploy is stopped only once this one's port answers.
    onWaiting: async () => {
      console.log('[server] another server instance holds this database: waiting for it to stop');
      await front.listen(config.port);
    },
    onLost: () => {
      console.error('[server] another server instance now holds this database: shutting down');
      process.exitCode = 1;
      stop();
    },
  });
  const { archive, styles, journal } = storage;
  console.log(config.databaseUrl ? '[server] archiving to Postgres' : '[server] archiving in memory (ARCHIVE=memory or no DATABASE_URL)');
  // One key per job, and one sender per key: a key's nonces are a single
  // sequence, and `loadConfig` refuses two jobs on one key.
  const senderFor = (privateKey: `0x${string}` | undefined, label: string): TxSender | null =>
    privateKey && config.rpcUrl
      ? viemTxSender({ signer: keySigner(privateKey), chainId: config.chainId, rpcUrl: config.rpcUrl }, { label })
      : null;
  const keeper = senderFor(config.keeperPk, 'keeper');
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

  // Late-bound: the gateway that tells players things is built after the
  // lobby and the matchmaker that need to.
  let notify: (player: `0x${string}`, message: Parameters<Gateway['notify']>[1]) => void = () => undefined;
  let bridge: ChainBridge | null = null;
  const lobby = new Lobby({
    archive,
    relayer,
    readyMs: config.readyMs,
    journal,
    expects: (matchId) => bridge?.expects(matchId) ?? false,
    onLive: (room) => {
      for (const seat of room.match.seats) notify(seat.address, { type: 'live', matchId: room.matchId });
    },
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

  bridge = config.onChain
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
  // Staked results from the chain, so history outlives an in-memory archive.
  const results = config.onChain
    ? ResultIndex.start({
        rpcUrl: config.rpcUrl,
        chainId: config.chainId,
        escrow: config.escrow,
        fromBlock: config.escrowFromBlock ?? 0n,
        confirmations: config.confirmations,
      })
    : null;
  // Empty when there is no chain to list lobbies from.
  const directory = () => bridge?.directory() ?? { open: [], live: [] };

  // With an RPC the gateway can verify ERC-1271 signatures, which is what lets
  // a contract wallet sign its session grant. Without one, EOAs still work.
  // Either way an EOA's signature is settled by local recovery on the verify
  // pool, and only a signature that does not recover is put to the RPC.
  const rpc = config.rpcUrl
    ? createPublicClient({ transport: rpcTransport(config.rpcUrl) })
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

  // The session relayer's key pays for both of what follows, from one sender and
  // against one daily quota per wallet.
  const relaySender = config.onChain ? senderFor(config.sessionRelayerPk, 'relay') : null;
  const relayQuota = new DailyQuota(config.relayQuotaPerDay);

  // One-click play: joins and withdrawals a player's session key signed, sent
  // with the session relayer's gas. Needs all of an escrow, a delegate and a key.
  const relay =
    relaySender && config.sessionDelegate !== ZERO_ADDRESS
      ? new SessionRelay({
          port: viemRelayPort({ rpcUrl: config.rpcUrl, chainId: config.chainId, sender: relaySender }),
          escrow: config.escrow,
          delegate: config.sessionDelegate,
          quotaPerDay: config.relayQuotaPerDay,
          quota: relayQuota,
        })
      : null;

  // Withdrawals to a spoke a player signed, bridged home with the session relayer's
  // gas on the hub. Needs a key and at least one spoke to bridge to.
  const withdrawals =
    relaySender && spokes.length > 0
      ? new ChainWithdrawals({
          port: viemWithdrawalPort({ rpcUrl: config.rpcUrl, chainId: config.chainId, escrow: config.escrow, sender: relaySender }),
          hubChainId: config.chainId,
          spokes,
          quota: relayQuota,
        })
      : null;

  // Lobbies opened on the hub for players on a spoke, who have no gas there,
  // with the session relayer's gas. Needs a key and a spoke to stake from.
  const opener =
    relaySender && spokes.length > 0
      ? new LobbyOpener({
          port: viemLobbyOpenerPort({ rpcUrl: config.rpcUrl, chainId: config.chainId, escrow: config.escrow, sender: relaySender }),
          quota: relayQuota,
          lobbies: () => {
            const { open, live } = directory();
            return [...open, ...live];
          },
        })
      : null;

  // Testnet LMS for every wallet that signs in with ETH, with the session
  // relayer's gas. Needs a key and a faucet, which Base mainnet never has.
  const faucet =
    relaySender && config.lmsFaucet !== ZERO_ADDRESS
      ? new Faucet({
          port: viemFaucetPort({ rpcUrl: config.rpcUrl, chainId: config.chainId, faucet: config.lmsFaucet, sender: relaySender }),
          notify: (player, message) => notify(player, message),
        })
      : null;
  if (faucet) console.log(`[server] dripping testnet LMS from ${config.lmsFaucet}`);

  // Reads finished matches from the archive and nothing else, in a worker
  // thread of its own; see `analyst/analyst.ts`.
  const analyst = config.analyst.enabled ? analystWorker(archive, styles) : undefined;

  // Opens matchmade lobbies, the only ones that earn play-mining, with its
  // own key. Told who to notify once the gateway exists.
  const matchmakerSender = config.onChain ? senderFor(config.matchmakerPk, 'matchmaker') : null;
  const matchmaker = matchmakerSender
    ? new Matchmaker({
        port: viemMatchmakerPort({ rpcUrl: config.rpcUrl, chainId: config.chainId, escrow: config.escrow, sender: matchmakerSender }),
        minSeats: DEFAULT_RULES.minPlayers,
        maxSeats: DEFAULT_RULES.maxPlayers,
        fillAfterMs: config.matchmakingFillAfterMs,
        notify: (player, message) => notify(player, message),
        lobbies: () => directory().open,
        chainTime: () => bridge?.chainTime() ?? null,
      })
    : null;

  const gateway = new Gateway({
    lobby,
    archive,
    ...(results ? { results } : {}),
    ...(avatars.empty ? {} : { avatars }),
    chainId: config.chainId,
    escrow: config.onChain ? config.escrow : null,
    directory,
    chainTime: () => bridge?.chainTime() ?? null,
    paused: () => bridge?.paused() ?? false,
    avatarCollections: avatarCollections.map(({ chainId, address }) => ({ chainId, address })),
    verify: layeredVerifier(verifyPool.verify, rpc ? (args) => rpc.verifyMessage(args) : undefined),
    // A contract wallet's grant can only be checked by asking the wallet.
    verifyGrant: layeredVerifier(verifyPool.verifyTyped, rpc ? (args) => rpc.verifyTypedData(args) : undefined),
    verifyKey: { message: verifyPool.verify, typed: verifyPool.verifyTyped },
    ...(receipts ? { receipts } : {}),
    practiceReceipts,
    ...(relay ? { relay } : {}),
    ...(withdrawals ? { withdrawals } : {}),
    ...(opener ? { opener } : {}),
    ...(faucet ? { faucet } : {}),
    ...(analyst ? { analyst } : {}),
    zap,
    spokes,
    ...(matchmaker ? { matchmaker } : {}),
    staking: stakingInfo(proposals !== null, faucet !== null),
    limits: {
      ...config.gatewayLimits,
      maxConnections: config.maxConnections,
      maxConnectionsPerIp: config.maxConnectionsPerIp,
      loginTimeoutMs: config.loginTimeoutMs,
      allowedOrigins: config.allowedOrigins,
    },
  });

  const answer = requestHandler({
    proposals,
    archive,
    health: () => {
      const lobbies = directory();
      return {
        ok: true,
        rooms: lobby.size,
        pendingSettlements: lobby.pendingSettlements,
        clients: gateway.connections,
        onChain: config.onChain,
        lobbies: { open: lobbies.open.length, live: lobbies.live.length },
        // Read when asked, which is after `serve`, so after it is assigned.
        filler: filler ? { address: fillerSender?.address, waiting: filler.waiting } : null,
        analyst: analyst
          ? {
              model: config.analyst.model,
              requestsToday: analyst.requests,
              spentTodayUsd: Math.round(analyst.spent * 1e4) / 1e4,
            }
          : null,
      };
    },
  });

  const heartbeat = new Heartbeat();

  notify = (player, message) => gateway.notify(player, message);
  const timers = [
    repeat(() => lobby.tick(), TICK_MS),
    repeat(() => gateway.sweep(), SWEEP_MS),
    repeat(() => gateway.publishLobbies(), LOBBY_PUSH_MS),
    repeat(() => heartbeat.sweep(), HEARTBEAT_MS),
  ];
  if (matchmaker) {
    timers.push(repeat(() => void matchmaker.tick(), 1_000));
    console.log('[server] matchmaking');
  }

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

  // Fills stakes from a spoke on the hub with its own ETH, which Across's
  // testnet relayers leave unfilled. Needs its key and a spoke RPC to read.
  let filler: SpokeFiller | null = null;
  const fillerSender = config.onChain && spokes.length > 0 ? senderFor(config.fillerPk, 'filler') : null;
  if (fillerSender) {
    const fillable = spokeRpcs(config.spokes, spokes);
    const ports = fillable.length
      ? await viemSpokeFiller({
          hubRpcUrl: config.rpcUrl,
          hubChainId: config.chainId,
          escrow: config.escrow,
          sender: fillerSender,
          spokes: fillable,
        }).catch((error: unknown) => {
          console.error('[filler] could not start:', errorMessage(error));
          return null;
        })
      : null;
    if (ports) {
      const policy = spokeFillerPolicy(config.filler);
      filler = new SpokeFiller({ ...ports, policy, confirmations: config.confirmations });
      filler.start(config.fillerPollMs);
      console.log(
        `[server] filling spoke stakes up to ${policy.maxStake} wei from ${fillerSender.address} ` +
          `on chains ${ports.sources.map((s) => s.chainId).join(', ')}`,
      );
    } else {
      console.warn('[filler] FILLER_PK is set but no SPOKES entry names a usable rpcUrl: nothing filled');
    }
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

  // The port is already open if this server had to wait for the database.
  const http = front.server;
  const wss = acceptSockets(http, gateway, heartbeat);
  front.serve(answer);

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    bridge?.stop();
    feeKeeper?.stop();
    crossChain?.stop();
    filler?.stop();
    proposals?.stop();
    for (const stop of timers) stop();
    wss.close();
    // `wss.close` leaves the open ones open. Closed, their players go to the
    // server taking over rather than sit on one that no longer plays.
    for (const socket of wss.clients) socket.close(WS_SERVICE_RESTART, 'server restarting');
    http.close();
    void verifyPool.close();
    void analyst?.close();
    attestor?.stop();
    void lobby.drain().finally(() => storage.close());
  };
  stop = shutdown;
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await front.listen(config.port);
  console.log(`[server] listening on :${config.port}`);
}

void main().catch((error: unknown) => {
  console.error('[server] failed to start', error);
  // Not `exitCode`: what had already started would keep the process up,
  // holding the database's lock and, had it waited for it, answering `/health`.
  process.exit(1);
});

/** The analyst worker, configured from `config.analyst`. */
function analystWorker(archive: MatchArchive, styles: StyleBook): AnalystWorker {
  const { analyst } = config;
  return new AnalystWorker({
    archive,
    styles,
    config: {
      model: {
        apiKey: analyst.geminiApiKey,
        baseUrl: analyst.geminiBaseUrl,
        timeoutMs: analyst.timeoutMs,
        maxRetries: analyst.maxRetries,
      },
      analyst: {
        modelId: analyst.model,
        effort: analyst.effort,
        maxTokens: analyst.maxTokens,
        deadlineMs: analyst.deadlineMs,
      },
      limits: {
        perWalletPerHour: analyst.quotaPerHour,
        maxConcurrent: analyst.maxConcurrent,
        dailyBudgetUsd: analyst.dailyBudgetUsd,
        requestsPerMinute: analyst.requestsPerMinute,
        requestsPerDay: analyst.requestsPerDay,
      },
    },
  });
}

/**
 * What `hello` says about staking: null hides the panel. The governor is
 * named only when its proposals are indexed, since the client cannot list them;
 * the faucet only when this server drips from it.
 */
function stakingInfo(proposalsIndexed: boolean, dripping: boolean): StakingInfo | null {
  if (config.stakedLms === ZERO_ADDRESS) return null;
  const configured = (address: `0x${string}`) => (address !== ZERO_ADDRESS ? address : null);
  return {
    vault: config.stakedLms,
    governor: proposalsIndexed ? config.governor : null,
    feeRouter: configured(config.feeRouter),
    rewards: configured(config.rewardsDistributor),
    faucet: dripping ? config.lmsFaucet : null,
  };
}

/** The HTTP side: proposals and transcripts, which the client reads, and `/health`. */
function requestHandler(options: { proposals: ProposalIndex | null; archive: MatchArchive; health: () => object }): RequestListener {
  return (request, response) => {
    const url = request.url ?? '';
    // Both read by the client from its own origin, which is not this one.
    const answer = (route: { status: number; body: string }) => {
      response.writeHead(route.status, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
      response.end(route.body);
    };
    const route = proposalsResponse(options.proposals, url);
    if (route && options.proposals && wantsFresh(url)) {
      // Just proposed: caught up with the chain first, so it is listed.
      const index = options.proposals;
      void index.freshen().then(() => answer(proposalsResponse(index, url) ?? route));
    } else if (route) {
      answer(route);
    } else if (url.startsWith('/transcripts/')) {
      transcriptResponse(options.archive, url).then(
        (found) => answer(found ?? { status: 404, body: '{}' }),
        (error: unknown) => answer({ status: 500, body: JSON.stringify({ error: errorMessage(error) }) }),
      );
    } else if (url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(options.health()));
    } else {
      response.writeHead(404).end();
    }
  };
}

/** Hands every WebSocket on `http` to the gateway, and the ones it admits to the heartbeat. */
function acceptSockets(http: Server, gateway: Gateway, heartbeat: Heartbeat): WebSocketServer {
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
  // `ws` speaks `on(event, listener)`; the gateway wants two named methods, so
  // the shapes are bridged here rather than by casting the socket into place.
  wss.on('error', (error) => console.error('[server] websocket server error:', error.message));
  wss.on('connection', (socket, request) => {
    // First, before anything can fail: `ws` reports protocol violations — a
    // frame over `maxPayload`, invalid UTF-8, a bad opcode — as an `error`
    // event, and one with no listener is thrown, taking the whole process
    // down on one malformed frame. With a listener, `ws` closes that socket.
    socket.on('error', () => undefined);
    // TEMPORARY: shows what Render's proxies send, to set TRUSTED_PROXY_HOPS. Remove once it is set.
    console.log('[peer]', request.socket.remoteAddress, JSON.stringify(request.headers['x-forwarded-for'] ?? null));
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
      peerFrom(request, config.trustedProxyHops),
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
  return wss;
}
