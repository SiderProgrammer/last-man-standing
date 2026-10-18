import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type {
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  addressKey,
  errorMessage,
  type AnalysisErrorCode,
  type KeyMoment,
  type MatchAnalysis,
} from '@lms/protocol';
import type { ArchivedMatch, MatchArchive } from '../lobby/store.js';
import type { StyleBook } from '../lobby/styles.js';
import type { AnalystModel, ModelReply, ModelRequest } from './model.js';
import { SYSTEM_PROMPT, renderRequest, type SeatedMatch } from './prompt.js';
import { AnalysisOutput, MalformedAnalysisError, parseAnalysisOutput } from './schema.js';
import { JsonFieldStream } from './stream.js';
import { MatchTools, TOOLS } from './tools.js';
import type { AnalystLimits } from './limits.js';
import { AnalystMetrics } from './metrics.js';
import { turnCost } from './pricing.js';
import { checkDecisiveRound, verifyMoments } from './verify.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnalystOptions {
  archive: MatchArchive;
  model: AnalystModel;
  /** Model id, e.g. `claude-opus-5-5`. */
  modelId: string;
  effort: Effort;
  /** Output ceiling per model turn, thinking included. */
  maxTokens: number;
  /** Earlier play styles by wallet, for `get_player_history`. Omitted, nobody has a record. */
  styles?: StyleBook;
  /**
   * Model turns per analysis, tool turns included. The last one is sent with
   * tools switched off, so a model that keeps asking still has to answer.
   * Defaults to 6.
   */
  maxTurns?: number;
  /**
   * Wall-clock ceiling on one analysis, every turn and retry included, in
   * milliseconds. The SDK's own timeout is per attempt; this bounds the
   * whole thing. Defaults to three minutes.
   */
  deadlineMs?: number;
  /** Quotas, concurrency and the daily budget. Omitted, nothing is limited. */
  limits?: AnalystLimits;
  /** Where counters go. Omitted, the analyst keeps its own. */
  metrics?: AnalystMetrics;
  /** Wall clock in milliseconds, injectable for tests. */
  now?: () => number;
}

export interface AnalyzeRequest {
  matchId: `0x${string}`;
  /** The authenticated wallet asking. Decides whose seat the advice is for. */
  requester: `0x${string}`;
  /** Each new fragment of the narrative, as it is written. */
  onDelta?: (text: string) => void;
  /** A short line saying what the analyst is looking at, e.g. "Reading round 4". */
  onStep?: (step: string) => void;
  /** Aborts the model call: the asker went away. */
  signal?: AbortSignal;
}

/** What one analysis cost. Summed over every model turn it took. */
export interface AnalysisUsage {
  model: string;
  turns: number;
  toolCalls: number;
  /** Input tokens billed at the full rate: everything after the last cache hit. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the prompt cache, at a small fraction of the rate. */
  cacheReadTokens: number;
  /** Input tokens written to the prompt cache, at a premium over the full rate. */
  cacheWriteTokens: number;
  /** Estimate at list prices; null if a turn ran on a model with no listed price. */
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

/**
 * Server-side refusal fallback: if the model declines, the API retries on the
 * model Anthropic recommends for that refusal category, inside the same call.
 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const DEFAULT_MAX_TURNS = 6;
const DEFAULT_DEADLINE_MS = 180_000;

/**
 * Writes post-match analyses with Claude.
 *
 * Strictly a reader. It sees a match only once the archive has it, which is
 * after the result was computed, signed and submitted; nothing it produces
 * flows back into a room, the engine, the history hash or settlement. The
 * worst a wrong analysis can do is be wrong, and the claim verifier keeps
 * even that to the prose.
 *
 * The tool loop is written out by hand rather than handed to the SDK's tool
 * runner. The runner drives the network itself, and the analyst's model is
 * injected precisely so that it does not; owning the loop also puts the
 * per-turn stop-reason checks, the turn cap and the usage accounting in one
 * readable place.
 *
 * Prompt layout, for the cache: tools, then the frozen system prompt with an
 * explicit breakpoint — identical bytes on every request from every player —
 * then the per-match messages, which top-level automatic caching covers turn
 * by turn as the tool loop grows them.
 */
export class Analyst implements MatchAnalyst {
  readonly metrics: AnalystMetrics;
  /**
   * Digest of everything that shapes an answer. Cached analyses are keyed by
   * it, so a new prompt, tool, schema, model or effort level never serves an
   * answer written under the old one.
   */
  readonly version: string;
  /** Analyses being written, by match and seat, so a second asker waits instead of paying twice. */
  private readonly inflight = new Map<string, Promise<AnalyzeResult>>();

