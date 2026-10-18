#!/usr/bin/env node
/**
 * `npm run load` — opens many WebSocket players against a running game server
 * and reports what they experienced.
 *
 *   npm run load                                   1000 players, play mode, 60 s
 *   npm run load -- --clients 10000 --workers 8 --ramp 500 --duration 300
 *   npm run load -- --mode idle --clients 10000    connect + log in, then hold (soak)
 *   npm run load -- --url ws://staging:8787 --json report.json
 *
 * Each player is a `BotClient` from `@lms/harness`: it signs the login nonce
 * with its own key, opens a practice room against house bots and plays it
 * with commit/reveal, exactly as the browser client does. Players are spread
 * over worker threads so signing never bottlenecks on one core of the load
 * generator.
 *
 * The server must allow this many sockets from one IP. Start it with, e.g.:
 *
 *   MAX_CONNECTIONS_PER_IP=100000 MAX_PRACTICE_ROOMS=100000 \
 *   GATEWAY_LIMITS='{"connectRatePerIp":100000,"connectBurstPerIp":100000,"loginRatePerIp":100000,"loginBurstPerIp":100000}' \
 *   npm run dev --workspace @lms/server
 *
 * Exits non-zero when an SLO in `--slo-*` fails, so it can gate a deploy.
 * See docs/LOAD_TESTING.md for scenarios, generator limits and baselines.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

const SAMPLE_CAP = 50_000;

if (isMainThread) await main();
else await worker();

// ------------------------------------------------------------------ main

function parseArgs(argv) {
  const options = {
    url: 'ws://localhost:8787',
    clients: 1000,
    workers: Math.max(1, Math.min(8, availableParallelism() - 1)),
    ramp: 200, // new connections per second, across all workers
    duration: 60, // seconds after the ramp completes
    mode: 'play', // play | idle
    thinkMin: 500,
    thinkMax: 3000,
    hold: false,
    json: null,
    sloConnectPct: 99,
    sloAuthP99: 1000,
    sloRoundP99: 500,
    sloErrorPct: 1,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]?.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!key || !(key in options)) throw new Error(`unknown option ${argv[i]}`);
    if (typeof options[key] === 'boolean') {
      options[key] = true;
      continue;
    }
    const value = argv[++i];
    options[key] = typeof options[key] === 'number' ? Number(value) : value;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const totals = emptyTotals();
  const workers = [];
  const perWorker = Math.ceil(options.clients / options.workers);

  console.log(
    `load: ${options.clients} clients over ${options.workers} workers, ${options.mode} mode, ` +
      `ramp ${options.ramp}/s, hold ${options.duration}s after ramp → ${options.url}`,
  );

  const rampSeconds = options.clients / options.ramp;
  for (let w = 0; w < options.workers; w += 1) {
    const from = w * perWorker;
    const count = Math.max(0, Math.min(perWorker, options.clients - from));
    if (count === 0) break;
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { ...options, from, count, ramp: options.ramp / options.workers, runFor: rampSeconds + options.duration },
    });
    workers.push(
      new Promise((resolve, reject) => {
        worker.on('message', (message) => {
          if (message.type === 'progress') merge(totals, message.totals);
          if (message.type === 'final') {
            merge(totals, message.totals);
            resolve();
          }
        });
        worker.on('error', reject);
        worker.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
      }),
    );
  }

  const ticker = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    console.log(
      `  t=${s}s connected=${totals.open} authed=${totals.authed} rounds=${totals.rounds} ` +
        `games=${totals.finished} errors=${sum(totals.errors)} closes=${sum(totals.closes)}`,
    );
  }, 5000);
  ticker.unref();

  await Promise.all(workers);
  clearInterval(ticker);

  const report = summarise(options, totals, Date.now() - started);
  print(report);
  if (options.json) writeFileSync(options.json, JSON.stringify(report, null, 2));
  process.exitCode = report.slo.every((check) => check.ok) ? 0 : 1;
}

function emptyTotals() {
  return {
    attempted: 0,
    open: 0,
    connectedEver: 0,
    authed: 0,
    rounds: 0,
    finished: 0,
    errors: {},
    closes: {},
    auth: [],
    round: [],
  };
}

function merge(into, from) {
  into.attempted += from.attempted;
  into.open += from.open;
  into.connectedEver += from.connectedEver;
  into.authed += from.authed;
  into.rounds += from.rounds;
  into.finished += from.finished;
  for (const [key, n] of Object.entries(from.errors)) into.errors[key] = (into.errors[key] ?? 0) + n;
  for (const [key, n] of Object.entries(from.closes)) into.closes[key] = (into.closes[key] ?? 0) + n;
  for (const sample of from.auth) reservoir(into.auth, sample, into.authed);
  for (const sample of from.round) reservoir(into.round, sample, into.rounds);
}

/** Keeps a uniform sample of at most SAMPLE_CAP values. */
function reservoir(samples, value, seen) {
  if (samples.length < SAMPLE_CAP) samples.push(value);
  else {
    const slot = Math.floor(Math.random() * Math.max(seen, SAMPLE_CAP));
    if (slot < SAMPLE_CAP) samples[slot] = value;
  }
}

