/**
 * The analyst's own request and reply: provider-neutral, and exactly as much
 * of one as a single structured-output call needs. A model implementation
 * translates it to its provider's wire format and back (`gemini.ts`).
 */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelRequest {
  model: string;
  max_tokens: number;
  effort: Effort;
  /** The frozen system prompt: the same bytes on every request, so it caches. */
  system: string;
  /** JSON Schema the answer is constrained to. */
  output_schema: Record<string, unknown>;
  /** The one user message: the whole match. */
  prompt: string;
}

export interface Usage {
  /** Uncached input. */
  input_tokens: number;
  /** Output, thinking included. */
  output_tokens: number;
  cache_read_input_tokens: number;
}

/**
 * Why the call ended. Anything outside the three the analyst knows ends the
 * analysis, with the provider's own reason in the message.
 */
export type StopReason = 'end_turn' | 'max_tokens' | 'refusal' | (string & {});

/** The finished answer. */
export interface ModelReply {
  id: string;
  model: string;
  /** The answer's text, every part joined: the JSON the schema constrains. */
  text: string;
  stop_reason: StopReason;
  usage: Usage;
}

/**
 * One model call: send a request, get the whole reply back.
 *
 * Injected rather than constructed by the analyst, for the same reason the
 * gateway takes a `SignatureVerifier`: the interesting logic — the prompt
 * layout, the schema check, the claim verifier — has nothing to do with the
 * network, and tests run it against a scripted fake that never opens a socket
 * or spends a cent.
 */
export interface AnalystModel {
  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelReply>;
}

/** A failed model call, sorted by what the analyst should do about it. */
export class ProviderError extends Error {
  constructor(
    /** `limited`: the provider's own quota said no (a 429). Waiting, not retrying, fixes it. */
    readonly kind: 'auth' | 'limited' | 'busy' | 'timeout' | 'unreachable' | 'aborted' | 'failed',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /**
   * Worth another attempt with the same request. Not a timeout: the provider
   * got the request and is still working on it, so it counts against the
   * quota, and a retry would pay for it twice without the limiter knowing.
   */
  get retryable(): boolean {
    return this.kind === 'busy' || this.kind === 'unreachable';
  }
}
