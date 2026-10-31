import {
  BaseError,
  ContractFunctionRevertedError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  nonceManager,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { errorMessage } from '@lms/protocol';
import { rpcChain } from './viem.js';

/** A contract call, as the sender sends it. */
export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

/** EIP-1559 fees, in wei per gas. */
export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * The chain, as one key's sender needs it. A seam, so the stuck-transaction
 * logic can be tested against a fake mempool.
 */
export interface TxPort {
  readonly address: Address;
  /** Throws the call's revert, decoded, if it would revert now. */
  simulate(call: ContractCall): Promise<void>;
  /** The next nonce for this key. Never the same twice until `resetNonce`. */
  nonce(): Promise<number>;
  /** Forgets handed-out nonces, so the next comes from the node. For after a send the node refused. */
  resetNonce(): void;
  fees(): Promise<Fees>;
  send(call: ContractCall, nonce: number, fees: Fees): Promise<Hex>;
  /** The receipt's status, or null while it is not mined. */
  receipt(hash: Hex): Promise<'success' | 'reverted' | null>;
}

/** A transaction that is out, and the one of its versions that lands. */
export interface SentTx {
  /** The first version sent. A replacement has another hash; `mined` resolves to the one that landed. */
  hash: Hex;
  /** Resolves once a version is mined successfully. Rejects on a revert, or after `maxBumps` replacements. */
  mined: Promise<Hex>;
}

/** The call reverts, so sending it again as it is would revert again. */
export class RevertedError extends Error {
  override name = 'RevertedError';
  constructor(
    message: string,
    /** The contract's error name, where it could be decoded. */
    readonly errorName?: string,
  ) {
    super(message);
  }
}

export interface TxSenderOptions {
  /** How often a pending transaction's receipt is looked for. Defaults to 2 s. */
  pollMs?: number;
  /** Without a receipt for this long, a transaction is replaced with higher fees. Defaults to 30 s. */
  stuckAfterMs?: number;
  /** Each replacement's fees, as a multiple of the last, in percent. At least 110: nodes refuse less. Defaults to 125. */
  bumpPercent?: number;
  /** Replacements before giving up on a transaction. Defaults to 5. */
  maxBumps?: number;
  /** Injectable for tests running on virtual time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Prefixes this sender's log lines, e.g. `keeper`. */
  label?: string;
}

/**
 * Sends one key's transactions, so nothing else in the process does.
 *
 * Every key the server holds gets exactly one: the nonces of a key are a
 * single sequence, and two senders sharing one would race for them. It
 *
 *   * takes nonces from viem's nonce manager, in order, without asking the
 *     node for each;
 *   * keeps one transaction in flight per key — `lockMatch:<id>`,
 *     `settle:<id>` — so a poll that comes round again while the last one's
 *     transaction is pending does not send a second;
 *   * simulates first, so a call that would revert costs a read and is
 *     refused as a `RevertedError`, not mined as a failure;
 *   * waits for the receipt;
 *   * replaces a transaction stuck without one, same nonce, fees raised by
 *     `bumpPercent`, until one version lands.
 */
export class TxSender {
  private readonly inFlight = new Set<string>();
  private readonly pollMs: number;
  private readonly stuckAfterMs: number;
  private readonly bumpPercent: bigint;
  private readonly maxBumps: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly label: string;

  constructor(
    private readonly port: TxPort,
    options: TxSenderOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 2_000;
    this.stuckAfterMs = options.stuckAfterMs ?? 30_000;
    this.bumpPercent = BigInt(Math.max(110, options.bumpPercent ?? 125));
    this.maxBumps = options.maxBumps ?? 5;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.label = options.label ?? 'tx';
  }

  get address(): Address {
    return this.port.address;
  }

  /** Whether a transaction under `key` is still out. */
  busy(key: string): boolean {
    return this.inFlight.has(key);
  }

  /** Keys with a transaction still out. */
  get pending(): number {
    return this.inFlight.size;
  }

  /**
   * Simulates `call`, then sends it, under `key`.
   *
   * @returns Once the first version is out: its hash, and a promise of the
   *          one that lands. Null, sending nothing, if a transaction under
   *          `key` is still in flight.
   * @throws  `RevertedError` if the call would revert, or whatever the node
   *          says if it refuses the transaction. Nothing was sent.
   */
  async send(key: string, call: ContractCall): Promise<SentTx | null> {
    if (this.inFlight.has(key)) return null;
    // Taken before the first await, so two callers racing cannot both send.
    this.inFlight.add(key);
    try {
      await this.port.simulate(call).catch((error: unknown) => {
        throw asReverted(error);
      });
      const nonce = await this.port.nonce();
      const fees = await this.port.fees();
      const hash = await this.port.send(call, nonce, fees).catch((error: unknown) => {
        // The nonce never reached the mempool; the next send must not skip it.
        this.port.resetNonce();
        throw error;
      });
      const mined = this.follow(key, call, nonce, fees, hash).finally(() => this.inFlight.delete(key));
      // A caller that only wanted the hash may never look at `mined`; its
      // failure is logged here, not left to surface as an unhandled rejection.
      mined.catch((error: unknown) => console.warn(`[${this.label}] ${key} did not land:`, errorMessage(error)));
      return { hash, mined };
    } catch (error) {
      this.inFlight.delete(key);
      throw error;
    }
  }

  /** `send`, then the mined hash. Throws if `key` is already in flight. */
  async sendAndWait(key: string, call: ContractCall): Promise<Hex> {
    const sent = await this.send(key, call);
    if (!sent) throw new Error(`${key} is already in flight`);
    return sent.mined;
  }

  /** Waits for one of a transaction's versions to be mined, replacing it while it is stuck. */
  private async follow(key: string, call: ContractCall, nonce: number, fees: Fees, first: Hex): Promise<Hex> {
    const hashes = [first];
    let current = fees;
    let sentAt = this.now();
    for (let bumps = 0; ; ) {
      await this.sleep(this.pollMs);
      for (const hash of hashes) {
        const status = await this.port.receipt(hash).catch(() => null);
        if (status === 'success') return hash;
        if (status === 'reverted') throw new RevertedError(`${key}: transaction ${hash} reverted`);
      }
      if (this.now() - sentAt < this.stuckAfterMs) continue;
      if (bumps >= this.maxBumps) {
        throw new Error(`${key}: no receipt after ${bumps} replacements (nonce ${nonce})`);
      }
      bumps += 1;
      const network = await this.port.fees().catch(() => current);
      current = {
        maxFeePerGas: max((current.maxFeePerGas * this.bumpPercent) / 100n, network.maxFeePerGas),
        maxPriorityFeePerGas: max((current.maxPriorityFeePerGas * this.bumpPercent) / 100n, network.maxPriorityFeePerGas),
      };
      sentAt = this.now();
      try {
        hashes.push(await this.port.send(call, nonce, current));
        console.warn(`[${this.label}] ${key} stuck at nonce ${nonce}; replaced with ${current.maxFeePerGas} wei/gas`);
      } catch (error) {
        // Most often "nonce too low": a version already landed, and the next
        // look at the receipts finds it.
        console.warn(`[${this.label}] replacing ${key} failed:`, errorMessage(error));
      }
    }
  }
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** A simulation failure as a `RevertedError` when the contract reverted, as it was otherwise. */
function asReverted(error: unknown): unknown {
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const reason = reverted.data?.errorName ?? reverted.reason;
      const result = new RevertedError(reason ? `reverts: ${reason}` : error.shortMessage, reverted.data?.errorName);
      result.cause = error;
      return result;
    }
  }
  return error;
}

