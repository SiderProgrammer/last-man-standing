import { parseEventLogs, type Address, type Hex } from 'viem';
import { addressKey } from '@lms/consensus';
import { gameEscrowAbi } from '@lms/contracts';
import { errorMessage, type MatchmakingTier, type ServerMessage } from '@lms/api';
import { RequestError } from '../errors.js';
import type { TxSender } from '../chain/txSender.js';
import { readClient } from '../chain/viem.js';

/** Opens a matchmade lobby on the escrow and says which match it is. */
export interface MatchmakerPort {
  create(stake: bigint, seats: number, roster: readonly Address[]): Promise<`0x${string}`>;
}

export interface MatchmakerOptions {
  port: MatchmakerPort;
  tiers: readonly MatchmakingTier[];
  /** Fewest players a table starts with: the rules' and the escrow's `minSeats`. */
  minSeats: number;
  /**
   * Once the longest-waiting player in a tier has waited this long, a table
   * is opened with however many are queued, if that is at least `minSeats`,
   * rather than waiting for it to fill. Defaults to 30 s.
   */
  fillAfterMs?: number;
  /** Tells one wallet something, on every socket it is logged in on. */
  notify: (player: Address, message: ServerMessage) => void;
  now?: () => number;
}

interface Waiting {
  player: Address;
  since: number;
}

/**
 * The matchmaking queue: one per tier, a tier being a stake and a table size.
 *
 * When a tier has a full table queued — or `minSeats` of them and the first
 * has waited `fillAfterMs` — it takes them off the queue, has the escrow open
 * a matchmade lobby with exactly them on its roster, and tells each one the
 * lobby's id. Each then stakes into it like any other lobby, by any route;
 * the escrow seats nobody else. Only matchmade lobbies earn play-mining.
 *
 * What this does not stop is several wallets with one owner queueing at once
 * in a quiet tier and being matched with each other. The queue mixes whoever
 * is waiting; it cannot tell who owns what.
 *
 * In memory, like the rooms: a restart empties the queue, and the players in
 * it queue again when they reconnect.
 */
export class Matchmaker {
  private readonly queues: Waiting[][];
  /** Which tier each queued wallet is in, by lower-cased address. */
  private readonly tierOf = new Map<string, number>();
  private forming = false;
  /** Wallets taken off a queue for a lobby being opened now, by lower-cased address. */
  private readonly opening = new Set<string>();
  /** Of those, the ones that asked to leave meanwhile. */
  private readonly left = new Set<string>();

  constructor(private readonly options: MatchmakerOptions) {
    this.queues = options.tiers.map(() => []);
  }

  get tiers(): readonly MatchmakingTier[] {
    return this.options.tiers;
  }

  /** Puts `player` in the tier's queue, leaving any other it was in. */
  join(player: Address, stake: string, seats: number, now = this.now()): { waiting: number } {
    const tier = this.options.tiers.findIndex((t) => t.stake === stake && t.seats === seats);
    if (tier < 0) throw new RequestError('BAD_QUEUE', 'this server runs no queue for that stake and table size');
    this.leave(player);
    const queue = this.queues[tier] as Waiting[];
    queue.push({ player, since: now });
    this.tierOf.set(addressKey(player), tier);
    this.tell(queue, tier);
    return { waiting: queue.length };
  }

  /** Takes `player` out of whichever queue it is in. True if it was in one. */
  leave(player: Address): boolean {
    const key = addressKey(player);
    if (this.opening.has(key)) this.left.add(key);
    const tier = this.tierOf.get(key);
    if (tier === undefined) return false;
    this.tierOf.delete(key);
    const queue = this.queues[tier] as Waiting[];
    const at = queue.findIndex((entry) => addressKey(entry.player) === key);
    if (at >= 0) queue.splice(at, 1);
    this.tell(queue, tier);
    return true;
  }

  /** Wallets queued in a tier now. */
  waiting(stake: string, seats: number): number {
    const tier = this.options.tiers.findIndex((t) => t.stake === stake && t.seats === seats);
    return tier < 0 ? 0 : (this.queues[tier]?.length ?? 0);
  }

