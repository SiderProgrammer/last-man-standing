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
  /** Per attempt, in milliseconds. A timed-out attempt is retried like a 5xx. */
  timeoutMs: number;
  /** Retries on 429/5xx and dropped connections, only while nothing has streamed yet. */
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
 * becomes a `streamGenerateContent` call, and the streamed reply comes back
 * in the analyst's own format, so the tool loop, the schema check, the claim
 * verifier and the usage accounting know nothing about Gemini.
 *
 * - Mid-conversation `system` messages have no Gemini equivalent. They join
 *   the system instruction instead, which keeps them in the operator's voice
 *   rather than turning them into text a player could imitate.
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
    async stream(request, onText, signal) {
      const url = `${baseUrl}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`;
      const body = JSON.stringify(toGeminiRequest(request));
      for (let attempt = 0; ; attempt++) {
        const reply = new ReplyBuilder(request.model);
        try {
          const timeout = AbortSignal.timeout(options.timeoutMs);
          const response = await doFetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
            body,
            signal: AbortSignal.any([signal, timeout]),
          }).catch((error: unknown) => {
            throw connectionError(error, signal, timeout);
          });
          if (!response.ok) throw await httpError(response);
          if (!response.body) throw new ProviderError('failed', 'Gemini returned an empty response');
          await readEvents(response.body, (event) => reply.add(event, onText)).catch((error: unknown) => {
            throw connectionError(error, signal, timeout);
          });
          return reply.finish();
        } catch (error) {
          // Once text has reached the player, a retry would repeat it.
          const retryable = error instanceof ProviderError && error.retryable && !reply.streamed;
          if (!retryable || attempt >= options.maxRetries || signal.aborted) throw error;
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
  systemInstruction?: { parts: Array<{ text: string }> };
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
  const system = systemTexts(request);
  const contents = toContents(request.messages);
  const declarations = request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.input_schema,
  }));

  return {
    ...(system.length ? { systemInstruction: { parts: system.map((text) => ({ text })) } } : {}),
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

/** The system prompt, then each distinct mid-conversation system message, in order. */
function systemTexts(request: ModelRequest): string[] {
  const texts: string[] = [];
  const add = (text: string) => {
    if (text && !texts.includes(text)) texts.push(text);
  };
  add(request.system);
  for (const message of request.messages) {
    if (message.role === 'system') add(textOf(message.content));
  }
  return texts;
}

function toContents(messages: readonly Message[]): GeminiContent[] {
  // Tool results name their call only by id; Gemini wants the function's name.
  const names = new Map<string, string>();
  const contents: GeminiContent[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts = toParts(message.content, names);
    if (parts.length === 0) continue;
    // Consecutive turns from one side merge, as they would once a system message is lifted out.
    const last = contents[contents.length - 1];
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
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

function textOf(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

// ---------------------------------------------------------------- response

interface GeminiEvent {
  responseId?: string;
  modelVersion?: string;
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

/** Folds streamed events into one model turn. */
class ReplyBuilder {
  /** True once any text has gone to `onText`. */
  streamed = false;
  private readonly content: ContentBlock[] = [];
  private id = '';
  private finishReason = '';
  private blocked = false;
  private usage: GeminiEvent['usageMetadata'] = {};
  private calls = 0;

  constructor(private readonly model: string) {}

  add(event: GeminiEvent, onText: (delta: string) => void): void {
    if (event.responseId) this.id = event.responseId;
    if (event.usageMetadata) this.usage = event.usageMetadata;
    if (event.promptFeedback?.blockReason) this.blocked = true;
    const candidate = event.candidates?.[0];
    if (candidate?.finishReason) this.finishReason = candidate.finishReason;
    for (const part of candidate?.content?.parts ?? []) {
      // Thought summaries are only sent when asked for, and never shown.
      if (part.thought) {
        if (part.thoughtSignature) this.sign(part.thoughtSignature);
        continue;
      }
      if (part.thoughtSignature) this.sign(part.thoughtSignature);
      if (part.functionCall) {
        this.calls++;
        this.content.push({
          type: 'tool_use',
          id: part.functionCall.id || `gemini_call_${this.calls}`,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
        });
      } else if (typeof part.text === 'string' && part.text) {
        const last = this.content[this.content.length - 1];
        if (last?.type === 'text') last.text += part.text;
        else this.content.push({ type: 'text', text: part.text });
        this.streamed = true;
        onText(part.text);
      }
    }
  }

  finish(): ModelReply {
    const usage = this.usage ?? {};
    const cached = usage.cachedContentTokenCount ?? 0;
    return {
      id: this.id || `gemini_${Date.now()}`,
      // The requested id, not `modelVersion`, so pricing and the cache key match it.
      model: this.model,
      content: this.content,
      stop_reason: this.stopReason(),
      usage: {
        input_tokens: Math.max(0, (usage.promptTokenCount ?? 0) - cached) + (usage.toolUsePromptTokenCount ?? 0),
        output_tokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
        cache_read_input_tokens: cached,
      },
    };
  }

  /** A signature belongs to the part it arrived on: mark the spot just before it. */
  private sign(signature: string): void {
    this.content.push({ type: 'signature', signature });
  }

  private stopReason(): StopReason {
    if (this.blocked) return 'refusal';
    if (this.content.some((block) => block.type === 'tool_use')) return 'tool_use';
    switch (this.finishReason) {
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
        return (this.finishReason || 'no finish reason').toLowerCase();
    }
  }
}

/** Parses a server-sent-event body, one JSON object per `data:` event. */
async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: GeminiEvent) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    let event: GeminiEvent;
    try {
      event = JSON.parse(data) as GeminiEvent;
    } catch {
      throw new ProviderError('failed', 'Gemini sent an unreadable stream event');
    }
    onEvent(event);
  };
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      flush(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary[0].length);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) flush(buffer);
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
  if (response.status === 429 || response.status >= 500) return new ProviderError('busy', message, response.status);
  return new ProviderError('failed', message, response.status);
}

/** What a failed fetch or read means: cancelled by the caller, out of time, or a dropped connection. */
function connectionError(error: unknown, signal: AbortSignal, timeout: AbortSignal): unknown {
  if (error instanceof ProviderError) return error;
  if (signal.aborted) return new ProviderError('aborted', 'the request was cancelled');
  if (timeout.aborted) return new ProviderError('timeout', 'Gemini took too long to answer');
  return new ProviderError('unreachable', `could not reach Gemini: ${error instanceof Error ? error.message : String(error)}`);
}
