import { createServer, type RequestListener, type Server } from 'node:http';

/**
 * The server's HTTP port, which can be open before the server is.
 *
 * A host that deploys without downtime starts the new instance beside the old
 * one, and stops the old one only once the new one's port answers. The new
 * one cannot play until the old one lets go of the database
 * (`claimInstance`), so it answers first: `/health` says it is up and
 * starting, and everything else, a WebSocket handshake included, is a 503 the
 * client retries. `serve` then hands the same port to the real thing.
 */
export class HttpFront {
  readonly server: Server;
  private handler: RequestListener = starting;
  private bound: Promise<void> | null = null;

  constructor() {
    this.server = createServer((request, response) => this.handler(request, response));
  }

  /** Answers every request from now on with `handler`. */
  serve(handler: RequestListener): void {
    this.handler = handler;
  }

  /** Opens the port, once: a second call waits for the first. Rejects if it cannot be bound. */
  listen(port: number): Promise<void> {
    return (this.bound ??= new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    }));
  }
}

const starting: RequestListener = (request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, starting: true }));
    return;
  }
  response.writeHead(503, { 'retry-after': '5', connection: 'close', 'access-control-allow-origin': '*' }).end();
};
