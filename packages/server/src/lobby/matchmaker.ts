import { parseEventLogs, type Address, type Hex } from 'viem';
import { addressKey } from '@lms/consensus';
import { gameEscrowAbi } from '@lms/contracts';
import { errorMessage, type LobbyInfo, type MatchmakingTier, type ServerMessage } from '@lms/api';
import { RequestError } from '../errors.js';
import type { TxSender } from '../chain/txSender.js';
import { readClient } from '../chain/viem.js';
import { fieldsOf, parseJsonList } from '../util/envList.js';

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
  /**
   * The open lobbies on the chain, the directory's. A player's own lobby at a
   * tier's stake and size takes queued players before they wait for a table
   * of their own: without it, the queue and the lobbies players open never
   * meet. Left out, the queue only ever opens matchmade lobbies.
   */
  lobbies?: () => readonly LobbyInfo[];
  /** The hub's clock in unix seconds, which join deadlines are in. Defaults to `now`. */
  chainTime?: () => number | null;
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
 * Short of a full table, a lobby a player opened at the tier's stake and size
 * with seats free takes whoever is queued: they are told its id the same way,
 * as `matched`, and stake into it. It earns no play-mining, but it is a game
 * now rather than a wait. A full queue still gets a matchmade table of its own.
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
  /**
   * Tables opened, newest last, kept for `TABLE_MEMORY_MS`: a player who
   * reloads, opens a second tab or reconnects is told again which table is
   * theirs, since the page keeps it only in memory.
   */
  private readonly tables: Array<{ matchId: `0x${string}`; stake: string; seats: number; roster: Set<string>; at: number }> = [];
  /**
   * Players sent to a player's lobby, by lower-cased match id: the seats they
   * are expected to take, so the next tick does not send more than fit.
   */
  private readonly sent = new Map<string, Array<{ player: string; at: number }>>();

  constructor(private readonly options: MatchmakerOptions) {
    this.queues = options.tiers.map(() => []);
  }

  get tiers(): readonly MatchmakingTier[] {
    return this.options.tiers;
  }

  /** Puts `player` in the tier's queue, leaving any other it was in. */
  join(player: Address, stake: string, seats: number, now = this.now()): { waiting: number } {
    const tier = this.tierFor(stake, seats);
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

  /** Where `player` is queued, with how many are in that tier now; null when it is not. */
  spotOf(player: Address): { stake: string; seats: number; waiting: number } | null {
    const tier = this.tierOf.get(addressKey(player));
    if (tier === undefined) return null;
    const { stake, seats } = this.options.tiers[tier] as MatchmakingTier;
    return { stake, seats, waiting: this.queues[tier]?.length ?? 0 };
  }

  /** The tables this matchmaker put `player` at recently, newest first, as `matched` announced them. */
  tablesOf(player: Address, now = this.now()): Array<{ matchId: `0x${string}`; stake: string; seats: number }> {
    const key = addressKey(player);
    return this.tables
      .filter((table) => table.roster.has(key) && now - table.at < TABLE_MEMORY_MS)
      .reverse()
      .map(({ matchId, stake, seats }) => ({ matchId, stake, seats }));
  }

  /** Wallets queued in a tier now. */
  waiting(stake: string, seats: number): number {
    const tier = this.tierFor(stake, seats);
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
        // A full table is a matchmade one, which earns play-mining; short of
        // that, an open lobby with room beats waiting.
        if (!full) this.seatInOpenLobbies(tier, now);
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

  private async open(tier: number, stake: bigint, tierSeats: number, table: Waiting[]): Promise<void> {
    const roster = table.map((entry) => entry.player);
    // A short table has as many seats as players: the escrow locks a lobby
    // once it is full or its window is over, and seats only its roster can
    // take would hold everyone for the whole window.
    const seats = Math.min(tierSeats, roster.length);
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
    this.remember(matchId, stake.toString(), seats, roster, this.now());
    const message = { type: 'matched', matchId, stake: stake.toString(), seats } as const;
    for (const player of roster) this.options.notify(player, message);
    this.tell(this.queues[tier] as Waiting[], tier);
  }

  /**
   * Sends queued players of `tier` to open lobbies players opened at its
   * stake and size, as many as each has seats free, first in line first.
   */
  private seatInOpenLobbies(tier: number, now: number): void {
    const lobbies = this.options.lobbies?.() ?? [];
    const queue = this.queues[tier] as Waiting[];
    const { stake, seats } = this.options.tiers[tier] as MatchmakingTier;
    const chainNow = this.options.chainTime?.() ?? Math.floor(now / 1000);
    for (const lobby of lobbies) {
      if (queue.length === 0) break;
      if (lobby.status !== 'open' || lobby.matchmade || lobby.stake !== stake || lobby.maxSeats !== seats) continue;
      // Too little of its window left to stake in: sending anyone there only wastes their wait.
      if (lobby.joinDeadline - chainNow < MIN_WINDOW_LEFT_S) continue;
      const id = addressKey(lobby.matchId);
      const seated = new Set(lobby.players.map((player) => addressKey(player.address)));
      // Sent lately and not seated yet: their seats are spoken for.
      const pending = (this.sent.get(id) ?? []).filter((entry) => !seated.has(entry.player) && now - entry.at < SEAT_HOLD_MS);
      let free = lobby.maxSeats - lobby.seatCount - pending.length;
      const picked: Waiting[] = [];
      for (const entry of queue) {
        if (free <= 0) break;
        if (seated.has(addressKey(entry.player))) continue;
        picked.push(entry);
        free -= 1;
      }
      this.sent.set(id, [...pending, ...picked.map((entry) => ({ player: addressKey(entry.player), at: now }))]);
      if (picked.length === 0) continue;
      for (const entry of picked) {
        queue.splice(queue.indexOf(entry), 1);
        this.tierOf.delete(addressKey(entry.player));
      }
      console.log(`[matchmaker] sent ${picked.length} to open lobby ${lobby.matchId}`);
      const roster = picked.map((entry) => entry.player);
      this.remember(lobby.matchId, stake, seats, roster, now);
      const message = { type: 'matched', matchId: lobby.matchId, stake, seats } as const;
      for (const player of roster) this.options.notify(player, message);
      this.tell(queue, tier);
    }
    // A lobby no longer open is gone for good: forget who was sent there.
    const listed = new Set(lobbies.map((lobby) => addressKey(lobby.matchId)));
    for (const id of this.sent.keys()) if (!listed.has(id)) this.sent.delete(id);
  }

  /** Keeps a table for its roster, to be told again after a reload: see `tablesOf`. */
  private remember(matchId: `0x${string}`, stake: string, seats: number, roster: readonly Address[], now: number): void {
    while (this.tables.length > 0 && now - (this.tables[0]?.at ?? now) >= TABLE_MEMORY_MS) this.tables.shift();
    this.tables.push({ matchId, stake, seats, roster: new Set(roster.map(addressKey)), at: now });
  }

  /** The index of the tier for `stake` and `seats`, or -1 for none. */
  private tierFor(stake: string, seats: number): number {
    return this.options.tiers.findIndex((tier) => tier.stake === stake && tier.seats === seats);
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

/** How long a table is remembered for its roster: longer than any join window and lock grace. */
const TABLE_MEMORY_MS = 2 * 3_600_000;

/** The least join window an open lobby must have left for queued players to be sent to it. */
const MIN_WINDOW_LEFT_S = 60;

/**
 * How long a seat in an open lobby is held for a player sent to it: time to
 * see the notice and stake. Unstaked by then, the seat goes to whoever is next.
 */
const SEAT_HOLD_MS = 90_000;

/**
 * The tiers `MATCHMAKING_TIERS` names, as JSON:
 * `[{"stake":"1000000000000000","seats":4}]`. Soft on bad input, like
 * `SPOKES`: a malformed entry is dropped with a warning.
 */
export function parseTiers(raw: string): MatchmakingTier[] {
  return parseJsonList(raw, 'MATCHMAKING_TIERS', 'matchmaker', (item) => {
    const { stake, seats } = fieldsOf(item) ?? {};
    if (typeof stake !== 'string' || !/^[1-9]\d{0,38}$/.test(stake)) return null;
    if (typeof seats !== 'number' || !Number.isInteger(seats) || seats < 2) return null;
    return { stake, seats };
  });
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
