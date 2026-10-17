import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { AUTH_PREFIX, type ServerMessage } from '@lms/protocol';
import {
  CrossChainMonitor,
  Gateway,
  JoinReconciler,
  Lobby,
  MemoryArchive,
  createLogger,
  metrics,
  nullRelayer,
  parseSpokes,
  type ForwardedJoin,
  type HubLogs,
  type Level,
  type LogSource,
  type Socket,
} from '@lms/server';
import { lastOfType } from './helpers.js';

const HUB = 11155111;
const SPOKE = 84532;
const MATCH = `0x${'aa'.repeat(32)}` as const;
const PLAYER = `0x${'bb'.repeat(20)}` as const;
const OTHER = `0x${'cc'.repeat(20)}` as const;

/** Current value of a metric series, or 0 when it has none yet. */
async function value(name: string, labels: Record<string, string> = {}): Promise<number> {
  const metric = metrics.registry.getSingleMetric(name);
  if (!metric) throw new Error(`no metric ${name}`);
  const { values } = await metric.get();
  const match = values.find((entry) =>
    Object.entries(labels).every(([key, label]) => String(entry.labels[key]) === label),
  );
  return match?.value ?? 0;
}

describe('structured logger', () => {
  function capture(options: Parameters<typeof createLogger>[0] = {}) {
    const lines: Array<{ level: Level; line: string }> = [];
    const logger = createLogger({ now: () => 0, ...options, sink: (level, line) => lines.push({ level, line }) });
    return { logger, lines };
  }

  it('writes one JSON object per line with the bound and given fields', () => {
    const { logger, lines } = capture({ format: 'json' });
    logger.child({ component: 'room', matchId: MATCH }).warn('missed', { round: 3, wei: 10n, error: new Error('boom') });

    expect(lines[0]?.level).toBe('warn');
    expect(JSON.parse(lines[0]?.line ?? '')).toEqual({
      time: '1970-01-01T00:00:00.000Z',
      level: 'warn',
      msg: 'missed',
      component: 'room',
      matchId: MATCH,
      round: 3,
      wei: '10',
      error: 'boom',
    });
  });

  it('drops lines below the configured level', () => {
    const { logger, lines } = capture({ level: 'warn' });
    logger.info('quiet');
    logger.debug('quieter');
    logger.error('loud');
    expect(lines.map((entry) => entry.level)).toEqual(['error']);
  });

  it('prints a readable line in pretty mode', () => {
    const { logger, lines } = capture({ format: 'pretty' });
    logger.child({ component: 'chain' }).info('locked', { matchId: '0x12' });
    expect(lines[0]?.line).toBe('[chain] locked matchId=0x12');
  });
});

