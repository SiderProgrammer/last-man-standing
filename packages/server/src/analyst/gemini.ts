import {
  ProviderError,
  type AnalystModel,
  type ContentBlock,
  type Effort,
  type Message,
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
 * becomes a `generateContent` call, and the reply comes back in the
 * analyst's own format, so the tool loop, the schema check, the claim
 * verifier and the usage accounting know nothing about Gemini.
 *
 * - Prompt caching is Gemini's implicit kind; cached tokens come back as
 *   cache reads.
 * - Thought signatures — opaque tokens Gemini 3 requires back on the part
 *   that carried them, function calls above all — travel as a `signature`
 *   block placed just before that part. The analyst echoes assistant turns
 *   whole, so they come back without it knowing.
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

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiRequest {
  systemInstruction: { parts: Array<{ text: string }> };
  contents: GeminiContent[];
  tools?: Array<{ functionDeclarations: Array<{ name: string; description?: string; parametersJsonSchema?: unknown }> }>;
  toolConfig?: { functionCallingConfig: { mode: 'AUTO' | 'NONE' } };
  generationConfig: {
    maxOutputTokens: number;
    thinkingConfig?: { thinkingLevel: 'low' | 'medium' | 'high' };
    responseMimeType?: 'application/json';
    responseJsonSchema?: unknown;
  };
}

/** The analyst's request, as a `generateContent` body. Exported for tests. */
export function toGeminiRequest(request: ModelRequest): GeminiRequest {
  const contents = toContents(request.messages);
  const declarations = request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.input_schema,
  }));

  return {
    systemInstruction: { parts: [{ text: request.system }] },
    contents,
    ...(declarations.length
      ? {
          tools: [{ functionDeclarations: declarations }],
          toolConfig: { functionCallingConfig: { mode: request.tool_choice === 'none' ? 'NONE' : 'AUTO' } },
        }
      : {}),
    generationConfig: {
      maxOutputTokens: request.max_tokens,
      thinkingConfig: { thinkingLevel: thinkingLevel(request.effort) },
      ...(request.output_schema ? { responseMimeType: 'application/json', responseJsonSchema: request.output_schema } : {}),
    },
  };
}

/** Gemini 3 thinks at low, medium or high; the higher effort levels all mean "high". */
function thinkingLevel(effort: Effort): 'low' | 'medium' | 'high' {
  if (effort === 'low') return 'low';
  if (effort === 'medium') return 'medium';
  return 'high';
}

function toContents(messages: readonly Message[]): GeminiContent[] {
  // Tool results name their call only by id; Gemini wants the function's name.
  const names = new Map<string, string>();
  const contents: GeminiContent[] = [];
  for (const message of messages) {
    const parts = toParts(message.content, names);
    if (parts.length > 0) contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  return contents;
}

function toParts(content: Message['content'], names: Map<string, string>): GeminiPart[] {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  const parts: GeminiPart[] = [];
  let signature: string | undefined;
  const push = (part: GeminiPart) => {
    parts.push(signature ? { ...part, thoughtSignature: signature } : part);
    signature = undefined;
  };
  for (const block of content) {
    switch (block.type) {
      case 'signature':
        signature = block.signature;
        break;
      case 'text':
        push({ text: block.text });
        break;
      case 'tool_use':
        names.set(block.id, block.name);
        push({ functionCall: { id: block.id, name: block.name, args: (block.input ?? {}) as Record<string, unknown> } });
        break;
      case 'tool_result':
        push({
          functionResponse: {
            id: block.tool_use_id,
            name: names.get(block.tool_use_id) ?? 'unknown_tool',
            response: block.is_error ? { error: block.content } : { output: block.content },
          },
        });
        break;
    }
  }
  return parts;
}

// ---------------------------------------------------------------- response

interface GeminiResponse {
  responseId?: string;
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    toolUsePromptTokenCount?: number;
  };
}

/** A `generateContent` response as one model turn. Exported for tests. */
export function fromGeminiResponse(model: string, response: GeminiResponse): ModelReply {
  const content: ContentBlock[] = [];
  const candidate = response.candidates?.[0];
  let calls = 0;
  for (const part of candidate?.content?.parts ?? []) {
    // A signature belongs to the part it arrived on: mark the spot just before it.
    if (part.thoughtSignature) content.push({ type: 'signature', signature: part.thoughtSignature });
    // Thought summaries are only sent when asked for, and never shown.
    if (part.thought) continue;
    if (part.functionCall) {
      calls++;
      content.push({
        type: 'tool_use',
        id: part.functionCall.id || `gemini_call_${calls}`,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      });
    } else if (typeof part.text === 'string' && part.text) {
      const last = content[content.length - 1];
      if (last?.type === 'text') last.text += part.text;
      else content.push({ type: 'text', text: part.text });
    }
  }

  const usage = response.usageMetadata ?? {};
  const cached = usage.cachedContentTokenCount ?? 0;
  return {
    id: response.responseId || `gemini_${Date.now()}`,
    // The requested id, not `modelVersion`, so pricing and the cache key match it.
    model,
    content,
    stop_reason: stopReason(response, content),
    usage: {
      input_tokens: Math.max(0, (usage.promptTokenCount ?? 0) - cached) + (usage.toolUsePromptTokenCount ?? 0),
      output_tokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      cache_read_input_tokens: cached,
    },
  };
}

function stopReason(response: GeminiResponse, content: readonly ContentBlock[]): StopReason {
  if (response.promptFeedback?.blockReason) return 'refusal';
  if (content.some((block) => block.type === 'tool_use')) return 'tool_use';
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
