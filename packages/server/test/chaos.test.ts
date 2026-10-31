import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BotClient, keyFor, type BotEvent } from '@lms/harness';
import { DEFAULT_RULES, type MatchResult } from '@lms/protocol';
import { moveLogFromHistory, verifyResult, type MatchSetup } from '@lms/engine';
import { MemoryArchive, type Relayer } from '@lms/server';
import { simSigner, world, type Faults } from './sim.js';

/**
 * Chaos tests: real `BotClient`s against a real `Gateway` and `Lobby`, over a
 * simulated network that delays, resets and silently stalls connections, a
 * relayer that fails, and a server that restarts mid-match.
 *
 * Everything runs on a virtual clock from a seed, so a failure names its seed
 * and replays exactly: `CHAOS_SEEDS=1234 npx vitest run chaos`. The default
 * set is small enough for every test run; set `CHAOS_SEEDS=200` (a count) for
 * a soak.
 *
 * What must hold whatever the faults:
 * - liveness: every bot finishes its games within a bound;
 * - integrity: every archived staked result replays to itself;
 * - hygiene: once everyone has left, no connection, room or session leaks;
 * - no protocol errors beyond the ones a reconnect legitimately causes.
 */

function seeds(fallback: number[]): number[] {
  const raw = process.env.CHAOS_SEEDS;
  if (!raw) return fallback;
  if (/^\d+$/.test(raw) && Number(raw) > 1000) return [Number(raw)];
  if (/^\d+$/.test(raw)) return Array.from({ length: Number(raw) }, (_, i) => i + 1);
  return raw.split(',').map(Number);
}

/** Errors a well-behaved client can see because of a drop or a race, not a bug. */
const BENIGN = [
  /unknown match/, // its room was cleaned up, or died with a restarted server
  /not in a live match/, // a move that crossed the end of the match
  /is for round \d+; the match is on round|is for another match/, // a stale move, refused by its aim
  /phase|window|already/i, // a move that arrived after its window closed
];

const HARSH: Faults = { minDelayMs: 20, maxDelayMs: 400, resetRate: 0.01, stallRate: 0.003, refuseRate: 0.05, heartbeatMs: 30_000 };

interface Run {
  w: ReturnType<typeof world>;
  bots: BotClient[];
  events: Map<string, BotEvent[]>;
}

function players(w: ReturnType<typeof world>, count: number, options: Partial<ConstructorParameters<typeof BotClient>[0]> = {}): Run {
  const events = new Map<string, BotEvent[]>();
  const bots = Array.from({ length: count }, (_, i) => {
    const log: BotEvent[] = [];
    const privateKey = keyFor(i, `chaos-${w.random()}`);
    const bot = new BotClient({
      privateKey,
      signer: simSigner,
      connect: () => w.net.connect(`10.0.0.${i % 250}`),
      games: 2,
      thinkMs: () => 200 + w.random() * 3_000,
      schedule: w.clock.schedule,
      now: () => w.clock.now,
      random: w.random,
      onEvent: (event) => log.push(event),
      ...options,
    });
    events.set(bot.address, log);
    return bot;
  });
  return { w, bots, events };
}

async function runUntilDone(run: Run, limitMs: number): Promise<void> {
  for (const bot of run.bots) bot.start();
  for (let t = 0; t < limitMs && !run.bots.every((bot) => bot.done); t += 1_000) await run.w.clock.advance(1_000);
}

/** Replays every archived result with the engine's independent audit path. */
async function audit(archive: MemoryArchive, setups: Map<`0x${string}`, MatchSetup>): Promise<void> {
  for (const [matchId, setup] of setups) {
    const archived = await archive.load(matchId);
    if (!archived) continue;
    expect(verifyResult(setup, moveLogFromHistory(archived.history), archived.result), `replay of ${matchId}`).toBe(true);
  }
}

/** Bots that did not finish, each with its last few events, so a failure explains itself. */
function stuck(run: Run): string[] {
  return run.bots
    .filter((bot) => !bot.done)
    .map((bot) => `${bot.address} played ${bot.played}: ${JSON.stringify((run.events.get(bot.address) ?? []).slice(-8))}`);
}

function unexpectedErrors(run: Run): string[] {
  const out: string[] = [];
  for (const log of run.events.values()) {
    for (const event of log) {
      if (event.type === 'error' && !BENIGN.some((pattern) => pattern.test(event.message))) out.push(event.message);
    }
  }
  return out;
}

describe('chaos: reproducibility', () => {
  /** Every bot event with its virtual timestamp, hashed: two runs agree only if they took the same path. */
  async function fingerprint(seed: number): Promise<string> {
    const w = world(seed);
    w.net.faults = HARSH;
    const run = players(w, 6);
    await runUntilDone(run, 30 * 60_000);
    const trace = [...run.events.values()].flat().map((event) => JSON.stringify(event));
    return createHash('sha256').update(trace.join('|')).digest('hex');
  }

  it('replays a seed exactly, so any failure can be reproduced from its seed', async () => {
    expect(await fingerprint(42)).toBe(await fingerprint(42));
    expect(await fingerprint(42)).not.toBe(await fingerprint(43));
  });
});