  /**
   * Opens a lobby for every tier with a table ready. One pass at a time: a
   * lobby takes a block to open, and the next tick must not take the same
   * players again.
   */
  async tick(now = this.now()): Promise<void> {
    if (this.forming) return;
    this.forming = true;
    try {
      for (const [tier, queue] of this.queues.entries()) {
        const { seats, stake } = this.options.tiers[tier] as MatchmakingTier;
        const full = queue.length >= seats;
        const waitedOut =
          queue.length >= this.options.minSeats && now - (queue[0]?.since ?? now) >= (this.options.fillAfterMs ?? 30_000);
        if (!full && !waitedOut) continue;
        const table = queue.splice(0, seats);
        for (const entry of table) {
          this.tierOf.delete(addressKey(entry.player));
          this.opening.add(addressKey(entry.player));
        }
        await this.open(tier, BigInt(stake), seats, table);
      }
    } finally {
      this.forming = false;
    }
  }

  private async open(tier: number, stake: bigint, seats: number, table: Waiting[]): Promise<void> {
    const roster = table.map((entry) => entry.player);
    let matchId: `0x${string}`;
    try {
      matchId = await this.options.port.create(stake, seats, roster);
    } catch (error) {
      // Back to the front, as they were, for the next tick to try again: all
      // but whoever left, or queued elsewhere, while it was being opened.
      console.error('[matchmaker] could not open a lobby:', errorMessage(error));
      const back = table.filter((entry) => !this.left.delete(addressKey(entry.player)) && !this.tierOf.has(addressKey(entry.player)));
      for (const entry of back) this.tierOf.set(addressKey(entry.player), tier);
      (this.queues[tier] as Waiting[]).unshift(...back);
      return;
    } finally {
      for (const entry of table) {
        this.opening.delete(addressKey(entry.player));
        this.left.delete(addressKey(entry.player));
      }
    }
    console.log(`[matchmaker] opened ${matchId} for ${roster.length} players`);
    const message = { type: 'matched', matchId, stake: stake.toString(), seats } as const;
    for (const player of roster) this.options.notify(player, message);
    this.tell(this.queues[tier] as Waiting[], tier);
  }

  /** Tells everyone still in a queue how many are in it. */
  private tell(queue: readonly Waiting[], tier: number): void {
    const { stake, seats } = this.options.tiers[tier] as MatchmakingTier;
    const message = { type: 'queued', stake, seats, waiting: queue.length } as const;
    for (const entry of queue) this.options.notify(entry.player, message);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

/**
 * The tiers `MATCHMAKING_TIERS` names, as JSON:
 * `[{"stake":"1000000000000000","seats":4}]`. Soft on bad input, like
 * `SPOKES`: a malformed entry is dropped with a warning.
 */
export function parseTiers(raw: string): MatchmakingTier[] {
  if (raw.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
    return parsed.flatMap((item): MatchmakingTier[] => {
      const { stake, seats } = (item ?? {}) as Record<string, unknown>;
      if (typeof stake === 'string' && /^[1-9]\d{0,38}$/.test(stake) && typeof seats === 'number' && Number.isInteger(seats) && seats >= 2) {
        return [{ stake, seats }];
      }
      console.warn('[matchmaker] ignoring tier:', JSON.stringify(item));
      return [];
    });
  } catch (error) {
    console.warn('[matchmaker] MATCHMAKING_TIERS is not valid JSON:', errorMessage(error));
    return [];
  }
}

/** `MatchmakerPort` over viem: `createMatchmade` from the matchmaker's own sender. */
export function viemMatchmakerPort(options: {
  rpcUrl: string;
  chainId: number;
  escrow: Address;
  sender: TxSender;
}): MatchmakerPort {
  const client = readClient(options.chainId, options.rpcUrl);
  let opened = 0;
  return {
    async create(stake, seats, roster) {
      const hash: Hex = await options.sender.sendAndWait(`createMatchmade:${++opened}`, {
        address: options.escrow,
        abi: gameEscrowAbi,
        functionName: 'createMatchmade',
        args: [stake, seats, [...roster]],
      });
      const receipt = await client.getTransactionReceipt({ hash });
      const [created] = parseEventLogs({ abi: gameEscrowAbi, logs: receipt.logs, eventName: 'MatchCreated' });
      if (!created) throw new Error(`createMatchmade ${hash} opened no lobby`);
      return created.args.matchId;
    },
  };
}
