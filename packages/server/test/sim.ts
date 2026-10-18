import { mulberry32, type Link } from '@lms/harness';
import { Gateway, Lobby, MemoryArchive, nullRelayer, type Socket } from '@lms/server';

/**
 * Deterministic in-process simulation: a virtual clock, and links that carry
 * frames between `BotClient`s and a real `Gateway` through it.
 *
 * Nothing here touches a port or the wall clock, so a run with a given seed
 * replays exactly. The only real asynchrony left is signing and verifying,
 * which `settle` drains between events.
 */

/** Lets pending promise chains (signing, verifying, dispatch) run to completion. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

export class VirtualClock {
  now = 0;
  private seq = 0;
  private readonly queue: Array<{ at: number; seq: number; fn: () => void }> = [];

  readonly schedule = (fn: () => void, ms: number): void => {
    this.queue.push({ at: this.now + Math.max(0, ms), seq: this.seq++, fn });
  };

  /** Runs every event due within `ms`, in time order, settling after each. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      let next = -1;
      for (let i = 0; i < this.queue.length; i += 1) {
        const event = this.queue[i];
        const best = this.queue[next];
        if (event && event.at <= end && (!best || event.at < best.at || (event.at === best.at && event.seq < best.seq))) {
          next = i;
        }
      }
      if (next < 0) break;
      const [event] = this.queue.splice(next, 1);
      if (!event) break;
      this.now = event.at;
      event.fn();
      await settle();
    }
    this.now = end;
  }

  /** Calls `fn` every `ms` from now on. */
  every(ms: number, fn: () => void): void {
    const tick = () => {
      fn();
      this.schedule(tick, ms);
    };
    this.schedule(tick, ms);
  }
}

/** Network behaviour between every client and the server. */
export interface Faults {
  /** One-way latency, drawn uniformly per frame; frames on one link stay in order, as over TCP. */
  minDelayMs: number;
  maxDelayMs: number;
}

export const NO_FAULTS: Faults = { minDelayMs: 0, maxDelayMs: 0 };

/** One connection: the bot's `Link` on one side, the gateway's `Socket` on the other. */
export class SimConnection {
  open = false;
  closed = false;
  /** Frames in flight, so a reset can lose them, as a real one would. */
  inFlight = 0;
  private lastToServer = 0;
  private lastToClient = 0;
  private readonly client: { open?: () => void; message?: (data: string) => void; close?: (code: number) => void } = {};
  private readonly server: { message?: (data: unknown) => void; close?: () => void } = {};
  private generation = 0;

  constructor(
    private readonly net: SimNetwork,
    readonly ip: string,
  ) {}

  /** The bot's end. */
  readonly link: Link = {
    send: (data) => this.carry('server', data),
    onOpen: (listener) => void (this.client.open = listener),
    onMessage: (listener) => void (this.client.message = listener),
    onClose: (listener) => void (this.client.close = listener),
    close: () => this.reset(1000),
  };

  /** The gateway's end. */
  readonly socket: Socket = {
    readyState: 1,
    send: (data) => this.carry('client', data),
    onMessage: (listener) => void (this.server.message = listener),
    onClose: (listener) => void (this.server.close = listener),
    close: (code) => this.reset(code),
  };

  /** Tears the connection down at once, losing whatever was in flight. */
  reset(code = 1006): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.generation += 1;
    this.inFlight = 0;
    (this.socket as { readyState: number }).readyState = 3;
    this.server.close?.();
    this.client.close?.(code);
  }

  /** Called by the network once the handshake has crossed. */
  establish(): void {
    if (this.closed) return;
    this.open = true;
    this.client.open?.();
  }

  private carry(to: 'server' | 'client', data: string): void {
    if (this.closed) return;
    const generation = this.generation;
    const now = this.net.clock.now;
    const delay = this.net.delay();
    // FIFO per direction: a later frame never overtakes an earlier one.
    const at = Math.max(now + delay, to === 'server' ? this.lastToServer : this.lastToClient);
    if (to === 'server') this.lastToServer = at;
    else this.lastToClient = at;
    this.inFlight += 1;
    this.net.clock.schedule(() => {
      if (this.closed || generation !== this.generation) return;
      this.inFlight -= 1;
      if (to === 'server') this.server.message?.(data);
      else this.client.message?.(data);
    }, at - now);
  }
}

export class SimNetwork {
  readonly connections: SimConnection[] = [];

  constructor(
    readonly clock: VirtualClock,
    private readonly gateway: Gateway,
    readonly random: () => number,
    public faults: Faults = NO_FAULTS,
  ) {}

  /** Opens a connection to the gateway; it is admitted after one network delay. */
  connect(ip = '10.0.0.1'): Link {
    const connection = new SimConnection(this, ip);
    this.connections.push(connection);
    this.clock.schedule(() => {
      if (connection.closed) return;
      // The gateway sends `hello` from inside `accept`, so the bot must be
      // listening — it is, because `connect` returned the link synchronously.
      if (this.gateway.accept(connection.socket, { ip })) connection.establish();
    }, this.delay());
    return connection.link;
  }

  delay(): number {
    const { minDelayMs, maxDelayMs } = this.faults;
    return minDelayMs + this.random() * (maxDelayMs - minDelayMs);
  }

  live(): SimConnection[] {
    return this.connections.filter((connection) => !connection.closed);
  }
}

/** A server, its clock and an in-process network, all on virtual time. */
export function world(seed = 1, options: { commitMs?: number; revealMs?: number; replayMs?: number } = {}) {
  const clock = new VirtualClock();
  const lobby = new Lobby({
    archive: new MemoryArchive(),
    relayer: nullRelayer,
    commitMs: options.commitMs ?? 5_000,
    revealMs: options.revealMs ?? 3_000,
    // As in production: the pause after each round is what paces a fast client.
    replayMs: options.replayMs ?? 2_500,
    maxPracticeRooms: 10_000,
  });
  const gateway = new Gateway({
    lobby,
    chainId: 1,
    now: () => clock.now,
    directory: () => ({ open: [], live: [] }),
    limits: { maxConnectionsPerIp: 10_000, connectBurstPerIp: 10_000, loginBurstPerIp: 10_000 },
  });
  clock.every(250, () => lobby.tick(clock.now));
  clock.every(1_000, () => gateway.sweep(clock.now));
  const random = mulberry32(seed);
  const net = new SimNetwork(clock, gateway, random);
  return { clock, lobby, gateway, net, random };
}
