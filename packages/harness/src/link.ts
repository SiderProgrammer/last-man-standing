import { WebSocket } from 'ws';

/**
 * A bidirectional text channel to the server.
 *
 * The bot client talks to this rather than to a socket, so the same client
 * runs over a real WebSocket in the load test and over an in-process link
 * with injected faults in the chaos test.
 */
export interface Link {
  send(data: string): void;
  onOpen(listener: () => void): void;
  onMessage(listener: (data: string) => void): void;
  /** Fires once, whichever side closed. */
  onClose(listener: (code: number) => void): void;
  close(): void;
}

/** A `Link` over a real WebSocket. */
export function wsLink(url: string): Link {
  const socket = new WebSocket(url, { perMessageDeflate: false });
  // An unanswered connect or a reset surfaces as `error` then `close`; the
  // close listener is what the client acts on, so errors are only swallowed.
  socket.on('error', () => undefined);
  return {
    send: (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    onOpen: (listener) => void socket.on('open', listener),
    onMessage: (listener) => void socket.on('message', (data) => listener(String(data))),
    onClose: (listener) => void socket.on('close', (code) => listener(code)),
    close: () => socket.terminate(),
  };
}
