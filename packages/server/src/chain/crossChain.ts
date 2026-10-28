import { decodeAbiParameters, type Address, type Hex } from 'viem';
import {
  ZERO_ADDRESS,
  errorMessage,
  gameEscrowAbi,
  layerZeroMessengerAbi,
  normaliseOriginChainId,
  type CrossChainEvent,
  type SpokeInfo,
} from '@lms/protocol';
import { readClient, signerClients } from './viem.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Parses `SPOKES`: the spoke chains players may stake from.
 *
 * `[{"chainId":8453,"escrow":"0x…"}]`
 *
 * Soft on bad input, like `ZAP_TOKENS`: a malformed entry is dropped with a
 * warning rather than stopping the server, because the hub still works
 * without it. So is a second entry for the same chain — the client would not
 * know which escrow to stake into.
 */
export function parseSpokes(raw: string, hubChainId: number): SpokeInfo[] {
  if (raw.trim().length === 0) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');

    const seen = new Set<number>();
    return parsed.flatMap((item): SpokeInfo[] => {
      const spoke = toSpoke(item);
      if (!spoke || spoke.chainId === hubChainId || seen.has(spoke.chainId)) {
        console.warn('[spokes] ignoring entry:', JSON.stringify(item));
        return [];
      }
      seen.add(spoke.chainId);
      return [spoke];
    });
  } catch (error) {
    console.warn('[spokes] SPOKES is not valid JSON:', errorMessage(error));
    return [];
  }
}

function toSpoke(item: unknown): SpokeInfo | null {
  if (typeof item !== 'object' || item === null) return null;
  const { chainId, escrow } = item as Record<string, unknown>;
  if (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId <= 0) return null;
  if (typeof escrow !== 'string' || !ADDRESS.test(escrow) || escrow === ZERO_ADDRESS) return null;
  return { chainId, escrow: escrow as `0x${string}` };
}

/** A delivery the hub messenger is holding, exactly as `retry` must be given it. */
export interface ParkedDelivery {
  guid: Hex;
  srcChainId: number;
  srcApp: Hex;
  payload: Hex;
  value: bigint;
}

/** The hub events the watcher reacts to, in the order they happened. */
export type CrossChainLog =
  | { kind: 'joined'; matchId: `0x${string}`; player: Address; originChainId: number }
  | { kind: 'refunded'; matchId: `0x${string}`; player: Address; amount: bigint; reason: number }
  | { kind: 'parked'; delivery: ParkedDelivery }
  | { kind: 'retried'; guid: Hex };

/**
 * Everything the watcher needs from the hub, as an interface, so the decisions
 * — who to tell what, and when to retry — can be tested with a fake.
 */
export interface CrossChainPort {
  blockNumber(): Promise<bigint>;
  /** Escrow and messenger events in `[from, to]`, in block and log order. */
  logs(from: bigint, to: bigint): Promise<CrossChainLog[]>;
  /**
   * Hands a parked delivery to the escrow again. Returns false, rather than
   * throwing, while the hub still refuses it or when there is no key to pay
   * for it: `retry` is permissionless, so anyone else may send it instead.
   */
  retry(delivery: ParkedDelivery): Promise<boolean>;
}

export interface CrossChainWatcherOptions {
  port: CrossChainPort;
  hubChainId: number;
  /** Tells one player about one of their joins. Dropped if they are not connected. */
  notify: (player: Address, event: CrossChainEvent) => void;
  /** First block to read. Defaults to a short way behind the head, like the bridge. */
  fromBlock?: bigint;
}

/**
 * Follows cross-chain joins once they reach the hub.
 *
 * A spoke join takes minutes to arrive, and what happens then is decided on
 * the hub: a seat, a refund credited there because the lobby filled in the
 * meantime, or — if the hub cannot take the delivery at all — a stake parked
 * in the messenger. The player's browser is on the spoke and sees none of
 * that, so this tells them.
 *
 * It also retries parked deliveries. A delivery parks when the hub refuses
 * the messenger outright, which is a configuration problem: a spoke that went
 * live before governance registered it, say. Once the fix executes, `retry`
 * succeeds; this sends it on the next tick rather than waiting for someone to
 * notice. Like locking and finalising, it is permissionless, so the keeper is
 * a convenience: anyone holding the delivery from its event can retry it.
 */
