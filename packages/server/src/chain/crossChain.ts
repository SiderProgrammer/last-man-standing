import { parseAbi, type Address } from 'viem';
import { addressKey, errorMessage, normaliseOriginChainId } from '@lms/protocol';
import { readClient } from './viem.js';
import { log } from '../observability/log.js';
import {
  crossChainDelivered,
  crossChainDeliveryDuration,
  crossChainOrphans,
  crossChainPending,
  crossChainStuck,
} from '../observability/metrics.js';

/**
 * Watches stakes in flight between the spokes and the hub.
 *
 * A player on a spoke calls `SpokeEscrow.join`, which escrows nothing locally:
 * it emits `JoinForwarded` and hands the stake to the messenger. The hub then
 * either seats the player (`PlayerJoined`, with the spoke as origin) or
 * refunds them (`JoinRefunded`). A message that does neither is a stake that
 * has left the player's wallet and arrived nowhere — `docs/TODO.md` §2.1 — and
 * nothing on-chain will notice. This does: every forwarded join is tracked
 * until the hub accounts for it, and one that has not after `stuckAfterMs` is
 * reported, logged, and exported as `lms_crosschain_stuck`.
 *
 * The reverse is watched too: a hub seat claiming a spoke origin that the
 * spoke never forwarded is an "orphan", which means a misconfigured peer or
 * a messenger delivering something the spoke did not send.
 *
 * Times are observation times — when a poll first saw the event — not block
 * timestamps. Delivery latency is therefore accurate to one poll interval,
 * which is plenty for alerting on minutes-long stalls and costs no extra RPC
 * call per event.
 */

export interface ForwardedJoin {
  matchId: `0x${string}`;
  player: Address;
}

export interface HubSeat {
  matchId: `0x${string}`;
  player: Address;
  /** EVM chain id, already normalised: equal to the hub's for a direct join. */
  origin: number;
}

export interface StuckJoin extends ForwardedJoin {
  origin: number;
  ageMs: number;
}

export interface ReconcilerReport {
  /** Pending forwarded joins by origin chain. */
  pending: Map<number, number>;
  stuck: StuckJoin[];
}

interface Pending extends ForwardedJoin {
  origin: number;
  seenAt: number;
}

/**
 * The bookkeeping, with no I/O: fed events, asked for a report. Tolerates
 * either side being seen first, because the spoke and the hub are polled
 * independently and either may lag.
 */
export class JoinReconciler {
  private readonly pending = new Map<string, Pending>();
  /** Hub-side events with no forward seen yet, kept for `graceMs` in case the spoke poll is behind. */
  private readonly early = new Map<string, { origin: number; seenAt: number; outcome: 'seated' | 'refunded' }>();

  constructor(
    private readonly hubChainId: number,
    /** Spoke chain ids being watched: only seats from these can be orphans. */
    private readonly spokes: ReadonlySet<number>,
    private readonly graceMs: number,
  ) {}

  forwarded(origin: number, join: ForwardedJoin, now: number): void {
    const key = joinKey(join);
    const early = this.early.get(key);
    if (early) {
      this.early.delete(key);
      // The spoke poll lagged the hub: delivered, but the latency is unknown.
      crossChainDelivered.inc({ origin: String(origin), outcome: early.outcome });
      return;
    }
    if (!this.pending.has(key)) this.pending.set(key, { ...join, origin, seenAt: now });
  }

  seated(seat: HubSeat, now: number): void {
    if (seat.origin === this.hubChainId) return;
    this.settle(joinKey(seat), 'seated', seat.origin, now);
  }

  refunded(join: ForwardedJoin, now: number): void {
    // A refund carries no origin. One that matches nothing pending is most
    // likely a direct hub join that failed, which is not ours to track.
    this.settle(joinKey(join), 'refunded', null, now);
  }

  report(now: number, stuckAfterMs: number): ReconcilerReport {
    for (const [key, entry] of this.early) {
      if (now - entry.seenAt < this.graceMs) continue;
      this.early.delete(key);
      if (entry.outcome === 'seated' && this.spokes.has(entry.origin)) {
        crossChainOrphans.inc({ origin: String(entry.origin) });
        log.error('hub seat with no forwarded join on its origin', { component: 'crosschain', key, origin: entry.origin });
      }
    }

    const pending = new Map<number, number>();
    const stuck: StuckJoin[] = [];
    for (const entry of this.pending.values()) {
      pending.set(entry.origin, (pending.get(entry.origin) ?? 0) + 1);
      const ageMs = now - entry.seenAt;
      if (ageMs >= stuckAfterMs) {
        stuck.push({ matchId: entry.matchId, player: entry.player, origin: entry.origin, ageMs });
      }
    }
    return { pending, stuck };
  }

