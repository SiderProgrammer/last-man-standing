import {
  ProviderError,
  type AnalystModel,
  type Effort,
  type ModelReply,
  type ModelRequest,
  type StopReason,
} from './model.js';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiModelOptions {
  apiKey: string;
  /** Per attempt, in milliseconds. A timed-out attempt is not retried: Gemini already counted it. */
  timeoutMs: number;
  /** Retries on 5xx and dropped connections. Never a 429 (the quota talking) or a timeout. */
  maxRetries: number;
  baseUrl?: string;
  /** Injected by tests; the global `fetch` otherwise. */
  fetch?: typeof fetch;
  /** Waits between retries. Injected by tests so they do not sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Gemini behind the analyst's `AnalystModel` interface, over the REST API.
 *
 * A translator at that boundary, in both directions: the analyst's request
 * becomes one `generateContent` call with the answer constrained to the
 * output schema, and the reply comes back in the analyst's own format, so the
 * schema check, the claim verifier and the usage accounting know nothing
 * about Gemini. Prompt caching is Gemini's implicit kind; cached tokens come
 * back as cache reads.
 */
export function geminiModel(options: GeminiModelOptions): AnalystModel {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const baseUrl = (options.baseUrl || GEMINI_BASE_URL).replace(/\/+$/, '');

  return {
    async generate(request, signal) {
      const url = `${baseUrl}/models/${encodeURIComponent(request.model)}:generateContent`;
      const body = JSON.stringify(toGeminiRequest(request));
      for (let attempt = 0; ; attempt++) {
        const timeout = AbortSignal.timeout(options.timeoutMs);
        try {
          const response = await doFetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
            body,
            signal: AbortSignal.any([signal, timeout]),
          });
          if (!response.ok) throw await httpError(response);
          return fromGeminiResponse(request.model, (await response.json()) as GeminiResponse);
        } catch (error) {
          const failure = connectionError(error, signal, timeout);
          if (!(failure instanceof ProviderError) || !failure.retryable || attempt >= options.maxRetries || signal.aborted) {
            throw failure;
          }
          await sleep(500 * 2 ** attempt);
        }
      }
    },
  };
}

// ---------------------------------------------------------------- request

export interface GeminiRequest {
  systemInstruction: { parts: Array<{ text: string }> };
  contents: Array<{ role: 'user'; parts: Array<{ text: string }> }>;
  generationConfig: {
    maxOutputTokens: number;
    thinkingConfig: { thinkingLevel: 'low' | 'medium' | 'high' };
    responseMimeType: 'application/json';
    responseJsonSchema: unknown;
  };
}

/** The analyst's request, as a `generateContent` body. Exported for tests. */
export function toGeminiRequest(request: ModelRequest): GeminiRequest {
  return {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
    generationConfig: {
      maxOutputTokens: request.max_tokens,
      thinkingConfig: { thinkingLevel: thinkingLevel(request.effort) },
      responseMimeType: 'application/json',
      responseJsonSchema: request.output_schema,
    },
  };
}

/** Gemini 3 thinks at low, medium or high; the higher effort levels all mean "high". */
function thinkingLevel(effort: Effort): 'low' | 'medium' | 'high' {
  if (effort === 'low') return 'low';
  if (effort === 'medium') return 'medium';
  return 'high';
}

// ---------------------------------------------------------------- response

interface GeminiResponse {
  responseId?: string;
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

/** A `generateContent` response as the analyst's reply. Exported for tests. */
export function fromGeminiResponse(model: string, response: GeminiResponse): ModelReply {
  // Thought summaries are only sent when asked for, and never shown.
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((part) => (part.thought || typeof part.text !== 'string' ? '' : part.text)).join('');

  const usage = response.usageMetadata ?? {};
  const cached = usage.cachedContentTokenCount ?? 0;
  return {
    id: response.responseId || `gemini_${Date.now()}`,
    // The requested id, not `modelVersion`, so pricing and the cache key match it.
    model,
    text,
    stop_reason: stopReason(response),
    usage: {
      input_tokens: Math.max(0, (usage.promptTokenCount ?? 0) - cached),
      output_tokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      cache_read_input_tokens: cached,
    },
  };
}

function stopReason(response: GeminiResponse): StopReason {
  if (response.promptFeedback?.blockReason) return 'refusal';
  const finish = response.candidates?.[0]?.finishReason ?? '';
  switch (finish) {
    case 'STOP':
      return 'end_turn';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return 'refusal';
    default:
      // Ends the analysis with the provider's own reason in the message.
      return (finish || 'no finish reason').toLowerCase();
  }
}

async function httpError(response: Response): Promise<ProviderError> {
  let detail = '';
  try {
    const parsed = (await response.json()) as { error?: { message?: string } };
    detail = parsed.error?.message ?? '';
  } catch {
    // The status says enough.
  }
  const message = `Gemini answered ${response.status}${detail ? `: ${detail}` : ''}`;
  if (response.status === 401 || response.status === 403) return new ProviderError('auth', message, response.status);
  if (response.status === 429) return new ProviderError('limited', message, response.status);
  if (response.status >= 500) return new ProviderError('busy', message, response.status);
  return new ProviderError('failed', message, response.status);
}

/** What a failed call means: cancelled by the caller, out of time, or a dropped connection. */
function connectionError(error: unknown, signal: AbortSignal, timeout: AbortSignal): unknown {
  if (error instanceof ProviderError) return error;
  if (signal.aborted) return new ProviderError('aborted', 'the request was cancelled');
  if (timeout.aborted) return new ProviderError('timeout', 'Gemini took too long to answer');
  return new ProviderError('unreachable', `could not reach Gemini: ${error instanceof Error ? error.message : String(error)}`);
}
