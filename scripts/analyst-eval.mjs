#!/usr/bin/env node
/**
 * `npm run eval:analyst` — scores the match analyst against the reference
 * suite: real bot matches with known facts (see packages/server/src/analyst/evals.ts).
 *
 *   npm run eval:analyst -- --demo                 free: the offline demo model, to check the harness
 *   npm run eval:analyst -- --yes                  calls Claude and SPENDS MONEY (needs ANTHROPIC_API_KEY)
 *   npm run eval:analyst -- --yes --cases=6 --effort=low --model=claude-opus-5-5 --concurrency=3
 *
 * Without `--yes` or `--demo` it prints what a run would do and exits, so it
 * can never spend by accident. It is not part of `npm test`.
 *
 * Reports, per case and pooled: grounding rate (key moments the history
 * supports / all claimed), decisive-round hit rate, how often the narrative
 * names the winner, prompt-cache hit rate, cost at list prices and latency.
 * The full results go to eval-results/ as JSON; the last line is a Markdown
 * row for the table in the README.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  Analyst,
  MemoryArchive,
  anthropicModel,
  demoModel,
  markdownRow,
  referenceSuite,
  scoreAnalysis,
  summarize,
} from '../packages/server/dist/index.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;

const demo = flag('demo');
const confirmed = flag('yes');
const modelId = demo ? 'demo' : option('model', process.env.ANALYST_MODEL || 'claude-opus-5-5');
const effort = option('effort', process.env.ANALYST_EFFORT || 'medium');
const concurrency = Math.max(1, Number(option('concurrency', '3')));
const cases = referenceSuite().slice(0, Number(option('cases', '24')));

/** Rough, for the warning only: ~3 turns over a cached ~5k-token prefix, ~2k output tokens with thinking. */
const ROUGH_USD_PER_CASE = 0.1;

if (!demo && !confirmed) {
  console.log(
    `This would run ${cases.length} analyses on ${modelId} at ${effort} effort, calling the Anthropic API.\n` +
      `Very roughly $${(cases.length * ROUGH_USD_PER_CASE).toFixed(2)} at list prices; the real figure is printed at the end.\n\n` +
      'Re-run with --yes to spend it, or with --demo to exercise the harness for free.',
  );
  process.exit(1);
}
if (!demo && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error('Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) to run against Claude.');
  process.exit(1);
}

const archive = new MemoryArchive();
for (const test of cases) await archive.save(test.match);
const analyst = new Analyst({
  archive,
  model: demo ? demoModel(archive, { chunkDelayMs: 0 }) : anthropicModel({ timeoutMs: 120_000, maxRetries: 2 }),
  modelId,
  effort,
  maxTokens: 16_000,
});

const SPECTATOR = `0x${'5e'.repeat(20)}`;
const scores = [];
const failures = [];

async function run(test) {
  const requester = test.seat === null ? SPECTATOR : test.match.seats[test.seat].address;
  try {
    const { analysis, usage } = await analyst.analyze({ matchId: test.match.result.matchId, requester });
    const score = scoreAnalysis(test, analysis, usage);
    scores.push({ ...score, analysis });
    const grounding = score.groundingRate === null ? '–' : `${score.verified}/${score.claims}`;
    console.log(
      `${test.name}  grounded ${grounding}  decisive ${score.decisiveHit ? 'yes' : 'no '} (said ${analysis.decisiveRound}, ` +
        `accepts ${test.decisiveRounds.join('/')})  winner ${score.namesWinner ? 'named' : 'missing'}  ` +
        `$${(score.costUsd ?? 0).toFixed(4)}  ${(score.latencyMs / 1000).toFixed(1)} s`,
    );
  } catch (error) {
    failures.push({ name: test.name, code: error.code ?? 'failed', message: error.message });
    console.log(`${test.name}  FAILED ${error.code ?? ''}: ${error.message}`);
  }
}

// The first case alone: a cache entry is readable only once its writer has
// started streaming, so a parallel start would pay for the shared prefix N times.
const [first, ...rest] = cases;
if (first) await run(first);
const queue = [...rest];
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (let test = queue.shift(); test; test = queue.shift()) await run(test);
  }),
);

const summary = summarize(scores, failures.length);
console.log('\nsummary', JSON.stringify(summary, null, 2));
console.log('\n| run | cases | grounding | decisive round | names winner | prompt cache | cost | mean latency |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
console.log(markdownRow(`${modelId} · ${effort}`, summary));

mkdirSync('eval-results', { recursive: true });
const file = `eval-results/analyst-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify({ modelId, effort, version: analyst.version, summary, scores, failures }, null, 2));
console.log(`\nwrote ${file}`);