  private settle(key: string, outcome: 'seated' | 'refunded', origin: number | null, now: number): void {
    const entry = this.pending.get(key);
    if (entry) {
      this.pending.delete(key);
      const labels = { origin: String(entry.origin) };
      crossChainDelivered.inc({ ...labels, outcome });
      crossChainDeliveryDuration.observe(labels, (now - entry.seenAt) / 1000);
      return;
    }
    if (origin !== null && !this.early.has(key)) this.early.set(key, { origin, seenAt: now, outcome });
  }
}

function joinKey(join: ForwardedJoin): string {
  return `${join.matchId.toLowerCase()}:${addressKey(join.player)}`;
}

// ---------------------------------------------------------------- sources

/** Reads one chain's logs between two blocks, as a batch of type `T`. */
export interface LogSource<T> {
  blockNumber(): Promise<bigint>;
  logs(from: bigint, to: bigint): Promise<T>;
}

export interface HubLogs {
  seats: HubSeat[];
  refunds: ForwardedJoin[];
}

const spokeAbi = parseAbi(['event JoinForwarded(bytes32 indexed matchId, address indexed player, uint128 stake)']);
const hubAbi = parseAbi([
  'event PlayerJoined(bytes32 indexed matchId, address indexed player, uint16 seat, uint32 originChainId)',
  'event JoinRefunded(bytes32 indexed matchId, address indexed player, uint256 amount, uint8 reason)',
]);

export function viemSpokeSource(chainId: number, rpcUrl: string, escrow: Address): LogSource<ForwardedJoin[]> {
  const client = readClient(chainId, rpcUrl);
  return {
    blockNumber: () => client.getBlockNumber(),
    async logs(from, to) {
      const logs = await client.getContractEvents({
        address: escrow,
        abi: spokeAbi,
        eventName: 'JoinForwarded',
        fromBlock: from,
        toBlock: to,
      });
      return logs.flatMap(({ args }) => (args.matchId && args.player ? [{ matchId: args.matchId, player: args.player }] : []));
    },
  };
}

export function viemHubSource(chainId: number, rpcUrl: string, escrow: Address): LogSource<HubLogs> {
  const client = readClient(chainId, rpcUrl);
  return {
    blockNumber: () => client.getBlockNumber(),
    async logs(from, to) {
      const logs = await client.getContractEvents({ address: escrow, abi: hubAbi, fromBlock: from, toBlock: to });
      const seats: HubSeat[] = [];
      const refunds: ForwardedJoin[] = [];
      for (const log of logs) {
        if (log.eventName === 'PlayerJoined' && log.args.matchId && log.args.player) {
          seats.push({
            matchId: log.args.matchId,
            player: log.args.player,
            origin: normaliseOriginChainId(Number(log.args.originChainId ?? 0), chainId),
          });
        } else if (log.eventName === 'JoinRefunded' && log.args.matchId && log.args.player) {
          refunds.push({ matchId: log.args.matchId, player: log.args.player });
        }
      }
      return { seats, refunds };
    },
  };
}

// ---------------------------------------------------------------- poller

/** A spoke escrow to watch, as configured in `SPOKES`. */
export interface SpokeConfig {
  chainId: number;
  rpcUrl: string;
  escrow: Address;
}

export interface CrossChainMonitorOptions {
  hubChainId: number;
  hub: LogSource<HubLogs>;
  spokes: ReadonlyArray<{ chainId: number; source: LogSource<ForwardedJoin[]> }>;
  /** A pending join older than this is reported stuck. */
  stuckAfterMs?: number;
  /** Blocks behind the head to start from, so a restart re-reads recent traffic. */
  lookbackBlocks?: bigint;
  /** Widest `eth_getLogs` range requested at once; public RPCs cap it. */
  maxRange?: bigint;
  now?: () => number;
}