  constructor(private readonly options: AnalystOptions) {
    this.metrics = options.metrics ?? new AnalystMetrics();
    this.version = analysisVersion(options);
  }

  /** Every failure comes out as an `AnalystError`, so callers have one thing to catch. */
  async analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
    try {
      return await this.serve(request);
    } catch (error) {
      const failure = classify(error);
      this.metrics.fail(failure.code);
      throw failure;
    }
  }

  /**
   * Who may ask, then the cheapest way to answer: the archive, then an
   * analysis already being written, and only then a model call — which is
   * the one step the limits apply to.
   */
  private async serve(request: AnalyzeRequest): Promise<AnalyzeResult> {
    const match = await this.options.archive.load(request.matchId);
    if (!match) throw new AnalystError('not_found', 'no finished match with that id');
    if (!match.seats) {
      throw new AnalystError('not_found', 'this match was archived before seating was recorded, so it cannot be analysed');
    }
    const seated: SeatedMatch = { ...match, seats: match.seats };
    const seat = seated.seats.find((entry) => addressKey(entry.address) === addressKey(request.requester))?.index ?? null;
    // A staked match was public while it ran; a practice match is the
    // practising player's own, and so is what an analysis of it would say.
    if (seat === null && match.staked !== true) {
      throw new AnalystError('forbidden', 'only the players who sat in this match can analyse it');
    }

    const cached = await this.cached(match, seat);
    if (cached) {
      this.metrics.count('cached');
      return { analysis: cached, cached: true };
    }

    const key = `${match.result.matchId.toLowerCase()}:${seat ?? 'spectator'}`;
    const running = this.inflight.get(key);
    if (running) {
      request.onStep?.('Another request is already writing this analysis');
      const { analysis } = await running;
      this.metrics.count('shared');
      return { analysis, cached: true };
    }

    const ticket = this.options.limits?.admit(request.requester, this.now());
    if (ticket && 'code' in ticket) throw new AnalystError(ticket.code, ticket.message);

    const job = this.write(request, seated, seat);
    this.inflight.set(key, job);
    let refund = false;
    try {
      const result = await job;
      if (result.usage) {
        this.metrics.fresh({ ...result.usage, kept: result.analysis.keyMoments.length, dropped: result.analysis.dropped });
        this.options.limits?.spend(result.usage.costUsd ?? 0, this.now());
      }
      await this.options.archive.saveAnalysis({ analysis: result.analysis, version: this.version }).catch((error: unknown) => {
        console.warn('[analyst] could not cache the analysis:', errorMessage(error));
      });
      return result;
    } catch (error) {
      // The player keeps their allowance when the failure was not theirs:
      // anything but a refusal, unless they cancelled it themselves.
      refund = classify(error).code !== 'refused' && request.signal?.aborted !== true;
      throw error;
    } finally {
      this.inflight.delete(key);
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

  /** One fresh analysis, inside its wall-clock deadline. */
  private async write(request: AnalyzeRequest, match: SeatedMatch, seat: number | null): Promise<AnalyzeResult> {
    const started = this.now();
    const deadline = AbortSignal.timeout(this.options.deadlineMs ?? DEFAULT_DEADLINE_MS);
    const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
    try {
      return await this.loop(request, match, seat, started, signal);
    } catch (error) {
      if (deadline.aborted) throw new AnalystError('timeout', 'the analysis took too long and was stopped');
      throw error;
    }
  }

  private async loop(
    request: AnalyzeRequest,
    match: SeatedMatch,
    seat: number | null,
    started: number,
    signal: AbortSignal,
  ): Promise<AnalyzeResult> {
    const tools = new MatchTools(match, seat, this.options.styles);
    const messages: BetaMessageParam[] = [{ role: 'user', content: renderRequest(match, seat) }];
    const usage = this.emptyUsage();

    // One stream for the whole loop: the narrative is only ever written in
    // the final answer, and a stream that has finished its field stays quiet.
    const narrative = new JsonFieldStream('summary');
    const onText = (delta: string) => {
      const text = narrative.push(delta);
      if (text) request.onDelta?.(text);
    };

    const maxTurns = Math.max(1, this.options.maxTurns ?? DEFAULT_MAX_TURNS);
    let reply: ModelReply;
    for (;;) {
      const final = usage.turns + 1 >= maxTurns;
      reply = await this.call(this.request(messages, final), onText, signal);
      addUsage(usage, reply);
      if (reply.stop_reason !== 'tool_use') break;

      const calls = reply.content.filter((block): block is BetaToolUseBlock => block.type === 'tool_use');
      if (calls.length === 0) throw new AnalystError('failed', 'the model asked for a tool but named none');
      usage.toolCalls += calls.length;
      // Echoed back whole: thinking blocks included, which the next turn needs.
      messages.push({ role: 'assistant', content: reply.content });
      // Every result goes back in one message, in call order.
      const results = await Promise.all(
        calls.map(async (call): Promise<BetaToolResultBlockParam> => {
          request.onStep?.(describeCall(call));
          const output = await tools.run(call.name, call.input);
          return {
            type: 'tool_result',
            tool_use_id: call.id,
            content: output.content,
            ...(output.isError ? { is_error: true } : {}),
          };
        }),
      );
      messages.push({ role: 'user', content: results });
    }

    const output = parseAnalysisOutput(finalText(reply));
    const moments: KeyMoment[] = output.keyMoments.map((moment) => ({ ...moment }));
    const { kept, dropped } = verifyMoments(moments, match.history);
    for (const entry of dropped) {
      console.info(`[analyst] dropped a ${entry.moment.kind} claim on ${request.matchId}: ${entry.reason}`);
    }
    usage.latencyMs = this.now() - started;
    console.info(
      `[analyst] ${request.matchId} for ${seat === null ? 'a spectator' : `seat ${seat}`}: ` +
        `${usage.turns} turns, ${usage.toolCalls} tool calls, ${usage.latencyMs} ms; ` +
        `input ${usage.inputTokens} + cache read ${usage.cacheReadTokens} + cache write ${usage.cacheWriteTokens}, ` +
        `output ${usage.outputTokens}; ~$${usage.costUsd?.toFixed(4) ?? '?'}; ` +
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

  /**
   * One turn's request. Everything above `messages` is the same bytes for
   * every analysis of every match, which is what lets them share a cache.
   *
   * @param final Switches tools off, so the model has to answer now. Costs
   *        the messages cache for this one turn; tools and system stay cached.
   */
  private request(messages: readonly BetaMessageParam[], final: boolean): ModelRequest {
    return {
      model: this.options.modelId,
      max_tokens: this.options.maxTokens,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      output_config: { effort: this.options.effort, format: betaZodOutputFormat(AnalysisOutput) },
      tools: TOOLS,
      ...(final ? { tool_choice: { type: 'none' as const } } : {}),
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      // A copy: the loop keeps appending to its own array.
      messages: [...messages],
    };
  }

  /**
   * One model turn. A finished answer or a request for tools continues;
   * anything else ends the analysis.
   */
  private async call(request: ModelRequest, onText: (delta: string) => void, signal: AbortSignal): Promise<ModelReply> {
    const reply = await this.options.model.stream(request, onText, signal);
    switch (reply.stop_reason) {
      case 'end_turn':
      case 'tool_use':
        return reply;
      case 'refusal':
        // A refusal can cut a tool call off mid-input: never run that turn's tools.
        throw new AnalystError('refused', 'the model declined to analyse this match');
      case 'max_tokens':
        // Covers a tool input cut off at the limit too, which can still parse.
        throw new AnalystError('failed', 'the analysis ran past its length limit');
      default:
        throw new AnalystError('failed', `the model stopped unexpectedly (${reply.stop_reason})`);
    }
  }

  private emptyUsage(): AnalysisUsage {
    return {
      model: this.options.modelId,
      turns: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      latencyMs: 0,
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function addUsage(total: AnalysisUsage, reply: Pick<ModelReply, 'model' | 'usage'>): void {
  const turn: BetaUsage = reply.usage;
  total.turns += 1;
  total.inputTokens += turn.input_tokens;
  total.outputTokens += turn.output_tokens;
  total.cacheReadTokens += turn.cache_read_input_tokens ?? 0;
  total.cacheWriteTokens += turn.cache_creation_input_tokens ?? 0;
  // Priced by the model that served the turn, which a fallback can change.
  const cost = turnCost(reply.model, turn);
  total.costUsd = cost === null || total.costUsd === null ? null : total.costUsd + cost;
}

/** See `Analyst.version`. */
function analysisVersion(options: AnalystOptions): string {
  const inputs = JSON.stringify({
    model: options.modelId,
    effort: options.effort,
    maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    schema: z.toJSONSchema(AnalysisOutput),
  });
  return createHash('sha256').update(inputs).digest('hex').slice(0, 16);
}

/** A tool call as a progress line for the player. The input is model output, so only numbers are echoed. */
export function describeCall(call: Pick<BetaToolUseBlock, 'name' | 'input'>): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const number = (key: string) => (typeof input[key] === 'number' ? String(input[key]) : '?');
  switch (call.name) {
    case 'get_round':
      return `Reading round ${number('round')}`;
    case 'get_reads':
      return `Studying seat #${number('seat')}`;
    case 'get_player_history':
      return `Checking seat #${number('seat')}'s record`;
    case 'get_match':
      return 'Reviewing the match';
    default:
      return 'Looking something up';
  }
}

/** The answer text: every text block of the final turn, in order. */
function finalText(reply: ModelReply): string {
  return reply.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

/**
 * Maps a thrown error onto a code, most specific class first. Typed SDK
 * classes only: a provider's error wording is not an interface.
 */
export function classify(error: unknown): AnalystError {
  if (error instanceof AnalystError) return error;
  if (error instanceof MalformedAnalysisError) return new AnalystError('failed', error.message);
  if (error instanceof Anthropic.APIUserAbortError) return new AnalystError('failed', 'the analysis was cancelled');
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new AnalystError('timeout', 'the model took too long to answer');
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    // The operator's problem, not the player's: say "unavailable", log the detail.
    console.error('[analyst] the model provider rejected our credentials:', error.message);
    return new AnalystError('unavailable', 'match analysis is not available on this server');
  }
  if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError) {
    return new AnalystError('busy', 'the analyst is busy; try again in a minute');
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AnalystError('busy', 'could not reach the model provider; try again in a minute');
  }
  if (error instanceof Anthropic.APIError) {
    console.error('[analyst] model request failed:', error.status, error.message);
    return new AnalystError('failed', 'the analysis could not be written');
  }
  console.error('[analyst] unexpected failure:', errorMessage(error));
  return new AnalystError('failed', 'the analysis could not be written');
}