describe('join reconciler', () => {
  const join: ForwardedJoin = { matchId: MATCH, player: PLAYER };

  it('times a forwarded join until the hub seats it', async () => {
    const before = await value('lms_crosschain_delivered_total', { origin: String(SPOKE), outcome: 'seated' });
    const reconciler = new JoinReconciler(HUB, new Set([SPOKE]), 60_000);
    reconciler.forwarded(SPOKE, join, 1_000);
    expect(reconciler.report(2_000, 10_000).pending.get(SPOKE)).toBe(1);

    reconciler.seated({ ...join, origin: SPOKE }, 31_000);
    expect(reconciler.report(31_000, 10_000).pending.size).toBe(0);
    expect(await value('lms_crosschain_delivered_total', { origin: String(SPOKE), outcome: 'seated' })).toBe(
      before + 1,
    );
  });

  it('accounts for a refund as a delivery', () => {
    const reconciler = new JoinReconciler(HUB, new Set([SPOKE]), 60_000);
    reconciler.forwarded(SPOKE, join, 0);
    reconciler.refunded({ matchId: MATCH, player: PLAYER.toUpperCase().replace('0X', '0x') as `0x${string}` }, 5);
    expect(reconciler.report(10, 1).stuck).toEqual([]);
  });

  it('reports a join the hub never acts on as stuck', () => {
    const reconciler = new JoinReconciler(HUB, new Set([SPOKE]), 60_000);
    reconciler.forwarded(SPOKE, join, 0);
    expect(reconciler.report(599_999, 600_000).stuck).toEqual([]);
    expect(reconciler.report(600_000, 600_000).stuck).toEqual([{ ...join, origin: SPOKE, ageMs: 600_000 }]);
  });

  it('matches a hub seat seen before its forward, since the spoke poll can lag', () => {
    const reconciler = new JoinReconciler(HUB, new Set([SPOKE]), 60_000);
    reconciler.seated({ ...join, origin: SPOKE }, 0);
    reconciler.forwarded(SPOKE, join, 10_000);
    expect(reconciler.report(20_000, 1).pending.size).toBe(0);
  });

  it('counts a spoke-origin seat that no spoke ever forwarded as an orphan', async () => {
    const before = await value('lms_crosschain_orphans_total', { origin: String(SPOKE) });
    const reconciler = new JoinReconciler(HUB, new Set([SPOKE]), 60_000);
    reconciler.seated({ matchId: MATCH, player: OTHER, origin: SPOKE }, 0);
    // Direct hub joins and refunds of them are never ours.
    reconciler.seated({ matchId: MATCH, player: PLAYER, origin: HUB }, 0);
    reconciler.refunded({ matchId: MATCH, player: PLAYER }, 0);
    reconciler.report(59_999, 1);
    expect(await value('lms_crosschain_orphans_total', { origin: String(SPOKE) })).toBe(before);
    reconciler.report(60_000, 1);
    expect(await value('lms_crosschain_orphans_total', { origin: String(SPOKE) })).toBe(before + 1);
  });
});

describe('cross-chain monitor', () => {
  class FakeSource<T> implements LogSource<T> {
    head = 0n;
    readonly ranges: Array<[bigint, bigint]> = [];
    fail = false;
    constructor(private readonly batch: (from: bigint, to: bigint) => T) {}
    async blockNumber(): Promise<bigint> {
      return this.head;
    }
    async logs(from: bigint, to: bigint): Promise<T> {
      if (this.fail) throw new Error('rpc down');
      this.ranges.push([from, to]);
      return this.batch(from, to);
    }
  }

  it('scans in bounded ranges, and retries a failed range on the next poll', async () => {
    const forwarded = new Set<bigint>([5n]);
    const spoke = new FakeSource<ForwardedJoin[]>((from, to) =>
      [...forwarded].filter((block) => block >= from && block <= to).map(() => ({ matchId: MATCH, player: PLAYER })),
    );
    const hub = new FakeSource<HubLogs>(() => ({ seats: [], refunds: [] }));
    spoke.head = 9n;
    hub.head = 9n;
    const clock = { now: 0 };
    const monitor = new CrossChainMonitor({
      hubChainId: HUB,
      hub,
      spokes: [{ chainId: SPOKE, source: spoke }],
      lookbackBlocks: 100n,
      maxRange: 4n,
      stuckAfterMs: 1_000,
      now: () => clock.now,
    });

    await monitor.poll();
    expect(spoke.ranges).toEqual([
      [0n, 3n],
      [4n, 7n],
      [8n, 9n],
    ]);
    expect(await value('lms_crosschain_pending', { origin: String(SPOKE) })).toBe(1);

    spoke.fail = true;
    spoke.head = 12n;
    await monitor.poll();
    spoke.fail = false;
    await monitor.poll();
    expect(spoke.ranges.at(-1)).toEqual([10n, 12n]);

    clock.now = 1_000;
    await monitor.poll();
    expect(await value('lms_crosschain_stuck', { origin: String(SPOKE) })).toBe(1);
  });

  it('parses SPOKES, skipping malformed entries', () => {
    expect(
      parseSpokes(
        JSON.stringify([
          { chainId: SPOKE, rpcUrl: 'http://x', escrow: `0x${'11'.repeat(20)}` },
          { chainId: 'nope', rpcUrl: 'http://x', escrow: '0x' },
        ]),
      ),
    ).toEqual([{ chainId: SPOKE, rpcUrl: 'http://x', escrow: `0x${'11'.repeat(20)}` }]);
    expect(parseSpokes('')).toEqual([]);
    expect(parseSpokes('{')).toEqual([]);
  });
});

