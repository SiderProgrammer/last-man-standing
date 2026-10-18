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
import type { MatchArchive } from '../lobby/store.js';
import type { StyleBook } from '../lobby/styles.js';
import type { AnalystModel, ModelReply, ModelRequest } from './model.js';
import { SYSTEM_PROMPT, renderRequest, type SeatedMatch } from './prompt.js';
import { AnalysisOutput, MalformedAnalysisError, parseAnalysisOutput } from './schema.js';
import { JsonFieldStream } from './stream.js';
import { MatchTools, TOOLS } from './tools.js';
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
  constructor(private readonly options: AnalystOptions) {}

  /** Every failure comes out as an `AnalystError`, so callers have one thing to catch. */
  async analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
    try {
      return await this.write(request);
    } catch (error) {
      throw classify(error);
    }
  }

  private async write(request: AnalyzeRequest): Promise<AnalyzeResult> {
    const started = this.now();
    const match = await this.options.archive.load(request.matchId);
    if (!match) throw new AnalystError('not_found', 'no finished match with that id');
    if (!match.seats) {
      throw new AnalystError('not_found', 'this match was archived before seating was recorded, so it cannot be analysed');
    }
    const seated: SeatedMatch = { ...match, seats: match.seats };
    const seat = seated.seats.find((entry) => addressKey(entry.address) === addressKey(request.requester))?.index ?? null;

    const tools = new MatchTools(seated, seat, this.options.styles);
    const messages: BetaMessageParam[] = [{ role: 'user', content: renderRequest(seated, seat) }];
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
      reply = await this.call(this.request(messages, final), onText, request.signal);
      addUsage(usage, reply.usage);
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
        `output ${usage.outputTokens}; ${kept.length} moments kept, ${dropped.length} dropped`,
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
  private async call(request: ModelRequest, onText: (delta: string) => void, signal?: AbortSignal): Promise<ModelReply> {
    const reply = await this.options.model.stream(request, onText, signal ?? new AbortController().signal);
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
      latencyMs: 0,
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function addUsage(total: AnalysisUsage, turn: BetaUsage): void {
  total.turns += 1;
  total.inputTokens += turn.input_tokens;
  total.outputTokens += turn.output_tokens;
  total.cacheReadTokens += turn.cache_read_input_tokens ?? 0;
  total.cacheWriteTokens += turn.cache_creation_input_tokens ?? 0;
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
