import type { AnalystModel, ModelReply, ModelRequest } from '@lms/server';

/** One scripted model turn: text to stream, then the message to return — or an error to throw. */
export type Turn =
  | { chunks?: string[]; reply: Partial<ModelReply> & Pick<ModelReply, 'content' | 'stop_reason'> }
  | { error: unknown };

/**
 * A model that plays back a script, one entry per call, and records every
 * request it was sent. No network, no SDK client.
 */
export class FakeModel implements AnalystModel {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly script: Turn[]) {}

  async stream(request: ModelRequest, onText: (delta: string) => void, signal: AbortSignal): Promise<ModelReply> {
    // Deep-copied, because the analyst appends to its message array after the call.
    this.requests.push(structuredClone(stripFormat(request)));
    const turn = this.script.shift();
    if (!turn) throw new Error('the fake model ran out of script');
    if ('error' in turn) throw turn.error;
    for (const chunk of turn.chunks ?? []) {
      if (signal.aborted) throw new Error('aborted');
      onText(chunk);
    }
    return { id: `msg_${this.requests.length}`, model: request.model, stop_details: null, usage: usage(), ...turn.reply };
  }
}

/** The structured-output helper carries a parse function `structuredClone` cannot copy. */
function stripFormat(request: ModelRequest): ModelRequest {
  const format = request.output_config?.format;
  if (!format) return request;
  return { ...request, output_config: { ...request.output_config, format: { type: format.type, schema: format.schema } } };
}

export function usage(fields: Partial<ModelReply['usage']> = {}): ModelReply['usage'] {
  return {
    input_tokens: 1_000,
    output_tokens: 500,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...fields,
  } as ModelReply['usage'];
}

/** A final turn answering with `document` as JSON, streamed in chunks of `size`. */
export function answer(document: unknown, size = 16): Turn {
  const text = JSON.stringify(document);
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return {
    chunks,
    reply: { stop_reason: 'end_turn', content: [{ type: 'text', text, citations: null }] as ModelReply['content'] },
  };
}

/** A turn that asks for tools, with a thinking block ahead of the calls as the real model sends. */
export function toolTurn(calls: Array<{ name: string; input: unknown }>, stop: 'tool_use' | 'max_tokens' = 'tool_use'): Turn {
  return {
    reply: {
      stop_reason: stop,
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        ...calls.map((call, i) => ({ type: 'tool_use', id: `toolu_${i}`, name: call.name, input: call.input })),
      ] as ModelReply['content'],
    },
  };
}