/** Polls the hub and every spoke and feeds a `JoinReconciler`. */
export class CrossChainMonitor {
  readonly reconciler: JoinReconciler;
  private readonly cursors = new Map<string, bigint>();
  private readonly options: Required<Omit<CrossChainMonitorOptions, 'now'>> & { now: () => number };
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** Stuck joins already logged, so one stall is one log line rather than one per poll. */
  private readonly reported = new Set<string>();

  constructor(options: CrossChainMonitorOptions) {
    this.options = {
      stuckAfterMs: 10 * 60_000,
      lookbackBlocks: 5_000n,
      maxRange: 2_000n,
      now: Date.now,
      ...options,
    };
    const spokes = new Set(options.spokes.map((spoke) => spoke.chainId));
    // The spoke poll may trail the hub by a poll or two; give it a few minutes.
    this.reconciler = new JoinReconciler(options.hubChainId, spokes, 5 * 60_000);
  }

  start(pollMs = 15_000): this {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), pollMs);
    this.timer.unref?.();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      // Spokes first: a forward seen before its delivery is the common order.
      for (const spoke of this.options.spokes) {
        await this.scan(`spoke:${spoke.chainId}`, spoke.source, (joins, now) => {
          for (const join of joins) this.reconciler.forwarded(spoke.chainId, join, now);
        });
      }
      await this.scan('hub', this.options.hub, ({ seats, refunds }, now) => {
        for (const seat of seats) this.reconciler.seated(seat, now);
        for (const refund of refunds) this.reconciler.refunded(refund, now);
      });
      this.publish();
    } finally {
      this.polling = false;
    }
  }

  /** Scans one source from its cursor to its head, a bounded range at a time. */
  private async scan<T>(name: string, source: LogSource<T>, apply: (logs: T, now: number) => void): Promise<void> {
    try {
      const head = await source.blockNumber();
      let from = this.cursors.get(name) ?? (head > this.options.lookbackBlocks ? head - this.options.lookbackBlocks : 0n);
      while (from <= head) {
        const to = from + this.options.maxRange - 1n < head ? from + this.options.maxRange - 1n : head;
        const logs = await source.logs(from, to);
        apply(logs, this.options.now());
        from = to + 1n;
        this.cursors.set(name, from);
      }
    } catch (error) {
      // The cursor stays put, so the next poll retries the same range.
      log.warn('cross-chain scan failed', { component: 'crosschain', source: name, error: errorMessage(error) });
    }
  }

  private publish(): void {
    const now = this.options.now();
    const { pending, stuck } = this.reconciler.report(now, this.options.stuckAfterMs);
    for (const spoke of this.options.spokes) {
      const origin = String(spoke.chainId);
      crossChainPending.set({ origin }, pending.get(spoke.chainId) ?? 0);
      crossChainStuck.set({ origin }, stuck.filter((join) => join.origin === spoke.chainId).length);
    }
    for (const join of stuck) {
      const key = joinKey(join);
      if (this.reported.has(key)) continue;
      this.reported.add(key);
      log.error('forwarded join not delivered to the hub', {
        component: 'crosschain',
        matchId: join.matchId,
        player: join.player,
        origin: join.origin,
        ageSeconds: Math.round(join.ageMs / 1000),
      });
    }
  }
}

/** Parses `SPOKES`: `[{"chainId":84532,"rpcUrl":"https://…","escrow":"0x…"}]`. Bad entries are skipped and logged. */
export function parseSpokes(raw: string): SpokeConfig[] {
  if (!raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed.flatMap((item: unknown) => {
      const entry = item as Partial<SpokeConfig> | null;
      if (
        entry &&
        Number.isInteger(entry.chainId) &&
        typeof entry.rpcUrl === 'string' &&
        typeof entry.escrow === 'string' &&
        /^0x[0-9a-fA-F]{40}$/.test(entry.escrow)
      ) {
        return [{ chainId: entry.chainId as number, rpcUrl: entry.rpcUrl, escrow: entry.escrow as Address }];
      }
      log.warn('ignoring malformed spoke', { component: 'crosschain', entry: JSON.stringify(item) });
      return [];
    });
  } catch (error) {
    log.warn('SPOKES is not valid JSON', { component: 'crosschain', error: errorMessage(error) });
    return [];
  }
}
