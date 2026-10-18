import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  addressKey,
  errorMessage,
  type AnalysisErrorCode,
  type KeyMoment,
  type MatchAnalysis,
} from '@lms/protocol';
import type { MatchArchive } from '../lobby/store.js';
import type { AnalystModel, ModelReply, ModelRequest } from './model.js';
import { SYSTEM_PROMPT, renderRequest } from './prompt.js';
import { AnalysisOutput, MalformedAnalysisError, parseAnalysisOutput } from './schema.js';
import { JsonFieldStream } from './stream.js';
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
}

export interface AnalyzeRequest {
  matchId: `0x${string}`;
  /** The authenticated wallet asking. Decides whose seat the advice is for. */
  requester: `0x${string}`;
  /** Each new fragment of the narrative, as it is written. */
  onDelta?: (text: string) => void;
  /** Aborts the model call: the asker went away. */
  signal?: AbortSignal;
}

export interface AnalyzeResult {
  analysis: MatchAnalysis;
  /** True when served from the analysis cache rather than written now. */
  cached: boolean;
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

/**
 * Writes post-match analyses with Claude.
 *
 * Strictly a reader. It sees a match only once the archive has it, which is
 * after the result was computed, signed and submitted; nothing it produces
 * flows back into a room, the engine, the history hash or settlement. The
 * worst a wrong analysis can do is be wrong, and the claim verifier keeps
 * even that to the prose.
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
    const match = await this.options.archive.load(request.matchId);
    if (!match) throw new AnalystError('not_found', 'no finished match with that id');

    const seat =
      match.seats?.find((entry) => addressKey(entry.address) === addressKey(request.requester))?.index ?? null;

    const narrative = new JsonFieldStream('summary');
    const reply = await this.call(
      {
        model: this.options.modelId,
        max_tokens: this.options.maxTokens,
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        output_config: { effort: this.options.effort, format: betaZodOutputFormat(AnalysisOutput) },
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: renderRequest(match, seat) }],
      },
      (delta) => {
        const text = narrative.push(delta);
        if (text) request.onDelta?.(text);
      },
      request.signal,
    );

    const output = parseAnalysisOutput(finalText(reply));
    const moments: KeyMoment[] = output.keyMoments.map((moment) => ({ ...moment }));
    const { kept, dropped } = verifyMoments(moments, match.history);
    for (const entry of dropped) {
      console.info(`[analyst] dropped a ${entry.moment.kind} claim on ${request.matchId}: ${entry.reason}`);
    }

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
    };
  }

  /** One model turn; a stop for any reason but a finished answer is an error. */
  private async call(request: ModelRequest, onText: (delta: string) => void, signal?: AbortSignal): Promise<ModelReply> {
    const reply = await this.options.model.stream(request, onText, signal ?? new AbortController().signal);
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