function sum(record) {
  return Object.values(record).reduce((a, b) => a + b, 0);
}

function percentile(samples, p) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
}

function summarise(options, totals, elapsedMs) {
  const connectPct = (100 * totals.connectedEver) / Math.max(1, options.clients);
  const actions = totals.rounds + totals.authed;
  const errorPct = (100 * sum(totals.errors)) / Math.max(1, actions);
  const authP99 = percentile(totals.auth, 99);
  const roundP99 = percentile(totals.round, 99);
  const slo = [
    { name: `connected ≥ ${options.sloConnectPct}%`, value: `${connectPct.toFixed(2)}%`, ok: connectPct >= options.sloConnectPct },
    { name: `login p99 ≤ ${options.sloAuthP99} ms`, value: `${authP99} ms`, ok: authP99 !== null && authP99 <= options.sloAuthP99 },
    { name: `errors ≤ ${options.sloErrorPct}% of actions`, value: `${errorPct.toFixed(3)}%`, ok: errorPct <= options.sloErrorPct },
  ];
  if (options.mode === 'play') {
    slo.push({
      name: `reveal→round p99 ≤ ${options.sloRoundP99} ms`,
      value: `${roundP99} ms`,
      ok: roundP99 !== null && roundP99 <= options.sloRoundP99,
    });
  }
  return {
    options,
    elapsedSeconds: Math.round(elapsedMs / 1000),
    clients: options.clients,
    connected: totals.connectedEver,
    authed: totals.authed,
    rounds: totals.rounds,
    gamesFinished: totals.finished,
    loginMs: { p50: percentile(totals.auth, 50), p95: percentile(totals.auth, 95), p99: authP99 },
    revealToRoundMs: { p50: percentile(totals.round, 50), p95: percentile(totals.round, 95), p99: roundP99 },
    errors: totals.errors,
    closeCodes: totals.closes,
    slo,
  };
}

function print(report) {
  console.log('\n=== load test report ===');
  console.log(`clients ${report.clients}, connected ${report.connected}, logged in ${report.authed}, ${report.elapsedSeconds}s`);
  console.log(`rounds ${report.rounds}, games finished ${report.gamesFinished}`);
  console.log(`login ms        p50 ${report.loginMs.p50}  p95 ${report.loginMs.p95}  p99 ${report.loginMs.p99}`);
  console.log(
    `reveal→round ms p50 ${report.revealToRoundMs.p50}  p95 ${report.revealToRoundMs.p95}  p99 ${report.revealToRoundMs.p99}`,
  );
  if (Object.keys(report.errors).length) console.log('errors', report.errors);
  if (Object.keys(report.closeCodes).length) console.log('close codes', report.closeCodes);
  for (const check of report.slo) console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}  (${check.value})`);
}

// ------------------------------------------------------------------ worker

async function worker() {
  const { BotClient, wsLink, keyFor, mulberry32 } = await import('@lms/harness');
  const options = workerData;
  const random = mulberry32(options.from + 1);
  let totals = emptyTotals();
  const bots = [];

  const onEvent = (event) => {
    switch (event.type) {
      case 'connected':
        totals.open += 1;
        totals.connectedEver += 1;
        break;
      case 'authed':
        totals.authed += 1;
        reservoir(totals.auth, event.ms, totals.authed);
        break;
      case 'round':
        if (event.ms !== null) {
          totals.rounds += 1;
          reservoir(totals.round, event.ms, totals.rounds);
        }
        break;
      case 'finished':
        totals.finished += 1;
        break;
      case 'error': {
        const key = event.message.slice(0, 60);
        totals.errors[key] = (totals.errors[key] ?? 0) + 1;
        break;
      }
      case 'closed':
        totals.open -= 1;
        totals.closes[event.code] = (totals.closes[event.code] ?? 0) + 1;
        break;
    }
  };

  const flush = (type) => {
    parentPort.postMessage({ type, totals });
    // Counters are deltas: the main thread sums them.
    totals = emptyTotals();
  };
  const progress = setInterval(() => flush('progress'), 1000);

  const interval = 1000 / options.ramp;
  for (let i = 0; i < options.count; i += 1) {
    const bot = new BotClient({
      privateKey: keyFor(options.from + i),
      connect: () => wsLink(options.url),
      games: Infinity,
      play: options.mode === 'play',
      hold: options.hold,
      thinkMs: () => options.thinkMin + random() * (options.thinkMax - options.thinkMin),
      random,
      onEvent,
    });
    bots.push(bot);
    totals.attempted += 1;
    bot.start();
    await sleep(interval);
  }

  await sleep(Math.max(0, options.runFor * 1000 - options.count * interval));
  for (const bot of bots) bot.stop();
  clearInterval(progress);
  await sleep(200);
  flush('final');
  process.exit(0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
