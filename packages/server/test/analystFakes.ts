import { ProviderError, type AnalystModel, type ModelReply, type ModelRequest } from '@lms/server';

/** One scripted model turn: the message to return — or an error to throw. */
export type Turn =
  | { reply: Partial<ModelReply> & Pick<ModelReply, 'content' | 'stop_reason'> }
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
    // Deep-copied, because the analyst appends to its message array after the call.
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

/** A final turn answering with `document` as JSON. */
export function answer(document: unknown): Turn {
  return { reply: { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(document) }] } };
}

/** A turn that asks for tools, with a signature ahead of the calls as the real model sends. */
export function toolTurn(calls: Array<{ name: string; input: unknown }>, stop: 'tool_use' | 'max_tokens' = 'tool_use'): Turn {
  return {
    reply: {
      stop_reason: stop,
      content: [
        { type: 'signature', signature: 'sig' },
        ...calls.map((call, i) => ({ type: 'tool_use' as const, id: `call_${i}`, name: call.name, input: call.input })),
      ],
    },
  };
}
