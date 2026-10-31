/**
 * Calls across a process or thread boundary, both ways.
 *
 * The attestor runs in a child process and the analyst in a worker thread;
 * each side asks the other for things (sign this, load that match) and gets
 * an answer or an error back by id. A `Channel` is whatever carries the
 * messages: `process.send` for a child, a `MessagePort` for a worker.
 * Messages are structured clones, so a bigint or a Map crosses intact.
 */
export interface Channel {
  send(message: unknown): void;
  listen(listener: (message: unknown) => void): void;
}

/** Answers to the other side's calls, by method name. */
export type Handlers = Record<string, (...args: never[]) => unknown>;

/** An error from the other side: its name, message and `code`, if it had one. */
export class RemoteError extends Error {
  constructor(
    override readonly name: string,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

type Envelope =
  | { rpc: 'call'; id: number; method: string; args: unknown[] }
  | { rpc: 'result'; id: number; value: unknown }
  | { rpc: 'error'; id: number; name: string; message: string; code?: string }
  | { rpc: 'event'; event: string; payload: unknown };

export class Rpc {
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  private readonly events = new Map<string, (payload: unknown) => void>();

  constructor(
    private readonly channel: Channel,
    private readonly handlers: Handlers = {},
  ) {
    channel.listen((message) => void this.receive(message as Envelope));
  }

  call<T>(method: string, ...args: unknown[]): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        this.channel.send({ rpc: 'call', id, method, args } satisfies Envelope);
      } catch (error) {
        this.waiting.delete(id);
        reject(error);
      }
    });
  }

  /** Fire and forget: no answer comes back. */
  emit(event: string, payload: unknown): void {
    this.channel.send({ rpc: 'event', event, payload } satisfies Envelope);
  }

  on(event: string, listener: (payload: unknown) => void): void {
    this.events.set(event, listener);
  }

  /** Fails every call still waiting, for when the other side has gone. */
  failAll(error: Error): void {
    for (const { reject } of this.waiting.values()) reject(error);
    this.waiting.clear();
  }

  private async receive(message: Envelope): Promise<void> {
    if (typeof message !== 'object' || message === null || !('rpc' in message)) return;
    switch (message.rpc) {
      case 'call': {
        const handler = this.handlers[message.method] as ((...args: unknown[]) => unknown) | undefined;
        try {
          if (!handler) throw new Error(`no handler for ${message.method}`);
          this.channel.send({ rpc: 'result', id: message.id, value: await handler(...message.args) } satisfies Envelope);
        } catch (error) {
          const { name, message: text, code } = error as { name?: string; message?: string; code?: unknown };
          this.channel.send({
            rpc: 'error',
            id: message.id,
            name: name ?? 'Error',
            message: text ?? String(error),
            ...(typeof code === 'string' ? { code } : {}),
          } satisfies Envelope);
        }
        return;
      }
      case 'result':
      case 'error': {
        const waiting = this.waiting.get(message.id);
        if (!waiting) return;
        this.waiting.delete(message.id);
        if (message.rpc === 'result') waiting.resolve(message.value);
        else waiting.reject(new RemoteError(message.name, message.message, message.code));
        return;
      }
      case 'event':
        this.events.get(message.event)?.(message.payload);
        return;
    }
  }
}
