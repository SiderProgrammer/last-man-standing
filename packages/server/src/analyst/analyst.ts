import { createHash } from 'node:crypto';
import { addressKey } from '@lms/consensus';
import {
  errorMessage,
  type AnalysisErrorCode,
  type KeyMoment,
  type MatchAnalysis,
} from '@lms/api';
import type { ArchivedMatch, MatchArchive } from '../lobby/store.js';
import type { StyleBook } from '../lobby/styles.js';
import { ProviderError, type AnalystModel, type Effort, type ModelReply, type ModelRequest } from './model.js';
import { SYSTEM_PROMPT, renderRequest } from './prompt.js';
import { MalformedAnalysisError, outputSchema, parseAnalysisOutput } from './schema.js';
import { briefMatch } from './briefing.js';
import type { AnalystLimits } from './limits.js';
import { callCost } from './pricing.js';
import { checkDecisiveRound, verifyMoments } from './verify.js';

export type { Effort };

export interface AnalystOptions {
  archive: MatchArchive;
  model: AnalystModel;
  /** Model id, e.g. `gemini-3.8-flash`. */
  modelId: string;
  effort: Effort;
  /** Output ceiling, thinking included. */
  maxTokens: number;
  /** Earlier play styles by wallet, for each seat's record. Omitted, nobody has a record. */
  styles?: StyleBook;
  /**
   * Wall-clock ceiling on one analysis, retries included, in
   * milliseconds. The model's own timeout is per attempt; this bounds the
   * whole thing. Defaults to three minutes.
   */
  deadlineMs?: number;
  /** Quotas, concurrency, the daily budget and the provider's rate limits. Omitted, nothing is limited. */
  limits?: AnalystLimits;
  /** Wall clock in milliseconds, injectable for tests. */
  now?: () => number;
  /** Waits out a rate-limit slot. Injectable so tests do not sleep. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface AnalyzeRequest {
  matchId: `0x${string}`;
  /** The authenticated wallet asking. Decides whose seat the advice is for. */
  requester: `0x${string}`;
  /**
   * A short line on what the analyst is doing now, e.g. "Reading round 4", so
   * the asker can see it is working through a call that takes up to a minute.
   */
  onStep?: (step: string) => void;
  /** Aborts the model call: the asker went away. */
  signal?: AbortSignal;
}

/** What one analysis cost. */
export interface AnalysisUsage {
  model: string;
  /** Input tokens billed at the full rate: everything after the cached prefix. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the prompt cache, at a small fraction of the rate. */
  cacheReadTokens: number;
  /** Estimate at list prices; null for a model with no listed price. */
  costUsd: number | null;
  latencyMs: number;
}

export interface AnalyzeResult {
  analysis: MatchAnalysis;
  /** True when served from the analysis cache rather than written now. */
  cached: boolean;
  /** Absent for a cached analysis, which cost nothing. */
  usage?: AnalysisUsage;
}

/** What the gateway needs from an analyst. An interface so the gateway's tests can fake it. */
export interface MatchAnalyst {
  analyze(request: AnalyzeRequest): Promise<AnalyzeResult>;
}

/** A failure with a code the client can act on. */
export class AnalystError extends Error {
  constructor(
    readonly code: AnalysisErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AnalystError';
  }
}

const DEFAULT_DEADLINE_MS = 180_000;

/**
 * Writes post-match analyses with a language model.
 *
 * Strictly a reader. It sees a match only once the archive has it, which is
 * after the result was computed, signed and submitted; nothing it produces
 * flows back into a room, the engine, the history hash or settlement. The
 * worst a wrong analysis can do is be wrong, and the claim verifier keeps
 * even that to the prose.
 *
 * One structured-output call per analysis: the prompt holds the whole match,
 * so there is nothing for the model to look up, and on a rationed free tier
 * one call is the difference between one slow request and several. The model
 * is injected, so the network is never the analyst's concern.
 *
 * Prompt layout, for the provider's implicit prefix cache: the frozen system
 * prompt — identical bytes on every request from every player — then the
 * match.
 */
export class Analyst implements MatchAnalyst {
  /**
   * Digest of everything that shapes an answer. Cached analyses are keyed by
   * it, so a new prompt, schema, model or effort level never serves an
   * answer written under the old one.
   */
  readonly version: string;
  /** Analyses being written, by match and seat, so a second asker waits instead of paying twice. */
  private readonly inflight = new Map<string, Promise<AnalyzeResult>>();

  constructor(private readonly options: AnalystOptions) {
    this.version = analysisVersion(options);
  }

