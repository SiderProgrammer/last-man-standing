import type { Attributes } from '@opentelemetry/api';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { withSpan } from './tracing.js';

/**
 * Prometheus metrics.
 *
 * One registry for the process, with every metric defined here so the whole
 * surface can be read in one place and the names stay consistent. Modules
 * import the metric they update; nothing else about them changes, and tests
 * that never scrape simply increment counters nobody reads.
 *
 * Naming follows Prometheus convention: `lms_` prefix, `_total` for counters,
 * base units (`_seconds`, `_wei`). Labels are kept to small, closed sets — a
 * match id or a wallet address as a label would create a series per match
 * and grow without bound; those belong in logs and traces instead.
 */
export const registry = new Registry();

/** Process metrics: event-loop lag, GC, heap, handles, CPU. */
export function collectProcessMetrics(): void {
  collectDefaultMetrics({ register: registry, prefix: 'lms_' });
}

const LATENCY = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const CHAIN_LATENCY = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];

// ---------------------------------------------------------------- gateway

export const wsConnections = new Gauge({
  name: 'lms_ws_connections',
  help: 'WebSocket connections currently open',
  registers: [registry],
});

export const wsAuthenticated = new Gauge({
  name: 'lms_ws_authenticated',
  help: 'Open connections that have logged in',
  registers: [registry],
});

export const wsRefused = new Counter({
  name: 'lms_ws_refused_total',
  help: 'Connections refused at admission',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const wsClosed = new Counter({
  name: 'lms_ws_closed_by_server_total',
  help: 'Connections the server closed itself',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const wsFrames = new Counter({
  name: 'lms_ws_frames_total',
  help: 'Client frames accepted for dispatch, by message type',
  labelNames: ['type'] as const,
  registers: [registry],
});

export const wsRejected = new Counter({
  name: 'lms_ws_rejected_total',
  help: 'Client frames refused before dispatch',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const wsHandled = new Histogram({
  name: 'lms_ws_handle_seconds',
  help: 'Time to handle a client frame, by message type and outcome',
  labelNames: ['type', 'outcome'] as const,
  buckets: LATENCY,
  registers: [registry],
});

export const logins = new Counter({
  name: 'lms_logins_total',
  help: 'Login attempts by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const heartbeatTerminated = new Counter({
  name: 'lms_ws_heartbeat_terminated_total',
  help: 'Sockets terminated for missing a ping',
  registers: [registry],
});

// ---------------------------------------------------------------- rooms

export const roomsActive = new Gauge({
  name: 'lms_rooms_active',
  help: 'Rooms currently held, by kind',
  labelNames: ['kind'] as const,
  registers: [registry],
});

export const matchesStarted = new Counter({
  name: 'lms_matches_started_total',
  help: 'Rooms opened, by kind',
  labelNames: ['kind'] as const,
  registers: [registry],
});

export const matchesFinished = new Counter({
  name: 'lms_matches_finished_total',
  help: 'Matches that reached a result, by kind',
  labelNames: ['kind'] as const,
  registers: [registry],
});

export const roundsResolved = new Counter({
  name: 'lms_rounds_resolved_total',
  help: 'Rounds resolved across every room',
  registers: [registry],
});

export const roundDuration = new Histogram({
  name: 'lms_round_duration_seconds',
  help: 'Wall time from a round opening to it resolving',
  buckets: [1, 2.5, 5, 10, 15, 20, 30, 45, 60],
  registers: [registry],
});

export const missedMoves = new Counter({
  name: 'lms_missed_moves_total',
  help: 'Human seats that let a phase deadline pass without acting',
  labelNames: ['phase'] as const,
  registers: [registry],
});

export const tickDuration = new Histogram({
  name: 'lms_lobby_tick_seconds',
  help: 'Time to advance every room by one tick',
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [registry],
});

export const replayMismatches = new Counter({
  name: 'lms_replay_mismatch_total',
  help: 'Finished matches whose independent replay disagrees with the result about to be signed',
  registers: [registry],
});

// ---------------------------------------------------------------- chain

export const bridgePolls = new Counter({
  name: 'lms_bridge_polls_total',
  help: 'Escrow poll iterations, by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const bridgePollDuration = new Histogram({
  name: 'lms_bridge_poll_seconds',
  help: 'Time for one escrow poll',
  buckets: CHAIN_LATENCY,
  registers: [registry],
});

export const bridgeLastPoll = new Gauge({
  name: 'lms_bridge_last_success_timestamp_seconds',
  help: 'Unix time of the last successful escrow poll; alert on staleness',
  registers: [registry],
});

export const bridgeHead = new Gauge({
  name: 'lms_bridge_block',
  help: 'Last hub block the bridge has scanned up to',
  registers: [registry],
});

export const chainTx = new Counter({
  name: 'lms_chain_tx_total',
  help: 'Transactions the server submitted, by action and outcome',
  labelNames: ['action', 'outcome'] as const,
  registers: [registry],
});

export const chainTxDuration = new Histogram({
  name: 'lms_chain_tx_seconds',
  help: 'Time from building a transaction to it being accepted, by action',
  labelNames: ['action'] as const,
  buckets: CHAIN_LATENCY,
  registers: [registry],
});

export const walletBalance = new Gauge({
  name: 'lms_wallet_balance_wei',
  help: 'Native balance of each key the server spends gas from; alert before it runs dry',
  labelNames: ['role'] as const,
  registers: [registry],
});

// ---------------------------------------------------------------- cross-chain

export const crossChainPending = new Gauge({
  name: 'lms_crosschain_pending',
  help: 'Joins forwarded from a spoke and not yet seated or refunded on the hub',
  labelNames: ['origin'] as const,
  registers: [registry],
});

export const crossChainStuck = new Gauge({
  name: 'lms_crosschain_stuck',
  help: 'Pending joins older than the delivery threshold',
  labelNames: ['origin'] as const,
  registers: [registry],
});

export const crossChainDelivered = new Counter({
  name: 'lms_crosschain_delivered_total',
  help: 'Forwarded joins that reached the hub, by origin and outcome (seated or refunded)',
  labelNames: ['origin', 'outcome'] as const,
  registers: [registry],
});

export const crossChainDeliveryDuration = new Histogram({
  name: 'lms_crosschain_delivery_seconds',
  help: 'Time from a spoke forwarding a join to the hub acting on it',
  labelNames: ['origin'] as const,
  buckets: [5, 15, 30, 60, 120, 300, 600, 1200, 3600],
  registers: [registry],
});

export const crossChainOrphans = new Counter({
  name: 'lms_crosschain_orphans_total',
  help: 'Hub seats claiming a spoke origin with no forwarded join seen on that spoke',
  labelNames: ['origin'] as const,
  registers: [registry],
});

/**
 * Runs a transaction-submitting operation inside a span, timing it and
 * counting its outcome under `action`. Rethrows: this observes, it does not
 * handle.
 */
export async function observeTx<T>(action: string, attributes: Attributes, work: () => Promise<T>): Promise<T> {
  const end = chainTxDuration.startTimer({ action });
  try {
    const result = await withSpan(`tx.${action}`, attributes, work);
    chainTx.inc({ action, outcome: 'ok' });
    return result;
  } catch (error) {
    chainTx.inc({ action, outcome: 'error' });
    throw error;
  } finally {
    end();
  }
}
