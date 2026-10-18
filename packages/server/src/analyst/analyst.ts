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
import {
  SYSTEM_PROMPT,
  renderConversation,
  renderRequest,
  sanitizeQuestion,
  type Exchange,
  type SeatedMatch,
} from './prompt.js';
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

export interface AskRequest {
  matchId: `0x${string}`;
  /** The authenticated wallet asking; its conversation is kept apart from everyone else's. */
  requester: `0x${string}`;
  /** Untrusted text typed by the player. */
  question: string;
  onDelta?: (text: string) => void;
  onStep?: (step: string) => void;
  signal?: AbortSignal;
}

export interface AskResult {
  /** The question as it was put to the model, after sanitising. */
  question: string;
  answer: string;
  model: string;
  usage: AnalysisUsage;
}

/** What the gateway needs from an analyst. An interface so the gateway's tests can fake it. */
export interface MatchAnalyst {
  analyze(request: AnalyzeRequest): Promise<AnalyzeResult>;
  ask(request: AskRequest): Promise<AskResult>;
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

/** Questions one wallet may ask about one match. */
const MAX_QUESTIONS = 20;
/** Earlier exchanges replayed with each question; older ones fall out of the model's view. */
const MAX_HISTORY = 6;
/** Longest answer kept, in characters. The prompt asks for far less. */
const MAX_ANSWER_CHARS = 2_000;

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
  /** Follow-up conversations, by wallet and match. */
  private readonly conversations = new Conversations();

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
    const { match, seat } = await this.authorize(request.matchId, request.requester);

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

