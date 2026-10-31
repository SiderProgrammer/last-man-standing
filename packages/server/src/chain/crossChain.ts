import type { Address } from 'viem';
import {
  ZERO_ADDRESS,
  errorMessage,
  gameEscrowAbi,
  originChainId,
  type CrossChainEvent,
  type SpokeInfo,
} from '@lms/protocol';
import { readClient } from './viem.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Parses `SPOKES`: the spoke chains players may stake from.
 *
 * `[{"chainId":42161,"router":"0x…"}]`
 *
 * Soft on bad input, like `ZAP_TOKENS`: a malformed entry is dropped with a
 * warning rather than stopping the server, because the hub still works
 * without it. So is a second entry for the same chain — the client would not
 * know which router to stake through.
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
  const { chainId, router } = item as Record<string, unknown>;
  if (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId <= 0) return null;
  if (typeof router !== 'string' || !ADDRESS.test(router) || router === ZERO_ADDRESS) return null;
  return { chainId, router: router as `0x${string}` };
}

/** The hub events the watcher reacts to, in the order they happened. */
export type CrossChainLog =
  | { kind: 'joined'; matchId: `0x${string}`; player: Address; originChainId: number }
  | { kind: 'refunded'; matchId: `0x${string}`; player: Address; amount: bigint; reason: number };

/**
 * Everything the watcher needs from the hub, as an interface, so the decision
 * of who to tell what can be tested with a fake.
 */
export interface CrossChainPort {
  blockNumber(): Promise<bigint>;
  /** Escrow events in `[from, to]`, in block and log order. */
  logs(from: bigint, to: bigint): Promise<CrossChainLog[]>;
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
 * A spoke join waits for an Across relayer, and what happens when it is
 * filled is decided on the hub: a seat, or the stake credited there because
 * the lobby filled in the meantime. The player's browser is on the spoke and
 * sees none of that, so this tells them.
 */
export class CrossChainWatcher {
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
    // Overlapping ticks would report the same blocks twice.
    if (this.running) return;
    this.running = true;
    try {
      await this.read();
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
          chainId: originChainId(log.originChainId, hubChainId),
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

export interface ViemCrossChainOptions {
  rpcUrl: string;
  chainId: number;
  escrow: Address;
}

/** The production port: viem against a real RPC. */
export function viemCrossChain(options: ViemCrossChainOptions): CrossChainPort {
  const client = readClient(options.chainId, options.rpcUrl);
  const { escrow } = options;

  return {
    blockNumber: () => client.getBlockNumber(),

    async logs(fromBlock, toBlock) {
      const [joined, refunded] = await Promise.all([
        client.getContractEvents({ address: escrow, abi: gameEscrowAbi, eventName: 'PlayerJoined', fromBlock, toBlock }),
        client.getContractEvents({ address: escrow, abi: gameEscrowAbi, eventName: 'JoinRefunded', fromBlock, toBlock }),
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

      ordered.sort((a, b) => (a.block === b.block ? a.index - b.index : a.block < b.block ? -1 : 1));
      return ordered.map(({ log }) => log);
    },
  };
}
