import type { ClientMessage, ServerMessage } from '@lms/api';

export type Handler = (message: ServerMessage) => void;

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

/**
 * Typed socket with reconnect.
 *
 * A dropped connection must not cost the player their seat: the match lives on
 * the server, so reconnecting and re-authenticating is enough to be handed the
 * current state again. Messages queued while offline are flushed on reconnect
 * rather than thrown away, because a commit sent a moment before a blip still
 * belongs in this round.
 */
export class Net {
  private socket: WebSocket | null = null;
  private readonly handlers = new Set<Handler>();
  private readonly outbox: ClientMessage[] = [];
  private backoff = BASE_BACKOFF_MS;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Whether this socket has logged in. Until it has, everything but the login
   * itself is queued: the server refuses any other message from an
   * unauthenticated socket, so a commit sent in the gap between a reconnect
   * and the re-login would simply be lost.
   */
  private ready = false;

  constructor(
    private readonly url: string,
    /** Called after every (re)connect so the caller can re-auth and re-join. */
    private readonly onReady: () => void,
    private readonly onStatus: (connected: boolean) => void,
  ) {}

  on(handler: Handler): void {
    this.handlers.add(handler);
  }

  off(handler: Handler): void {
    this.handlers.delete(handler);
  }

  /** Opens the socket. A no-op while one is already open or opening. */
  connect(): void {
    this.closed = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    this.ready = false;

    socket.onopen = () => {
      this.backoff = BASE_BACKOFF_MS;
      this.onStatus(true);
    };

    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      for (const handler of this.handlers) handler(message);
      // `hello` carries a fresh nonce, so re-auth only after the handlers have
      // stored it — otherwise a reconnect would sign the previous session's nonce.
      if (message.type === 'hello') this.onReady();
    };

    socket.onclose = () => {
      // A socket replaced by `close()` and `connect()` must not clear its successor.
      if (this.socket !== socket) return;
      this.socket = null;
      this.onStatus(false);
      if (this.closed) return;
      // Jittered, so a server restart is not met by every client at once on
      // the same exponential schedule. Half fixed, half random: never sooner
      // than half the backoff.
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoff * (0.5 + Math.random() / 2));
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    };

    socket.onerror = () => socket.close();
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN && (this.ready || message.type === 'auth')) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    this.outbox.push(message);
  }

  /** Called once the session is authenticated: anything buffered is now safe to send. */
  flush(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.ready = true;
    while (this.outbox.length > 0) {
      const message = this.outbox.shift();
      if (message) this.socket.send(JSON.stringify(message));
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.onStatus(false);
    socket?.close();
  }
}
