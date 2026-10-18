import type { AnalysisErrorCode } from '@lms/protocol';

/** Seconds. An analysis normally lands between a few seconds and a minute. */
const LATENCY_BUCKETS = [1, 2, 5, 10, 20, 30, 60, 120, 300];

/** How a request for an analysis ended. */
export type AnalysisOutcome = 'fresh' | 'cached' | 'shared' | 'reply' | 'error';

export interface FreshAnalysis {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
  toolCalls: number;
  /** Null when the model has no listed price. */
  costUsd: number | null;
  latencyMs: number;
  kept: number;
  dropped: number;
}

/**
 * Counters for everything an operator asks about a paid feature: how often
 * it runs, what it costs, how often the cache saves a call, whether the
 * prompt cache is actually being hit, and how much of what the model claims
 * survives the verifier.
 *
 * In-process and reset on restart, like the rest of the server's state; a
 * scraper keeps the history. Exposed as Prometheus text on `/metrics` and as
 * a few derived ratios on `/health`.
 */
export class AnalystMetrics {
  private readonly outcomes = new Map<AnalysisOutcome, number>();
  private readonly errors = new Map<AnalysisErrorCode, number>();
  private readonly tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private turns = 0;
  private toolCalls = 0;
  private costUsd = 0;
  private unpriced = 0;
  private kept = 0;
  private dropped = 0;
  private readonly latency = { buckets: LATENCY_BUCKETS.map(() => 0), sum: 0, count: 0 };

  count(outcome: 'cached' | 'shared'): void {
    this.bump(this.outcomes, outcome);
  }

  fail(code: AnalysisErrorCode): void {
    this.bump(this.outcomes, 'error');
    this.bump(this.errors, code);
  }

  fresh(analysis: FreshAnalysis): void {
    this.bump(this.outcomes, 'fresh');
    this.tokens.input += analysis.inputTokens;
    this.tokens.output += analysis.outputTokens;
    this.tokens.cacheRead += analysis.cacheReadTokens;
    this.tokens.cacheWrite += analysis.cacheWriteTokens;
    this.turns += analysis.turns;
    this.toolCalls += analysis.toolCalls;
    if (analysis.costUsd === null) this.unpriced += 1;
    else this.costUsd += analysis.costUsd;
    this.kept += analysis.kept;
    this.dropped += analysis.dropped;

    const seconds = analysis.latencyMs / 1000;
    this.latency.sum += seconds;
    this.latency.count += 1;
    LATENCY_BUCKETS.forEach((bound, i) => {
      if (seconds <= bound) this.latency.buckets[i] = (this.latency.buckets[i] ?? 0) + 1;
    });
  }

  /** A follow-up answer: its tokens and cost count, its latency and moments do not. */
  reply(usage: Omit<FreshAnalysis, 'kept' | 'dropped'>): void {
    this.bump(this.outcomes, 'reply');
    this.tokens.input += usage.inputTokens;
    this.tokens.output += usage.outputTokens;
    this.tokens.cacheRead += usage.cacheReadTokens;
    this.tokens.cacheWrite += usage.cacheWriteTokens;
    this.turns += usage.turns;
    this.toolCalls += usage.toolCalls;
    if (usage.costUsd === null) this.unpriced += 1;
    else this.costUsd += usage.costUsd;
  }

  /** The ratios worth a glance, for `/health`. Null where nothing has happened yet. */
  snapshot() {
    const outcome = (key: AnalysisOutcome) => this.outcomes.get(key) ?? 0;
    const answered = outcome('fresh') + outcome('cached') + outcome('shared');
    const prompt = this.tokens.input + this.tokens.cacheRead + this.tokens.cacheWrite;
    const moments = this.kept + this.dropped;
    return {
      requests: answered + outcome('error'),
      fresh: outcome('fresh'),
      followUps: outcome('reply'),
      errors: outcome('error'),
      /** Answers served without a model call. */
      analysisCacheHitRate: ratio(outcome('cached') + outcome('shared'), answered),
      /** Share of prompt tokens read from the prompt cache. */
      promptCacheHitRate: ratio(this.tokens.cacheRead, prompt),
      /** Share of the model's key moments the history did not support. */
      verifierDropRate: ratio(this.dropped, moments),
      estimatedCostUsd: round(this.costUsd),
      meanLatencySeconds: this.latency.count === 0 ? null : round(this.latency.sum / this.latency.count),
    };
  }

  /** Prometheus text exposition format, version 0.0.4. */
  prometheus(): string {
    const lines: string[] = [];
    const metric = (name: string, type: string, help: string, samples: Array<[string, number]>) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, value] of samples) lines.push(`${name}${labels} ${value}`);
    };

    metric(
      'analyst_requests_total',
      'counter',
      'Analysis requests and follow-up questions by how they ended.',
      (['fresh', 'cached', 'shared', 'reply', 'error'] as const).map((key) => [`{outcome="${key}"}`, this.outcomes.get(key) ?? 0]),
    );
    metric(
      'analyst_errors_total',
      'counter',
      'Failed analysis requests by error code.',
      [...this.errors].map(([code, value]) => [`{code="${code}"}`, value]),
    );
    metric('analyst_tokens_total', 'counter', 'Model tokens across every fresh analysis.', [
      ['{kind="input"}', this.tokens.input],
      ['{kind="output"}', this.tokens.output],
      ['{kind="cache_read"}', this.tokens.cacheRead],
      ['{kind="cache_write"}', this.tokens.cacheWrite],
    ]);
    metric('analyst_turns_total', 'counter', 'Model turns, tool turns included.', [['', this.turns]]);
    metric('analyst_tool_calls_total', 'counter', 'Tool calls the model made.', [['', this.toolCalls]]);
    metric('analyst_cost_usd_total', 'counter', 'Estimated spend at list prices.', [['', round(this.costUsd)]]);
    metric('analyst_unpriced_total', 'counter', 'Fresh analyses by a model with no listed price.', [
      ['', this.unpriced],
    ]);
    metric('analyst_moments_total', 'counter', 'Key moments by what the verifier decided.', [
      ['{verdict="kept"}', this.kept],
      ['{verdict="dropped"}', this.dropped],
    ]);

    lines.push(
      '# HELP analyst_latency_seconds Wall-clock time to write a fresh analysis.',
      '# TYPE analyst_latency_seconds histogram',
    );
    LATENCY_BUCKETS.forEach((bound, i) => {
      lines.push(`analyst_latency_seconds_bucket{le="${bound}"} ${this.latency.buckets[i] ?? 0}`);
    });
    lines.push(`analyst_latency_seconds_bucket{le="+Inf"} ${this.latency.count}`);
    lines.push(`analyst_latency_seconds_sum ${round(this.latency.sum)}`);
    lines.push(`analyst_latency_seconds_count ${this.latency.count}`);
    return `${lines.join('\n')}\n`;
  }

  private bump<K>(map: Map<K, number>, key: K): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }
}

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : round(part / whole);
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