export class CrossChainWatcher {
  /** Deliveries waiting in the messenger, by lowercased guid. */
  readonly parked = new Map<string, ParkedDelivery>();
  private cursor: bigint | null;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: CrossChainWatcherOptions) {
    this.cursor = options.fromBlock ?? null;
  }

  start(pollMs: number): void {
    void this.tickLogged();
    this.timer = setInterval(() => void this.tickLogged(), pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    // Overlapping ticks would double-submit retries.
    if (this.running) return;
    this.running = true;
    try {
      await this.read();
      await this.retryParked();
    } finally {
      this.running = false;
    }
  }

  private async read(): Promise<void> {
    const { port } = this.options;
    const latest = await port.blockNumber();
    const from = this.cursor ?? (latest > 5_000n ? latest - 5_000n : 0n);
    if (from > latest) return;

    for (const log of await port.logs(from, latest)) this.apply(log);
    this.cursor = latest + 1n;
  }

  private apply(log: CrossChainLog): void {
    const { notify, hubChainId } = this.options;
    switch (log.kind) {
      case 'joined':
        // Zero is a join on the hub itself, which the player already watched land.
        if (log.originChainId === 0) return;
        notify(log.player, {
          kind: 'seated',
          matchId: log.matchId,
          chainId: normaliseOriginChainId(log.originChainId, hubChainId),
        });
        return;
      case 'refunded':
        notify(log.player, {
          kind: 'refunded',
          matchId: log.matchId,
          amount: log.amount.toString(),
          reason: log.reason,
        });
        return;
      case 'parked': {
        const { delivery } = log;
        this.parked.set(delivery.guid.toLowerCase(), delivery);
        const join = decodeJoin(delivery.payload);
        if (join) notify(join.player, { kind: 'parked', matchId: join.matchId, amount: delivery.value.toString() });
        console.warn(
          `[spokes] delivery ${delivery.guid} from chain ${delivery.srcChainId} parked with ${delivery.value} wei`,
        );
        return;
      }
      case 'retried':
        this.parked.delete(log.guid.toLowerCase());
        return;
    }
  }

  private async retryParked(): Promise<void> {
    for (const [key, delivery] of this.parked) {
      if (await this.options.port.retry(delivery)) {
        // Deleted now rather than on `DeliveryRetried`, so the next tick does
        // not send it twice before that event is read.
        this.parked.delete(key);
        console.log(`[spokes] retried parked delivery ${delivery.guid}`);
      }
    }
  }

  private async tickLogged(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      console.error('[spokes] poll failed:', errorMessage(error));
    }
  }
}

/** The `(matchId, player)` a spoke join carries, or null for anything else. */
export function decodeJoin(payload: Hex): { matchId: `0x${string}`; player: Address } | null {
  try {
    const [matchId, player] = decodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }], payload);
    return { matchId, player };
  } catch {
    return null;
  }
}

export interface ViemCrossChainOptions {
  rpcUrl: string;
  chainId: number;
  escrow: Address;
  /** The hub `LayerZeroMessenger`. Without it, parked deliveries are neither seen nor retried. */
  messenger: Address | null;
  /** Pays for retries. Without it, deliveries are reported but not retried. */
  keeperKey?: Hex;
}

/** The production port: viem against a real RPC. */
export function viemCrossChain(options: ViemCrossChainOptions): CrossChainPort {
  const signer = options.keeperKey ? signerClients(options.keeperKey, options.chainId, options.rpcUrl) : null;
  const client = signer?.publicClient ?? readClient(options.chainId, options.rpcUrl);
  const { escrow, messenger } = options;

  return {
    blockNumber: () => client.getBlockNumber(),

    async logs(fromBlock, toBlock) {
      const [joined, refunded, parked, retried] = await Promise.all([
        client.getContractEvents({ address: escrow, abi: gameEscrowAbi, eventName: 'PlayerJoined', fromBlock, toBlock }),
        client.getContractEvents({ address: escrow, abi: gameEscrowAbi, eventName: 'JoinRefunded', fromBlock, toBlock }),
        messenger
          ? client.getContractEvents({
              address: messenger,
              abi: layerZeroMessengerAbi,
              eventName: 'DeliveryParked',
              fromBlock,
              toBlock,
            })
          : [],
        messenger
          ? client.getContractEvents({
              address: messenger,
              abi: layerZeroMessengerAbi,
              eventName: 'DeliveryRetried',
              fromBlock,
              toBlock,
            })
          : [],
      ]);

      const ordered: Array<{ block: bigint; index: number; log: CrossChainLog }> = [];
      const at = (raw: { blockNumber: bigint | null; logIndex: number | null }, log: CrossChainLog) =>
        ordered.push({ block: raw.blockNumber ?? 0n, index: raw.logIndex ?? 0, log });

      for (const raw of joined) {
        const { matchId, player, originChainId } = raw.args;
        if (matchId && player && originChainId !== undefined) {
          at(raw, { kind: 'joined', matchId, player, originChainId: Number(originChainId) });
        }
      }
      for (const raw of refunded) {
        const { matchId, player, amount, reason } = raw.args;
        if (matchId && player && amount !== undefined && reason !== undefined) {
          at(raw, { kind: 'refunded', matchId, player, amount, reason: Number(reason) });
        }
      }
      for (const raw of parked) {
        const { guid, srcChainId, srcApp, payload, value } = raw.args;
        if (guid && srcChainId !== undefined && srcApp && payload && value !== undefined) {
          at(raw, { kind: 'parked', delivery: { guid, srcChainId: Number(srcChainId), srcApp, payload, value } });
        }
      }
      for (const raw of retried) {
        if (raw.args.guid) at(raw, { kind: 'retried', guid: raw.args.guid });
      }

      ordered.sort((a, b) => (a.block === b.block ? a.index - b.index : a.block < b.block ? -1 : 1));
      return ordered.map(({ log }) => log);
    },

    async retry(delivery) {
      if (!signer || !messenger) return false;
      try {
        const { request } = await client.simulateContract({
          account: signer.account,
          address: messenger,
          abi: layerZeroMessengerAbi,
          functionName: 'retry',
          args: [delivery.guid, delivery.srcChainId, delivery.srcApp, delivery.payload, delivery.value],
        });
        await client.waitForTransactionReceipt({ hash: await signer.walletClient.writeContract(request) });
        return true;
      } catch {
        // Still refused, or someone else retried it first: the next tick reads the truth.
        return false;
      }
    },
  };
}
