import { Worker } from 'node:worker_threads';
import { verifyMessage, verifyTypedData } from 'viem';
import type { SignatureVerifier, TypedSignatureVerifier } from './gateway.js';

/**
 * Login signature recovery on worker threads.
 *
 * Recovering a secp256k1 signature costs about 5 ms of pure-JS CPU, all of it
 * on the event loop when done inline. The load test showed what that means:
 * a burst of logins — a reconnect storm after a deploy, a popular lobby
 * opening — stalls every room's clock along with it, and one core tops out
 * near 180 logins a second. Spread over a pool, recovery runs in parallel and
 * the event loop only ever waits on a message.
 *
 * The worker source is inline (`eval`) so the same code runs under `tsx` in
 * development and from `dist` in production, with no worker file to locate.
 */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const { verifyMessage, verifyTypedData } = require('viem');
parentPort.on('message', ({ id, typed, args }) => {
  (typed ? verifyTypedData(args) : verifyMessage(args)).then(
    (valid) => parentPort.postMessage({ id, valid }),
    () => parentPort.postMessage({ id, valid: false }),
  );
});
`;

interface Slot {
  worker: Worker;
  pending: Map<number, (valid: boolean) => void>;
}

export class VerifyPool {
  private readonly slots: Slot[] = [];
  private nextId = 0;
  private closing = false;

  constructor(size: number) {
    for (let i = 0; i < size; i += 1) this.slots.push(this.spawn());
  }

  get size(): number {
    return this.slots.length;
  }

  /** True when `signature` over `message` recovers to `address`. Never throws. */
  readonly verify: SignatureVerifier = (args) => {
    if (this.slots.length === 0) return verifyMessage(args).catch(() => false);
    return this.post(false, args);
  };

  /**
   * True when `signature` over the typed data recovers to `address`. Never
   * throws. Session grants and every signed move go through here: a move is
   * one recovery, and a full table makes two a round per seat.
   */
  readonly verifyTyped: TypedSignatureVerifier = (args) => {
    if (this.slots.length === 0) return verifyTypedData(args).catch(() => false);
    return this.post(true, args);
  };

  private post(typed: boolean, args: unknown): Promise<boolean> {
    // Least loaded, so one slow batch does not queue behind another.
    let slot = this.slots[0] as Slot;
    for (const candidate of this.slots) if (candidate.pending.size < slot.pending.size) slot = candidate;
    const id = this.nextId++;
    return new Promise<boolean>((resolve) => {
      slot.pending.set(id, resolve);
      slot.worker.postMessage({ id, typed, args });
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.slots.map((slot) => slot.worker.terminate()));
    this.slots.length = 0;
  }

  private spawn(): Slot {
    const slot: Slot = { worker: new Worker(WORKER_SOURCE, { eval: true }), pending: new Map() };
    slot.worker.unref();
    slot.worker.on('message', ({ id, valid }: { id: number; valid: boolean }) => {
      slot.pending.get(id)?.(valid);
      slot.pending.delete(id);
    });
    // A dead worker fails its in-flight logins (the client retries) and is replaced.
    slot.worker.on('error', () => undefined);
    slot.worker.on('exit', () => {
      for (const resolve of slot.pending.values()) resolve(false);
      slot.pending.clear();
      const index = this.slots.indexOf(slot);
      if (index >= 0 && !this.closing) this.slots[index] = this.spawn();
    });
    return slot;
  }
}

/**
 * Local recovery first, the account's own say second.
 *
 * An EOA's login recovers to its address and is settled by the pool with no
 * network at all. Only a signature that does not recover — a 7702 account
 * signing with a session key — goes on to `fallback`, the ERC-1271 call over
 * RPC. Previously every login made that call, which put one RPC request on
 * the critical path of every connection.
 */
export function layeredVerifier<Args>(
  local: (args: Args) => Promise<boolean>,
  fallback?: (args: Args) => Promise<boolean>,
): (args: Args) => Promise<boolean> {
  return async (args) => (await local(args)) || (fallback ? fallback(args) : false);
}