  /** Every failure comes out as an `AnalystError`, so callers have one thing to catch. */
  async analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
    try {
      return await this.serve(request);
    } catch (error) {
      const failure = classify(error);
      // Logged here because the player only sees the code; the operator needs the reason.
      console.warn(`[analyst] ${request.matchId} failed (${failure.code}): ${failure.message}`);
      throw failure;
    }
  }

  /**
   * Who may ask, then the cheapest way to answer: the archive, then an
   * analysis already being written, and only then a model call — which is
   * the one step the limits apply to.
   */
  private async serve(request: AnalyzeRequest): Promise<AnalyzeResult> {
    const { match, seat } = await this.authorize(request.matchId, request.requester);

    const cached = await this.cached(match, seat);
    if (cached) return { analysis: cached, cached: true };

    const key = `${match.result.matchId.toLowerCase()}:${seat ?? 'spectator'}`;
    const running = this.inflight.get(key);
    if (running) {
      request.onStep?.('Another request is already writing this analysis');
      const { analysis } = await running;
      return { analysis, cached: true };
    }

    const job = this.paid(request.requester, request.signal, () => this.write(request, match, seat));
    this.inflight.set(key, job);
    try {
      const result = await job;
      await this.options.archive.saveAnalysis({ analysis: result.analysis, version: this.version }).catch((error: unknown) => {
        console.warn('[analyst] could not cache the analysis:', errorMessage(error));
      });
      return result;
    } finally {
      this.inflight.delete(key);
    }
  }

  /**
   * The match, if the requester may see an analysis of it, and the seat to
   * write from. A staked match was public while it ran; a practice match is
   * the practising player's own, and so is what an analysis of it would say.
   */
  private async authorize(matchId: `0x${string}`, requester: `0x${string}`): Promise<{ match: ArchivedMatch; seat: number | null }> {
    const match = await this.options.archive.load(matchId);
    if (!match) throw new AnalystError('not_found', 'no finished match with that id');
    const seat = match.seats.find((entry) => addressKey(entry.address) === addressKey(requester))?.index ?? null;
    if (seat === null && !match.staked) {
      throw new AnalystError('forbidden', 'only the players who sat in this match can analyse it');
    }
    return { match, seat };
  }

  /**
   * Runs a paid model job under the limits: claims a slot, records the spend,
   * and hands the allowance back when the failure was not the player's —
   * anything but a refusal, unless they cancelled it themselves.
   */
  private async paid<T extends { usage?: AnalysisUsage }>(
    wallet: `0x${string}`,
    signal: AbortSignal | undefined,
    job: () => Promise<T>,
  ): Promise<T> {
    const ticket = this.options.limits?.admit(wallet, this.now());
    if (ticket && 'code' in ticket) throw new AnalystError(ticket.code, ticket.message);
    let refund = false;
    try {
      const result = await job();
      if (result.usage) this.options.limits?.spend(result.usage.costUsd ?? 0, this.now());
      return result;
    } catch (error) {
      refund = classify(error).code !== 'refused' && signal?.aborted !== true;
      throw error;
    } finally {
      if (ticket && 'release' in ticket) ticket.release(refund, this.now());
    }
  }

  /** A stored analysis for this match, seat and version. A broken cache is a miss, not a failure. */
  private async cached(match: ArchivedMatch, seat: number | null): Promise<MatchAnalysis | null> {
    try {
      return await this.options.archive.loadAnalysis(match.result.matchId, seat, this.version);
    } catch (error) {
      console.warn('[analyst] could not read the analysis cache:', errorMessage(error));
      return null;
    }
  }

  /** Runs `job` inside the wall-clock deadline, which reads as a timeout rather than a cancellation. */
  private async withDeadline<T>(signal: AbortSignal | undefined, job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const deadline = AbortSignal.timeout(this.options.deadlineMs ?? DEFAULT_DEADLINE_MS);
    try {
      return await job(signal ? AbortSignal.any([signal, deadline]) : deadline);
    } catch (error) {
      if (deadline.aborted) throw new AnalystError('timeout', 'the analyst took too long and was stopped');
      throw error;
    }
  }

  /** One fresh analysis. */
  private async write(request: AnalyzeRequest, match: ArchivedMatch, seat: number | null): Promise<AnalyzeResult> {
    const started = this.now();
    const prompt = renderRequest(match, seat, await briefMatch(match, seat, this.options.styles));
    const reply = await this.withDeadline(request.signal, (signal) =>
      this.call(this.request(prompt), signal, (text) => request.onStep?.(text)),
    );
    const usage = this.usage(reply);

    request.onStep?.('Checking the key moments against the rounds');
    const output = parseAnalysisOutput(reply.text);
    const moments: KeyMoment[] = output.keyMoments.map((moment) => ({ ...moment }));
    const { kept, dropped } = verifyMoments(moments, match.history);
    for (const entry of dropped) {
      console.info(`[analyst] dropped a ${entry.moment.kind} claim on ${request.matchId}: ${entry.reason}`);
    }
    usage.latencyMs = this.now() - started;
    console.info(
      `[analyst] ${request.matchId} for ${seat === null ? 'a spectator' : `seat ${seat}`}: ${describeUsage(usage)}; ` +
        `${kept.length} moments kept, ${dropped.length} dropped`,
    );

    return {
      analysis: {
        matchId: match.result.matchId,
        seat,
        summary: output.summary,
        decisiveRound: checkDecisiveRound(output.decisiveRound, match.history),
        keyMoments: kept,
        advice: output.advice,
        dropped: dropped.length,
        model: reply.model,
      },
      cached: false,
      usage,
    };
  }

  /** The request. Everything but `prompt` is the same bytes for every analysis of every match. */
  private request(prompt: string): ModelRequest {
    return {
      model: this.options.modelId,
      max_tokens: this.options.maxTokens,
      effort: this.options.effort,
      system: SYSTEM_PROMPT,
      output_schema: outputSchema(),
      prompt,
    };
  }

  /**
   * The model call, once the provider's rate limits allow it. A finished
   * answer continues; anything else ends the analysis.
   */
  private async call(request: ModelRequest, signal: AbortSignal, step: (text: string) => void): Promise<ModelReply> {
    const slot = this.options.limits?.reserve(this.now());
    if (slot && 'code' in slot) throw new AnalystError(slot.code, slot.message);
    if (slot && slot.waitMs > 0) {
      step(`Waiting for a free Gemini slot, about ${Math.ceil(slot.waitMs / 1000)}s (free-tier rate limit)`);
      await (this.options.sleep ?? sleep)(slot.waitMs, signal);
    }

    step('Gemini is reading the whole match and writing the analysis');
    const started = this.now();
    const reply = await this.options.model.generate(request, signal);
    console.info(`[analyst] model call: ${reply.stop_reason} after ${this.now() - started} ms`);
    switch (reply.stop_reason) {
      case 'end_turn':
        return reply;
      case 'refusal':
        throw new AnalystError('refused', 'the model declined to analyse this match');
      case 'max_tokens':
        throw new AnalystError('failed', 'the analysis ran past its length limit');
      default:
        throw new AnalystError('failed', `the model stopped unexpectedly (${reply.stop_reason})`);
    }
  }

  /** Tokens and cost, priced by the model that served the call. */
  private usage(reply: Pick<ModelReply, 'model' | 'usage'>): AnalysisUsage {
    return {
      model: reply.model,
      inputTokens: reply.usage.input_tokens,
      outputTokens: reply.usage.output_tokens,
      cacheReadTokens: reply.usage.cache_read_input_tokens,
      costUsd: callCost(reply.model, reply.usage),
      latencyMs: 0,
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

/** One line of usage for the log. */
function describeUsage(usage: AnalysisUsage): string {
  return (
    `${usage.latencyMs} ms; ` +
    `input ${usage.inputTokens} + cache read ${usage.cacheReadTokens}, ` +
    `output ${usage.outputTokens}; ~$${usage.costUsd?.toFixed(4) ?? '?'}`
  );
}

/** See `Analyst.version`. */
function analysisVersion(options: AnalystOptions): string {
  const inputs = JSON.stringify({
    model: options.modelId,
    effort: options.effort,
    system: SYSTEM_PROMPT,
    schema: outputSchema(),
  });
  return createHash('sha256').update(inputs).digest('hex').slice(0, 16);
}

/** Waits `ms`, or rejects as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ProviderError('aborted', 'the request was cancelled'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new ProviderError('aborted', 'the request was cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Maps a thrown error onto a code. Typed errors only: a provider's error
 * wording is not an interface.
 */
export function classify(error: unknown): AnalystError {
  if (error instanceof AnalystError) return error;
  if (error instanceof MalformedAnalysisError) return new AnalystError('failed', error.message);
  if (error instanceof ProviderError) return classifyProvider(error);
  console.error('[analyst] unexpected failure:', errorMessage(error));
  return new AnalystError('failed', 'the analysis could not be written');
}

/** A provider failure, by kind. A credentials problem is the operator's, not the player's. */
function classifyProvider(error: ProviderError): AnalystError {
  switch (error.kind) {
    case 'aborted':
      return new AnalystError('failed', 'the analysis was cancelled');
    case 'timeout':
      return new AnalystError('timeout', 'the model took too long to answer');
    case 'auth':
      console.error('[analyst] the model provider rejected our credentials:', error.message);
      return new AnalystError('unavailable', 'match analysis is not available on this server');
    case 'limited':
      console.error('[analyst] the model provider rate-limited us:', error.message);
      return new AnalystError('busy', 'the analyst has hit its rate limit; try again in a few minutes');
    case 'busy':
      return new AnalystError('busy', 'the analyst is busy; try again in a minute');
    case 'unreachable':
      return new AnalystError('busy', 'could not reach the model provider; try again in a minute');
    default:
      console.error('[analyst] model request failed:', error.status, error.message);
      return new AnalystError('failed', 'the analysis could not be written');
  }
}