    const job = this.paid(request.requester, 'analysis', request.signal, () => this.write(request, match, seat));
    this.inflight.set(key, job);
    try {
      const result = await job;
      if (result.usage) {
        this.metrics.fresh({ ...result.usage, kept: result.analysis.keyMoments.length, dropped: result.analysis.dropped });
      }
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
  private async authorize(matchId: `0x${string}`, requester: `0x${string}`): Promise<{ match: SeatedMatch; seat: number | null }> {
    const match = await this.options.archive.load(matchId);
    if (!match) throw new AnalystError('not_found', 'no finished match with that id');
    if (!match.seats) {
      throw new AnalystError('not_found', 'this match was archived before seating was recorded, so it cannot be analysed');
    }
    const seated: SeatedMatch = { ...match, seats: match.seats };
    const seat = seated.seats.find((entry) => addressKey(entry.address) === addressKey(requester))?.index ?? null;
    if (seat === null && match.staked !== true) {
      throw new AnalystError('forbidden', 'only the players who sat in this match can analyse it');
    }
    return { match: seated, seat };
  }

  /**
   * Runs a paid model job under the limits: claims a slot, records the spend,
   * and hands the allowance back when the failure was not the player's —
   * anything but a refusal, unless they cancelled it themselves.
   */
  private async paid<T extends { usage?: AnalysisUsage }>(
    wallet: `0x${string}`,
    kind: 'analysis' | 'question',
    signal: AbortSignal | undefined,
    job: () => Promise<T>,
  ): Promise<T> {
    const ticket = this.options.limits?.admit(wallet, this.now(), kind);
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
  private async write(request: AnalyzeRequest, match: SeatedMatch, seat: number | null): Promise<AnalyzeResult> {
    const started = this.now();
    const usage = this.emptyUsage();
    // One stream for the whole loop: the narrative is only ever written in
    // the final answer, and a stream that has finished its field stays quiet.
    const narrative = new JsonFieldStream('summary');
    const reply = await this.withDeadline(request.signal, (signal) =>
      this.converse([{ role: 'user', content: renderRequest(match, seat) }], {
        structured: true,
        tools: new MatchTools(match, seat, this.options.styles),
        usage,
        signal,
        onText: (delta) => {
          const text = narrative.push(delta);
          if (text) request.onDelta?.(text);
        },
        ...(request.onStep ? { onStep: request.onStep } : {}),
      }),
    );

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

  /** Every failure comes out as an `AnalystError`, as for `analyze`. */
  async ask(request: AskRequest): Promise<AskResult> {
    try {
      return await this.answer(request);
    } catch (error) {
      const failure = classify(error);
      this.metrics.fail(failure.code);
      throw failure;
    }
  }

  /**
   * A follow-up question about a match the asker already has an analysis
   * of. The conversation lives here, keyed by wallet and match, and only the
   * question comes from the client — so a client cannot forge what the
   * analyst said earlier, and the history it replays is the server's own.
   */
  private async answer(request: AskRequest): Promise<AskResult> {
    const question = sanitizeQuestion(request.question);
    if (question === null) throw new AnalystError('failed', 'the question is empty');
    const { match, seat } = await this.authorize(request.matchId, request.requester);
    const analysis = await this.cached(match, seat);
    if (!analysis) throw new AnalystError('not_found', 'analyse the match before asking about it');

    const key = `${addressKey(request.requester)}:${match.result.matchId.toLowerCase()}`;
    const exchanges = this.conversations.get(key, this.now());
    if (exchanges.length >= MAX_QUESTIONS) {
      throw new AnalystError('quota', `this conversation has reached its ${MAX_QUESTIONS} questions`);
    }

    const result = await this.paid(request.requester, 'question', request.signal, async () => {
      const started = this.now();
      const usage = this.emptyUsage();
      const history = exchanges.slice(-MAX_HISTORY);
      const reply = await this.withDeadline(request.signal, (signal) =>
        this.converse(renderConversation(match, seat, analysis, history, question), {
          structured: false,
          tools: new MatchTools(match, seat, this.options.styles),
          usage,
          signal,
          onText: (delta) => request.onDelta?.(delta),
          ...(request.onStep ? { onStep: request.onStep } : {}),
        }),
      );
      usage.latencyMs = this.now() - started;
      const answer = finalText(reply).trim().slice(0, MAX_ANSWER_CHARS);
      if (!answer) throw new AnalystError('failed', 'the analyst gave an empty answer');
      return { answer, model: reply.model, usage };
    });

    this.conversations.append(key, { question, answer: result.answer }, this.now());
    this.metrics.reply(result.usage);
    console.info(`[analyst] follow-up on ${request.matchId}: ${describeUsage(result.usage)}`);
    return { question, ...result };
  }

  /**
   * The tool loop: sends the conversation, runs the tools the model asks
   * for, and repeats until it answers. Appends to `messages` and `usage`.
   *
   * @param structured Constrains the answer to the analysis schema. Off for
   *        follow-up answers, which are prose.
   */
  private async converse(
    messages: BetaMessageParam[],
    turn: {
      structured: boolean;
      tools: MatchTools;
      usage: AnalysisUsage;
      signal: AbortSignal;
      onText: (delta: string) => void;
      onStep?: (step: string) => void;
    },
  ): Promise<ModelReply> {
    const maxTurns = Math.max(1, this.options.maxTurns ?? DEFAULT_MAX_TURNS);
    for (;;) {
      const final = turn.usage.turns + 1 >= maxTurns;
      const reply = await this.call(this.request(messages, final, turn.structured), turn.onText, turn.signal);
      addUsage(turn.usage, reply);
      if (reply.stop_reason !== 'tool_use') return reply;

      const calls = reply.content.filter((block): block is BetaToolUseBlock => block.type === 'tool_use');
      if (calls.length === 0) throw new AnalystError('failed', 'the model asked for a tool but named none');
      turn.usage.toolCalls += calls.length;
      // Echoed back whole: thinking blocks included, which the next turn needs.
      messages.push({ role: 'assistant', content: reply.content });
      // Every result goes back in one message, in call order.
      const results = await Promise.all(
        calls.map(async (call): Promise<BetaToolResultBlockParam> => {
          turn.onStep?.(describeCall(call));
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
   * @param final Switches tools off, so the model has to answer now. Costs
   *        the messages cache for this one turn; tools and system stay cached.
   */
  private request(messages: readonly BetaMessageParam[], final: boolean, structured: boolean): ModelRequest {
    return {
      model: this.options.modelId,
      max_tokens: this.options.maxTokens,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      output_config: structured
        ? { effort: this.options.effort, format: betaZodOutputFormat(AnalysisOutput) }
        : { effort: this.options.effort },
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

/** One line of usage for the log. */
function describeUsage(usage: AnalysisUsage): string {
  return (
    `${usage.turns} turns, ${usage.toolCalls} tool calls, ${usage.latencyMs} ms; ` +
    `input ${usage.inputTokens} + cache read ${usage.cacheReadTokens} + cache write ${usage.cacheWriteTokens}, ` +
    `output ${usage.outputTokens}; ~$${usage.costUsd?.toFixed(4) ?? '?'}`
  );
}

/**
 * Follow-up conversations in memory, least recently used dropped first and
 * anything idle for an hour forgotten. Losing one costs the player the
 * context of earlier questions, nothing else; the analysis itself is cached
 * in the archive.
 */
class Conversations {
  private readonly entries = new Map<string, { exchanges: Exchange[]; touched: number }>();

  constructor(
    private readonly capacity = 1_000,
    private readonly idleMs = 3_600_000,
  ) {}

  get(key: string, now: number): readonly Exchange[] {
    const entry = this.entries.get(key);
    if (!entry || now - entry.touched > this.idleMs) return [];
    return entry.exchanges;
  }

  append(key: string, exchange: Exchange, now: number): void {
    const exchanges = [...this.get(key, now), exchange];
    // Delete first, so the key moves to the back of the insertion order.
    this.entries.delete(key);
    this.entries.set(key, { exchanges, touched: now });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
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
