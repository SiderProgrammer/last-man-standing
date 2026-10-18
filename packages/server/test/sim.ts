import { keccak256, toHex } from 'viem';
import { mulberry32, type Link } from '@lms/harness';
import { Gateway, Lobby, MemoryArchive, nullRelayer, type Relayer, type Socket } from '@lms/server';

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
  /** Per frame: the connection resets, losing every frame still in flight both ways. */
  resetRate?: number;
  /**
   * Per frame: the connection goes half-open. Frames vanish silently in both
   * directions and neither side is told, until the server's heartbeat gives
   * up on it after `heartbeatMs` — the dead-Wi-Fi case.
   */
  stallRate?: number;
  /** Per connection attempt: refused before the handshake completes. */
  refuseRate?: number;
  /** How long a stalled connection survives before the heartbeat terminates it. */
  heartbeatMs?: number;
}

export const NO_FAULTS: Faults = { minDelayMs: 0, maxDelayMs: 0 };

/** One connection: the bot's `Link` on one side, the gateway's `Socket` on the other. */
export class SimConnection {
  open = false;
  closed = false;
  stalled = false;
  private lastToServer = 0;
  private lastToClient = 0;
  private readonly client: { open?: () => void; message?: (data: string) => void; close?: (code: number) => void } = {};
  private readonly server: { message?: (data: unknown) => void; close?: () => void } = {};

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

  /** Tears the connection down at once; whatever was in flight is lost. */
  reset(code = 1006): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
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

  /** Goes half-open: see `Faults.stallRate`. */
  stall(): void {
    if (this.stalled || this.closed) return;
    this.stalled = true;
    this.net.clock.schedule(() => this.reset(1006), this.net.faults.heartbeatMs ?? 30_000);
  }

  private carry(to: 'server' | 'client', data: string): void {
    if (this.closed || this.stalled) return;
    const faults = this.net.faults;
    if (faults.resetRate && this.net.random() < faults.resetRate) {
      this.reset(1006);
      return;
    }
    if (faults.stallRate && this.net.random() < faults.stallRate) {
      this.stall();
      return;
    }
    const now = this.net.clock.now;
    // FIFO per direction: a later frame never overtakes an earlier one.
    const at = Math.max(now + this.net.delay(), to === 'server' ? this.lastToServer : this.lastToClient);
    if (to === 'server') this.lastToServer = at;
    else this.lastToClient = at;
    this.net.clock.schedule(() => {
      // Lost if the connection died, or went half-open, while it was in flight.
      if (this.closed || this.stalled) return;
      if (to === 'server') this.server.message?.(data);
      else this.client.message?.(data);
    }, at - now);
  }
}

export class SimNetwork {
  readonly connections: SimConnection[] = [];

  constructor(
    readonly clock: VirtualClock,
    public gateway: Gateway,
    readonly random: () => number,
    public faults: Faults = NO_FAULTS,
  ) {}

  /** Opens a connection to the gateway; it is admitted after one network delay. */
  connect(ip = '10.0.0.1'): Link {
    const connection = new SimConnection(this, ip);
    this.connections.push(connection);
    this.clock.schedule(() => {
      if (connection.closed) return;
      if (this.faults.refuseRate && this.random() < this.faults.refuseRate) {
        connection.reset(1006);
        return;
      }
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

/**
 * The simulation's stand-in for a login signature. Real recovery goes through
 * a dynamic import whose timing is not under the virtual clock's control, so
 * it would make runs irreproducible; the gateway's real verification is
 * covered by its own tests. Pass `sign: simSigner(address)` to a bot.
 */
export function simSignature(address: string, message: string): `0x${string}` {
  return keccak256(toHex(`${address.toLowerCase()}|${message}`));
}

export function simSigner(address: string): (message: string) => Promise<`0x${string}`> {
  return async (message) => simSignature(address, message);
}

export interface WorldOptions {
  commitMs?: number;
  revealMs?: number;
  replayMs?: number;
  relayer?: Relayer;
  archive?: MemoryArchive;
}

/**
 * A server, its clock and an in-process network, all on virtual time.
 * `restart()` replaces the server with a fresh one, as a process restart
 * would: every connection drops and every room in memory is gone.
 */
export function world(seed = 1, options: WorldOptions = {}) {
  const clock = new VirtualClock();
  const random = mulberry32(seed);
  const archive = options.archive ?? new MemoryArchive();
  let boots = 0;

  const boot = () => {
    const lobby = new Lobby({
      archive,
      relayer: options.relayer ?? nullRelayer,
      commitMs: options.commitMs ?? 5_000,
      revealMs: options.revealMs ?? 3_000,
      // As in production: the pause after each round is what paces a fast client.
      replayMs: options.replayMs ?? 2_500,
      maxPracticeRooms: 10_000,
      // Distinct per boot, as in production, but derived from the seed so a run replays.
      practiceNonceStart: (BigInt(seed) << 96n) + (BigInt(boots++) << 64n),
      practiceSeed: () => keccak256(toHex(`practice:${random()}`)),
      sleep: (ms) => new Promise((resolve) => clock.schedule(() => resolve(), ms)),
    });
    const gateway = new Gateway({
      lobby,
      chainId: 1,
      now: () => clock.now,
      directory: () => ({ open: [], live: [] }),
      limits: { maxConnectionsPerIp: 10_000, connectBurstPerIp: 10_000, loginBurstPerIp: 10_000 },
      verify: async ({ address, message, signature }) => signature === simSignature(address, message),
    });
    return { lobby, gateway };
  };

  const server = boot();
  const net = new SimNetwork(clock, server.gateway, random);
  clock.every(250, () => server.lobby.tick(clock.now));
  clock.every(1_000, () => server.gateway.sweep(clock.now));

  return {
    clock,
    net,
    random,
    archive,
    get lobby() {
      return server.lobby;
    },
    get gateway() {
      return server.gateway;
    },
    restart() {
      for (const connection of net.live()) connection.reset(1012);
      Object.assign(server, boot());
      net.gateway = server.gateway;
    },
  };
}
