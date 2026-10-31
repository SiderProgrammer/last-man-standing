import { fork, type ChildProcess } from 'node:child_process';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address, Hex } from 'viem';
import type { CommitReceipt, Transcript } from '@lms/protocol';
import { RemoteError, Rpc } from '../util/rpc.js';
import { AttestationRefused, type Attestor } from './service.js';

export interface AttestorProcessOptions {
  privateKey: Hex;
  chainId: number;
  escrow: Address;
  /** Lets the attestor check each transcript's seed, rules and seats against the escrow. */
  rpcUrl?: string;
  /** How long to wait for the child to come up. Defaults to 15 s. */
  startTimeoutMs?: number;
}

/**
 * The attestor in a child process of its own (`attestor/process.ts`).
 *
 * The child holds the attestor key and replays every transcript before it
 * signs; this side only forwards. If the child dies it is started again on
 * the next call, and the call waits for it.
 */
export class AttestorProcess implements Attestor {
  private child: ChildProcess | null = null;
  private rpc: Rpc | null = null;
  private starting: Promise<Rpc> | null = null;
  private stopped = false;
  private signerAddress: Address = '0x0000000000000000000000000000000000000000';

  private constructor(private readonly options: AttestorProcessOptions) {}

  /** Forks the attestor and waits until it has said which address it signs as. */
  static async start(options: AttestorProcessOptions): Promise<AttestorProcess> {
    const attestor = new AttestorProcess(options);
    attestor.signerAddress = (await attestor.spawn()).address;
    return attestor;
  }

  get address(): Address {
    return this.signerAddress;
  }

  attest(transcript: Transcript): Promise<Hex> {
    return this.call<Hex>('attest', transcript).catch((error: unknown) => {
      throw error instanceof RemoteError && error.name === 'AttestationRefused' ? new AttestationRefused(error.message) : error;
    });
  }

  abort(matchId: `0x${string}`): Promise<Hex> {
    return this.call('abort', matchId);
  }

  receipt(receipt: CommitReceipt): Promise<Hex> {
    return this.call('receipt', receipt);
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
    this.child = null;
    this.rpc = null;
  }

  /**
   * Calls the child, starting it first if it is not running. A call caught
   * by the child dying is made once more, on a fresh one: signing is
   * idempotent, so asking twice costs nothing.
   */
  private async call<T>(method: string, ...args: unknown[]): Promise<T> {
    try {
      return await (await this.connection()).call<T>(method, ...args);
    } catch (error) {
      if (!(error instanceof AttestorExited) || this.stopped) throw error;
      return (await this.connection()).call<T>(method, ...args);
    }
  }

  private async connection(): Promise<Rpc> {
    return this.rpc ?? (await (this.starting ??= this.spawn().then(({ rpc }) => rpc)));
  }

  private lost(code: number | null): void {
    this.rpc?.failAll(new AttestorExited(`the attestor process exited (${code})`));
    this.child = null;
    this.rpc = null;
    this.starting = null;
    if (!this.stopped) console.error(`[attestor] process exited with ${code}; restarting it on the next call`);
  }

  private spawn(): Promise<{ rpc: Rpc; address: Address }> {
    const { privateKey, chainId, escrow, rpcUrl } = this.options;
    const here = fileURLToPath(import.meta.url);
    // `.ts` under tsx and vitest, `.js` once built.
    const entry = here.replace(/remote(\.[cm]?[jt]s)$/, 'process$1');
    const child = fork(entry, [], {
      // The other keys and secrets stay in the server; this one leaves it.
      env: {
        ...withoutSecrets(process.env),
        ATTESTOR_PK: privateKey,
        CHAIN_ID: String(chainId),
        ESCROW_ADDRESS: escrow,
        ...(rpcUrl ? { RPC_URL: rpcUrl } : {}),
      },
      execArgv: extname(entry) === '.ts' ? ['--import', 'tsx'] : [],
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const rpc = new Rpc({
      // A child that has just died throws on send: the call fails as if it
      // had exited mid-call, and is retried.
      send: (message) => {
        if (!child.connected) throw new AttestorExited('the attestor process is not running');
        child.send(message as never);
      },
      listen: (listener) => void child.on('message', listener),
    });
    this.child = child;
    this.rpc = null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('the attestor process did not start'));
      }, this.options.startTimeoutMs ?? 15_000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`the attestor process exited (${code}) before it was ready`));
        this.lost(code);
      });
      rpc.on('ready', (address) => {
        clearTimeout(timer);
        child.removeAllListeners('exit');
        child.on('exit', (code) => this.lost(code));
        this.rpc = rpc;
        this.starting = null;
        resolve({ rpc, address: address as Address });
      });
    });
  }
}

/** A call the child never answered because it exited. */
class AttestorExited extends Error {
  override name = 'AttestorExited';
}

/** The environment, less every key and secret the server holds. */
function withoutSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (/(_PK|_KEY|SECRET|PASSWORD|DATABASE_URL)$/.test(name)) continue;
    kept[name] = value;
  }
  return kept;
}
