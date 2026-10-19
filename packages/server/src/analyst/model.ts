/**
 * The analyst's own conversation format: provider-neutral, and exactly as
 * much of one as the tool loop needs. A model implementation translates it
 * to its provider's wire format and back (`gemini.ts`, `demo.ts`).
 */

export interface TextBlock {
  type: 'text';
  text: string;
}

/**
 * An opaque token the provider needs back on the part that follows it —
 * Gemini's thought signatures. Never shown, never interpreted, echoed whole.
 */
export interface SignatureBlock {
  type: 'signature';
  signature: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** What a model turn can contain. */
export type ContentBlock = TextBlock | SignatureBlock | ToolUseBlock;

export interface Message {
  /** `system` is the operator speaking mid-conversation, never a player. */
  role: 'user' | 'assistant' | 'system';
  content: string | Array<ContentBlock | ToolResultBlock>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the input object. */
  input_schema: Record<string, unknown>;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelRequest {
  model: string;
  max_tokens: number;
  effort: Effort;
  system: string;
  tools: ToolDefinition[];
  /** `none` forbids tool calls this turn, so the model has to answer. */
  tool_choice?: 'auto' | 'none';
  /** JSON Schema the answer is constrained to; absent for prose. */
  output_schema?: Record<string, unknown>;
  messages: Message[];
}

export interface Usage {
  /** Uncached input. */
  input_tokens: number;
  /** Output, thinking included. */
  output_tokens: number;
  cache_read_input_tokens: number;
}

/**
 * Why a turn ended. Anything outside the four the analyst knows ends the
 * analysis, with the provider's own reason in the message.
 */
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | (string & {});

/** One finished model turn. */
export interface ModelReply {
  id: string;
  model: string;
  content: ContentBlock[];
  stop_reason: StopReason;
  usage: Usage;
}

/**
 * One streamed model turn: send a request, hear its text as it is written,
 * get the whole message back.
 *
 * Injected rather than constructed by the analyst, for the same reason the
 * gateway takes a `SignatureVerifier`: the interesting logic — the tool loop,
 * the prompt layout, the schema check, the claim verifier — has nothing to do
 * with the network, and tests run it against a scripted fake that never opens
 * a socket or spends a cent.
 */
export interface AnalystModel {
  stream(request: ModelRequest, onText: (delta: string) => void, signal: AbortSignal): Promise<ModelReply>;
}

/** A failed model call, sorted by what the analyst should do about it. */
export class ProviderError extends Error {
  constructor(
    readonly kind: 'auth' | 'busy' | 'timeout' | 'unreachable' | 'aborted' | 'failed',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /** Worth another attempt with the same request. */
  get retryable(): boolean {
    return this.kind === 'busy' || this.kind === 'timeout' || this.kind === 'unreachable';
  }
}
