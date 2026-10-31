import { ProviderError, type AnalystModel, type ModelReply, type ModelRequest } from '@lms/server';

/** One scripted model call: the reply to return — or an error to throw. */
export type Turn =
  | { reply: Partial<ModelReply> & Pick<ModelReply, 'text' | 'stop_reason'> }
  | { error: unknown }
  /** Never answers: waits for the abort signal, then fails as a cancelled call does. */
  | { hang: true };

/**
 * A model that plays back a script, one entry per call, and records every
 * request it was sent. No network.
 */
export class FakeModel implements AnalystModel {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly script: Turn[]) {}

  async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelReply> {
    this.requests.push(structuredClone(request));
    const turn = this.script.shift();
    if (!turn) throw new Error('the fake model ran out of script');
    if ('error' in turn) throw turn.error;
    if ('hang' in turn) {
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      throw new ProviderError('aborted', 'the request was cancelled');
    }
    return { id: `msg_${this.requests.length}`, model: request.model, usage: usage(), ...turn.reply };
  }
}

export function usage(fields: Partial<ModelReply['usage']> = {}): ModelReply['usage'] {
  return {
    input_tokens: 1_000,
    output_tokens: 500,
    cache_read_input_tokens: 0,
    ...fields,
  };
}

/** A reply answering with `document` as JSON. */
export function answer(document: unknown): Turn {
  return { reply: { stop_reason: 'end_turn', text: JSON.stringify(document) } };
}
