import type { IncomingMessage } from 'node:http';
import type { WebSocket, WebSocketServer } from 'ws';
import { MAX_CLIENT_FRAME_BYTES } from '@lms/protocol';
import type { Gateway } from './gateway.js';
import { Heartbeat } from './heartbeat.js';
import { peerFrom } from './peer.js';
import { log } from '../observability/log.js';
import { wsClosed } from '../observability/metrics.js';

const logger = log.child({ component: 'transport' });

/** `WebSocketServer` options the gateway relies on. */
export const WS_SERVER_OPTIONS = {
  // `ws` defaults to 100 MiB. Refusing at the transport means an oversized
  // frame is never buffered at all; the gateway's own check stays as the
  // backstop for anything that reaches it some other way.
  maxPayload: MAX_CLIENT_FRAME_BYTES,
  // Compression costs memory per socket and opens decompression bombs, for
  // frames that are a few hundred bytes of JSON.
  perMessageDeflate: false,
} as const;

/**
 * Connects a `ws` server to the gateway.
 *
 * `ws` speaks `on(event, listener)`; the gateway wants two named methods, so
 * the shapes are bridged here rather than by casting the socket into place.
 *
 * Every socket gets an `error` listener before anything else. `ws` reports
 * protocol violations — a frame over `maxPayload`, invalid UTF-8, a bad
 * opcode — as an `error` event, and an `error` event with no listener is
 * thrown, which would take the whole process down on one malformed frame.
 * With a listener, `ws` just closes that one socket.
 */
export function attachTransport(
  wss: WebSocketServer,
  gateway: Gateway,
  options: { trustProxy: boolean; heartbeat?: Heartbeat },
): Heartbeat {
  const heartbeat = options.heartbeat ?? new Heartbeat();

  wss.on('error', (error) => logger.error('websocket server error', { error }));
  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    socket.on('error', (error: Error & { code?: string }) => {
      wsClosed.inc({ reason: 'protocol_error' });
      logger.debug('socket error', { code: error.code, error });
    });

    const admitted = gateway.accept(
      {
        get readyState() {
          return socket.readyState;
        },
        get bufferedAmount() {
          return socket.bufferedAmount;
        },
        send: (data) => socket.send(data),
        close: (code, reason) => socket.close(code, reason),
        onMessage: (listener) => void socket.on('message', listener),
        onClose: (listener) => void socket.on('close', listener),
      },
      peerFrom(request, options.trustProxy),
    );
    if (!admitted) return;

    const pingable = {
      ping: () => socket.ping(),
      terminate: () => socket.terminate(),
      onPong: (listener: () => void) => void socket.on('pong', listener),
    };
    heartbeat.track(pingable);
    socket.on('close', () => heartbeat.untrack(pingable));
  });

  return heartbeat;
}