describe('chaos: practice rooms over a hostile network', () => {
  it.each(seeds([1, 2, 3]))('seed %i: every bot finishes, nothing leaks', async (seed) => {
    const w = world(seed);
    w.net.faults = HARSH;
    const run = players(w, 12);

    await runUntilDone(run, 30 * 60_000);
    expect(stuck(run), `seed ${seed}`).toEqual([]);
    expect(unexpectedErrors(run), `seed ${seed}`).toEqual([]);

    // Everyone has left: give the server time to close stalls and drop rooms.
    await w.clock.advance(120_000);
    expect(w.gateway.connections, `seed ${seed} sessions`).toBe(0);
    expect(w.lobby.size, `seed ${seed} rooms`).toBe(0);
  });

  it.each(seeds([4, 5]))('seed %i: held moves are revealed for players who drop', async (seed) => {
    const w = world(seed);
    w.net.faults = { ...HARSH, resetRate: 0.03 };
    const run = players(w, 8, { hold: true });
    await runUntilDone(run, 30 * 60_000);
    expect(stuck(run), `seed ${seed}`).toEqual([]);
    expect(unexpectedErrors(run), `seed ${seed}`).toEqual([]);
  });
});

describe('chaos: staked tables', () => {
  /** Seats the bots at one staked table, as the bridge would once the escrow goes Live. */
  function seat(w: ReturnType<typeof world>, run: Run, matchId: `0x${string}`): MatchSetup {
    const setup: MatchSetup = {
      matchId,
      seats: run.bots.map((bot, index) => ({ index, address: bot.address, chainId: 1 })),
      seed: `0x${'5e'.repeat(32)}`,
      rules: DEFAULT_RULES,
    };
    w.lobby.adopt(setup, [], w.clock.now);
    return setup;
  }

  function flakyRelayer(random: () => number, failRate: number) {
    const calls: Array<{ matchId: string; ok: boolean }> = [];
    const relayer: Relayer = {
      async settle(result: MatchResult) {
        const ok = random() >= failRate;
        calls.push({ matchId: result.matchId, ok });
        if (!ok) throw new Error('rpc timeout');
        return `0x${'7a'.repeat(32)}`;
      },
      abort: async () => null,
    };
    return { relayer, calls };
  }

  it.each(seeds([6, 7, 8]))('seed %i: a four-player table settles despite drops and a failing relayer', async (seed) => {
    let flaky: ReturnType<typeof flakyRelayer> | null = null;
    const archive = new MemoryArchive();
    const w = world(seed, {
      archive,
      relayer: {
        settle: (result) => (flaky as ReturnType<typeof flakyRelayer>).relayer.settle(result),
        abort: async () => null,
      },
    });
    flaky = flakyRelayer(w.random, 0.5);
    w.net.faults = HARSH;
    const matchId = `0x${String(seed).padStart(64, '0')}` as const;
    const run = players(w, 4, { games: 1, play: false, table: matchId });
    const setup = seat(w, run, matchId);
    for (const bot of run.bots) bot.start();

    for (let t = 0; t < 30 * 60_000 && !w.lobby.get(setup.matchId)?.finished; t += 1_000) await w.clock.advance(1_000);
    expect(w.lobby.get(setup.matchId)?.finished, `seed ${seed}`).toBe(true);
    // The retry queue keeps at it for the settle window; at even odds an
    // hour of tries all failing does not happen.
    for (let t = 0; t < 2 * 60 * 60_000 && w.lobby.pendingSettlements > 0; t += 60_000) await w.clock.advance(60_000);
    expect(w.lobby.pendingSettlements, `seed ${seed}`).toBe(0);

    const attempts = flaky.calls.filter((call) => call.matchId === setup.matchId);
    const archived = await archive.load(setup.matchId);
    expect(archived, `seed ${seed}`).toBeDefined();
    // Settled on the first successful attempt, and never tried again after it.
    expect(archived?.settledTx).not.toBeNull();
    expect(attempts.filter((call) => call.ok)).toHaveLength(1);
    expect(attempts[attempts.length - 1]?.ok).toBe(true);
    await audit(archive, new Map([[setup.matchId, setup]]));
  });
});

describe('chaos: server restart', () => {
  it.each(seeds([9, 10]))('seed %i: bots recover from a restart mid-match and keep playing', async (seed) => {
    const w = world(seed);
    w.net.faults = { minDelayMs: 20, maxDelayMs: 200 };
    const run = players(w, 10, { games: 2 });
    for (const bot of run.bots) bot.start();
    // Let every bot get into a match, then kill the server under them.
    await w.clock.advance(20_000);
    expect(w.lobby.size).toBeGreaterThan(0);
    w.restart();

    for (let t = 0; t < 30 * 60_000 && !run.bots.every((bot) => bot.done); t += 1_000) await w.clock.advance(1_000);
    expect(stuck(run), `seed ${seed}`).toEqual([]);
    expect(unexpectedErrors(run), `seed ${seed}`).toEqual([]);
  });
});
