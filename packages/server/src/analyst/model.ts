import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage, BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';

export type ModelRequest = BetaMessageStreamParams;

/** The parts of a finished model turn the analyst reads. */
export type ModelReply = Pick<BetaMessage, 'id' | 'model' | 'content' | 'stop_reason' | 'stop_details' | 'usage'>;

/**
 * One streamed model turn: send a request, hear its text as it is written,
 * get the whole message back.
 *
 * Injected rather than constructed by the analyst, for the same reason the
 * gateway takes a `SignatureVerifier`: the interesting logic — the tool loop,
 * the prompt layout, the schema check, the claim verifier — has nothing to do
 * with the network, and tests run it against a scripted fake that never opens
 * a socket or spends a cent. The real implementation is a few lines over the
 * SDK and is the only file that touches it at runtime.
 */
export interface AnalystModel {
  stream(request: ModelRequest, onText: (delta: string) => void, signal: AbortSignal): Promise<ModelReply>;
}

export interface AnthropicModelOptions {
  /** Per attempt, in milliseconds. The SDK retries a timed-out attempt. */
  timeoutMs: number;
  /** Retries on 408/409/429/5xx and dropped connections, with the SDK's backoff. */
  maxRetries: number;
  /** Explicit key. Omitted, the SDK resolves credentials from the environment. */
  apiKey?: string;
}

/** The production model: Claude over the official SDK's streaming helper. */
export function anthropicModel(options: AnthropicModelOptions): AnalystModel {
  const client = new Anthropic({
    timeout: options.timeoutMs,
    maxRetries: options.maxRetries,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
  });
  return {
    async stream(request, onText, signal) {
      const stream = client.beta.messages.stream(request, { signal });
      stream.on('text', (delta) => onText(delta));
      return stream.finalMessage();
    },
  };
}