describe('gateway and room metrics', () => {
  class Recorder implements Socket {
    readyState = 1;
    readonly sent: ServerMessage[] = [];
    private listener?: (data: unknown) => void;
    private closeListener?: () => void;
    send(data: string): void {
      this.sent.push(JSON.parse(data) as ServerMessage);
    }
    onMessage(listener: (data: unknown) => void): void {
      this.listener = listener;
    }
    onClose(listener: () => void): void {
      this.closeListener = listener;
    }
    async text(data: string): Promise<void> {
      this.listener?.(data);
      await new Promise((resolve) => setImmediate(resolve));
    }
    close(): void {
      this.closeListener?.();
    }
  }

  it('tracks connections, logins, frames and rejections', async () => {
    const lobby = new Lobby({ archive: new MemoryArchive(), relayer: nullRelayer, commitMs: 10_000, revealMs: 5_000 });
    const gateway = new Gateway({ lobby, chainId: HUB, directory: () => ({ open: [], live: [] }) });
    const account = privateKeyToAccount(`0x${'44'.repeat(32)}`);
    const connections = await value('lms_ws_connections');
    const ok = await value('lms_logins_total', { outcome: 'ok' });
    const invalid = await value('lms_ws_rejected_total', { reason: 'invalid' });
    const practice = await value('lms_rooms_active', { kind: 'practice' });

    const socket = new Recorder();
    gateway.accept(socket, { ip: 'metrics' });
    expect(await value('lms_ws_connections')).toBe(connections + 1);

    const nonce = lastOfType(socket.sent, 'hello')?.nonce;
    const signature = await account.signMessage({ message: `${AUTH_PREFIX}${nonce}` });
    await socket.text(JSON.stringify({ type: 'auth', address: account.address, signature }));
    await socket.text('garbage');
    await socket.text(JSON.stringify({ type: 'practice' }));

    expect(await value('lms_logins_total', { outcome: 'ok' })).toBe(ok + 1);
    expect(await value('lms_ws_rejected_total', { reason: 'invalid' })).toBe(invalid + 1);
    expect(await value('lms_rooms_active', { kind: 'practice' })).toBe(practice + 1);

    socket.close();
    expect(await value('lms_ws_connections')).toBe(connections);
  });

  it('audits a finished match against the replay, and counts what players missed', async () => {
    const lobby = new Lobby({ archive: new MemoryArchive(), relayer: nullRelayer, commitMs: 1_000, revealMs: 1_000 });
    const mismatches = await value('lms_replay_mismatch_total');
    const finished = await value('lms_matches_finished_total', { kind: 'practice' });
    const missed = await value('lms_missed_moves_total', { phase: 'commit' });

    // The human never moves, so every round runs to its deadline.
    const room = lobby.createPractice(PLAYER, 3, 0);
    let now = 0;
    for (let i = 0; i < 500 && !room.finished; i += 1) lobby.tick((now += 1_000));
    await new Promise((resolve) => setImmediate(resolve));

    expect(room.finished).toBe(true);
    expect(await value('lms_matches_finished_total', { kind: 'practice' })).toBe(finished + 1);
    expect(await value('lms_missed_moves_total', { phase: 'commit' })).toBeGreaterThan(missed);
    expect(await value('lms_replay_mismatch_total')).toBe(mismatches);
  });

  it('exposes everything in the Prometheus text format', async () => {
    const text = await metrics.registry.metrics();
    expect(text).toContain('# TYPE lms_ws_connections gauge');
    expect(text).toContain('# TYPE lms_crosschain_delivery_seconds histogram');
  });
});
