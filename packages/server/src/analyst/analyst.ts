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
import {
  ProviderError,
  type AnalystModel,
  type Effort,
  type Message,
  type ModelReply,
  type ModelRequest,
  type ToolResultBlock,
  type ToolUseBlock,
} from './model.js';
import { SYSTEM_PROMPT, renderRequest } from './prompt.js';
import { MalformedAnalysisError, outputSchema, parseAnalysisOutput } from './schema.js';
import { MatchTools, TOOLS } from './tools.js';
import type { AnalystLimits } from './limits.js';
import { turnCost } from './pricing.js';
import { checkDecisiveRound, verifyMoments } from './verify.js';

export type { Effort };

export interface AnalystOptions {
  archive: MatchArchive;
  model: AnalystModel;
  /** Model id, e.g. `gemini-3.8-flash`. */
  modelId: string;
  effort: Effort;
  /** Output ceiling per model turn, thinking included. */
  maxTokens: number;
  /** Earlier play styles by wallet, for `get_player_history`. Omitted, nobody has a record. */
  styles?: StyleBook;
  /**
   * Model turns per analysis, tool turns included. The last one is sent with
   * tools switched off, so a model that keeps asking still has to answer. The
   * first message already holds the whole match, so 1 — a single call, no
   * lookups — is enough and is what the server runs with; more lets the
   * model look things up again. Defaults to 4 here.
   */
  maxTurns?: number;
  /**
   * Wall-clock ceiling on one analysis, every turn and retry included, in
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

const DEFAULT_MAX_TURNS = 4;
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
 * The tool loop is written out by hand, and the model is injected, so the
 * network is never the analyst's concern; owning the loop also puts the
 * per-turn stop-reason checks, the turn cap and the usage accounting in one
 * readable place.
 *
 * Prompt layout, for the provider's implicit prefix cache: the frozen system
 * prompt and the tools — identical bytes on every request from every player —
 * then the per-match messages, which only ever grow at the end as the tool
 * loop runs.
 */
export class Analyst implements MatchAnalyst {
  /**
   * Digest of everything that shapes an answer. Cached analyses are keyed by
   * it, so a new prompt, tool, schema, model or effort level never serves an
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
    const ticket = this.options.limits?.admit(wallet, this.now(), this.maxTurns());
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
    const usage = this.emptyUsage();
    const tools = new MatchTools(match, seat, this.options.styles);
    const opening = renderRequest(match, seat, await tools.briefing());
    const reply = await this.withDeadline(request.signal, (signal) =>
      this.converse([{ role: 'user', content: opening }], {
        tools,
        usage,
        signal,
        step: (text) => request.onStep?.(text),
      }),
    );

    request.onStep?.('Checking the key moments against the rounds');
    const output = parseAnalysisOutput(finalText(reply));
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

  /**
   * The tool loop: sends the conversation, runs the tools the model asks
   * for, and repeats until it answers. Appends to `messages` and `usage`.
   */
  private async converse(
    messages: Message[],
    turn: { tools: MatchTools; usage: AnalysisUsage; signal: AbortSignal; step: (text: string) => void },
  ): Promise<ModelReply> {
    const maxTurns = this.maxTurns();
    for (;;) {
      const final = turn.usage.turns + 1 >= maxTurns;
      const doing =
        turn.usage.turns === 0
          ? 'Gemini is reading the whole match and writing the analysis'
          : final
            ? 'Writing the analysis'
            : 'Thinking over what it found';
      const reply = await this.call(this.request(messages, final), turn.signal, doing, turn.step);
      addUsage(turn.usage, reply);
      if (reply.stop_reason !== 'tool_use') return reply;

      const calls = reply.content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
      if (calls.length === 0) throw new AnalystError('failed', 'the model asked for a tool but named none');
      turn.usage.toolCalls += calls.length;
      // Echoed back whole: signatures included, which the next turn needs.
      messages.push({ role: 'assistant', content: reply.content });
      // Every result goes back in one message, in call order.
      const results = await Promise.all(
        calls.map(async (call): Promise<ToolResultBlock> => {
          turn.step(describeCall(call));
          const output = await turn.tools.run(call.name, call.input);
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
  }

  /**
   * One turn's request. Everything above `messages` is the same bytes for
   * every analysis of every match, which is what lets them share a cache.
   *
   * @param final Switches tools off, so the model has to answer now.
   */
  private request(messages: readonly Message[], final: boolean): ModelRequest {
    return {
      model: this.options.modelId,
      max_tokens: this.options.maxTokens,
      effort: this.options.effort,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      ...(final ? { tool_choice: 'none' as const } : {}),
      output_schema: outputSchema(),
      // A copy: the loop keeps appending to its own array.
      messages: [...messages],
    };
  }

  /**
   * One model turn, once the provider's rate limits allow it. A finished
   * answer or a request for tools continues; anything else ends the analysis.
   *
   * @param doing What to tell the asker the model is doing on this turn.
   */
  private async call(
    request: ModelRequest,
    signal: AbortSignal,
    doing: string,
    step: (text: string) => void,
  ): Promise<ModelReply> {
    const slot = this.options.limits?.reserve(this.now());
    if (slot && 'code' in slot) throw new AnalystError(slot.code, slot.message);
    if (slot && slot.waitMs > 0) {
      step(`Waiting for a free Gemini slot, about ${Math.ceil(slot.waitMs / 1000)}s (free-tier rate limit)`);
      await (this.options.sleep ?? sleep)(slot.waitMs, signal);
    }

    step(doing);
    const started = this.now();
    const reply = await this.options.model.generate(request, signal);
    console.info(`[analyst] model turn: ${reply.stop_reason} after ${this.now() - started} ms`);
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

  private maxTurns(): number {
    return Math.max(1, this.options.maxTurns ?? DEFAULT_MAX_TURNS);
  }

  private emptyUsage(): AnalysisUsage {
    return {
      model: this.options.modelId,
      turns: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      latencyMs: 0,
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function addUsage(total: AnalysisUsage, reply: Pick<ModelReply, 'model' | 'usage'>): void {
  const turn = reply.usage;
  total.turns += 1;
  total.inputTokens += turn.input_tokens;
  total.outputTokens += turn.output_tokens;
  total.cacheReadTokens += turn.cache_read_input_tokens ?? 0;
  // Priced by the model that served the turn.
  const cost = turnCost(reply.model, turn);
  total.costUsd = cost === null || total.costUsd === null ? null : total.costUsd + cost;
}

/** One line of usage for the log. */
function describeUsage(usage: AnalysisUsage): string {
  return (
    `${usage.turns} turns, ${usage.toolCalls} tool calls, ${usage.latencyMs} ms; ` +
    `input ${usage.inputTokens} + cache read ${usage.cacheReadTokens}, ` +
    `output ${usage.outputTokens}; ~$${usage.costUsd?.toFixed(4) ?? '?'}`
  );
}

/** See `Analyst.version`. */
function analysisVersion(options: AnalystOptions): string {
  const inputs = JSON.stringify({
    model: options.modelId,
    effort: options.effort,
    maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    schema: outputSchema(),
  });
  return createHash('sha256').update(inputs).digest('hex').slice(0, 16);
}

/** A tool call as a progress line for the asker. The input is model output, so only numbers are echoed. */
export function describeCall(call: Pick<ToolUseBlock, 'name' | 'input'>): string {
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

/** The answer text: every text block of the final turn, in order. */
function finalText(reply: ModelReply): string {
  return reply.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
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