/** `TxPort` over viem, for one private key. */
export function viemTxPort(options: { privateKey: Hex; chainId: number; rpcUrl: string }): TxPort {
  const chain = rpcChain(options.chainId, options.rpcUrl);
  const transport = http(options.rpcUrl);
  const account = privateKeyToAccount(options.privateKey, { nonceManager });
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });
  const scope = { address: account.address, chainId: options.chainId };

  return {
    address: account.address,
    async simulate(call) {
      // `ContractCall` is untyped by ABI, so viem cannot infer the arguments;
      // the encoding is checked against the ABI at run time either way.
      const parameters = {
        account,
        address: call.address,
        abi: call.abi,
        functionName: call.functionName,
        args: call.args ?? [],
        ...(call.value !== undefined ? { value: call.value } : {}),
      } as unknown as Parameters<typeof publicClient.simulateContract>[0];
      await publicClient.simulateContract(parameters);
    },
    nonce: () => nonceManager.consume({ ...scope, client: publicClient }),
    resetNonce: () => nonceManager.reset(scope),
    async fees() {
      const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
      return { maxFeePerGas, maxPriorityFeePerGas };
    },
    send: (call, nonce, fees) =>
      walletClient.sendTransaction({
        account,
        to: call.address,
        data: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args ?? [] }),
        ...(call.value !== undefined ? { value: call.value } : {}),
        nonce,
        ...fees,
      }),
    async receipt(hash) {
      try {
        return (await publicClient.getTransactionReceipt({ hash })).status;
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
    },
  };
}

/** A sender for `privateKey` over viem. */
export function viemTxSender(
  options: { privateKey: Hex; chainId: number; rpcUrl: string },
  senderOptions: TxSenderOptions = {},
): TxSender {
  return new TxSender(viemTxPort(options), senderOptions);
}
