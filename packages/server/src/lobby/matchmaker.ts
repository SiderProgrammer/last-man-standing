import { parseEventLogs, type Address, type Hex } from 'viem';
import { addressKey } from '@lms/consensus';
import { gameEscrowAbi } from '@lms/contracts';
import { errorMessage, type LobbyInfo, type QueueRange, type ServerMessage } from '@lms/api';
import { RequestError } from '../errors.js';
import type { TxSender } from '../chain/txSender.js';
import { readClient } from '../chain/viem.js';

/** Opens a matchmade lobby on the escrow and says which match it is. */
export interface MatchmakerPort {
  create(stake: bigint, seats: number, roster: readonly Address[]): Promise<`0x${string}`>;
}

export interface MatchmakerOptions {
  port: MatchmakerPort;
  /** Fewest players a table starts with: the rules' and the escrow's `minSeats`. */
  minSeats: number;
  /** Most seats a table can have: the rules' `maxPlayers`. */
  maxSeats: number;
  /**
   * Once a player has waited this long, a table is opened with however many
   * queued players fit it, if that is enough to start, rather than waiting
   * for it to fill. Defaults to 30 s.
   */
  fillAfterMs?: number;
  /** Tells one wallet something, on every socket it is logged in on. */
  notify: (player: Address, message: ServerMessage) => void;
  /**
   * The open lobbies on the chain, the directory's. A player's own lobby
   * whose stake and size fall in a queued player's ranges takes them before
   * they wait for a table of their own: without it, the queue and the
   * lobbies players open never meet. Left out, the queue only ever opens
   * matchmade lobbies.
   */
  lobbies?: () => readonly LobbyInfo[];
  /** The hub's clock in unix seconds, which join deadlines are in. Defaults to `now`. */
  chainTime?: () => number | null;
  now?: () => number;
}

interface Waiting {
  player: Address;
  key: string;
  since: number;
  range: QueueRange;
  minStake: bigint;
  maxStake: bigint;
}

/** A table put together from the queue: who, at what stake and size. */
interface Table {
  players: Waiting[];
  stake: bigint;
  seats: number;
  /** As many players as every one of them would seat. */
  full: boolean;
  /** Enough players for a match to start. */
  enough: boolean;
}

/**
 * The matchmaking queue. Each wallet in it says what it will play: a stake
 * range and a table-size range.
 *
 * Players whose ranges overlap are put together, oldest first. A table opens
 * at the lowest stake every player at it accepts, with as many seats as
 * players. Once it is full — as many players as the smallest `maxSeats`
 * among them — or the first of them has waited `fillAfterMs` with enough to
 * start, it takes them off the queue, has the escrow open a matchmade lobby
 * with exactly them on its roster, and tells each one the lobby's id. Each
 * then stakes into it like any other lobby, by any route; the escrow seats
 * nobody else. Only matchmade lobbies earn play-mining.
 *
 * Short of a full table, a lobby a player opened whose stake and size fall
 * in a queued player's ranges takes them: they are told its id the same way,
 * as `matched`, and stake into it. It earns no play-mining, but it is a game
 * now rather than a wait. A full table still gets a matchmade lobby of its own.
 *
 * Tables are put together greedily, not optimally: the oldest player's
 * table takes whoever fits it first, in the order they queued.
 *
 * What this does not stop is several wallets with one owner queueing at once
 * in a quiet range and being matched with each other. The queue mixes
 * whoever is waiting; it cannot tell who owns what.
 *
 * In memory, like the rooms: a restart empties the queue, and the players in
 * it queue again when they reconnect.
 */
export class Matchmaker {
  /** Everyone queued, oldest first. */
  private queue: Waiting[] = [];
  private forming = false;
  /** Wallets taken off the queue for a lobby being opened now, by lower-cased address. */
  private readonly opening = new Set<string>();
  /** Of those, the ones that asked to leave meanwhile. */
  private readonly left = new Set<string>();
  /** The last `queued` each wallet was sent, so a count that did not change is not sent again. */
  private readonly lastTold = new Map<string, string>();
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

  constructor(private readonly options: MatchmakerOptions) {}

  /**
   * Puts `player` in the queue for `range`, replacing any place it had. The
   * table sizes are narrowed to the ones a match can have; a range left
   * empty is refused.
   */
  join(player: Address, range: QueueRange, now = this.now()): { waiting: number } {
    const minStake = BigInt(range.minStake);
    const maxStake = BigInt(range.maxStake);
    if (minStake <= 0n || minStake > maxStake) throw new RequestError('BAD_QUEUE', 'the stake range is empty');
    const minSeats = Math.max(range.minSeats, this.options.minSeats);
    const maxSeats = Math.min(range.maxSeats, this.options.maxSeats);
    if (minSeats > maxSeats) {
      throw new RequestError(
        'BAD_QUEUE',
        `tables have ${this.options.minSeats} to ${this.options.maxSeats} seats; that range has none of them`,
      );
    }
    this.leave(player);
    const key = addressKey(player);
    const entry: Waiting = {
      player,
      key,
      since: now,
      range: { minStake: minStake.toString(), maxStake: maxStake.toString(), minSeats, maxSeats },
      minStake,
      maxStake,
    };
    this.queue.push(entry);
    // The joiner hears where it is even if nothing changed for anyone else.
    this.lastTold.delete(key);
    this.tellAll();
    return { waiting: this.countFor(entry) };
  }

  /** Takes `player` out of the queue. True if it was in it. */
  leave(player: Address): boolean {
    const key = addressKey(player);
    if (this.opening.has(key)) this.left.add(key);
    const at = this.queue.findIndex((entry) => entry.key === key);
    if (at < 0) return false;
    this.queue.splice(at, 1);
    this.lastTold.delete(key);
    this.tellAll();
    return true;
  }

  /** What `player` queued for, with how many it could be matched with now; null when it is not queued. */
  spotOf(player: Address): (QueueRange & { waiting: number }) | null {
    const key = addressKey(player);
    const entry = this.queue.find((waiting) => waiting.key === key);
    return entry ? { ...entry.range, waiting: this.countFor(entry) } : null;
  }

  /** The tables this matchmaker put `player` at recently, newest first, as `matched` announced them. */
  tablesOf(player: Address, now = this.now()): Array<{ matchId: `0x${string}`; stake: string; seats: number }> {
    const key = addressKey(player);
    return this.tables
      .filter((table) => table.roster.has(key) && now - table.at < TABLE_MEMORY_MS)
      .reverse()
      .map(({ matchId, stake, seats }) => ({ matchId, stake, seats }));
  }

  /** Wallets queued now, whatever their ranges. */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Puts tables together and opens them: first every full one, which earns
   * play-mining; then open lobbies take whoever fits them; then tables for
   * whoever has waited long enough. One pass at a time: a lobby takes a
   * block to open, and the next tick must not take the same players again.
   */
  async tick(now = this.now()): Promise<void> {
    if (this.forming) return;
    this.forming = true;
    try {
      const ready = this.takeTables(() => true, (table) => table.full);
      this.seatInOpenLobbies(now);
      const fillAfterMs = this.options.fillAfterMs ?? 30_000;
      ready.push(...this.takeTables((anchor) => now - anchor.since >= fillAfterMs, (table) => table.enough));
      if (ready.length > 0) this.tellAll();
      for (const table of ready) await this.open(table);
    } finally {
      this.forming = false;
    }
  }

  /**
   * Takes off the queue each table that `take` accepts, put together around
   * each player `anchors` picks, oldest first.
   */
  private takeTables(anchors: (anchor: Waiting) => boolean, take: (table: Table) => boolean): Table[] {
    const taken: Table[] = [];
    let i = 0;
    while (i < this.queue.length) {
      const anchor = this.queue[i] as Waiting;
      const table = anchors(anchor) ? this.tableFor(anchor) : null;
      if (!table || !take(table)) {
        i += 1;
        continue;
      }
      // The anchor leaves with its table, so whoever is next moves into its place at `i`.
      const seated = new Set(table.players.map((entry) => entry.key));
      this.queue = this.queue.filter((entry) => !seated.has(entry.key));
      for (const key of seated) {
        this.opening.add(key);
        this.lastTold.delete(key);
      }
      taken.push(table);
    }
    return taken;
  }

  /**
   * The table around `anchor`: whoever else is queued and fits it, in queue
   * order, narrowing the stake and size every one of them accepts, until it
   * is as big as all of them allow.
   */
  private tableFor(anchor: Waiting): Table {
    const players = [anchor];
    let { minStake, maxStake } = anchor;
    let { minSeats, maxSeats } = anchor.range;
    for (const entry of this.queue) {
      if (players.length >= maxSeats) break;
      if (entry === anchor) continue;
      const low = entry.minStake > minStake ? entry.minStake : minStake;
      const high = entry.maxStake < maxStake ? entry.maxStake : maxStake;
      const fewest = Math.max(minSeats, entry.range.minSeats);
      const most = Math.min(maxSeats, entry.range.maxSeats);
      if (low > high || fewest > most || players.length + 1 > most) continue;
      players.push(entry);
      minStake = low;
      maxStake = high;
      minSeats = fewest;
      maxSeats = most;
    }
    return {
      players,
      stake: minStake,
      seats: players.length,
      full: players.length >= maxSeats,
      enough: players.length >= Math.max(minSeats, this.options.minSeats),
    };
  }

  private async open(table: Table): Promise<void> {
    const roster = table.players.map((entry) => entry.player);
    let matchId: `0x${string}`;
    try {
      // A short table has as many seats as players: the escrow locks a lobby
      // once it is full or its window is over, and seats only its roster can
      // take would hold everyone for the whole window.
      matchId = await this.options.port.create(table.stake, table.seats, roster);
    } catch (error) {
      // Back in the queue, in their places, for the next tick to try again:
      // all but whoever left, or queued again, while it was being opened.
      console.error('[matchmaker] could not open a lobby:', errorMessage(error));
      const back = table.players.filter((entry) => !this.left.has(entry.key) && !this.queue.some((other) => other.key === entry.key));
      this.queue = [...back, ...this.queue].sort((a, b) => a.since - b.since);
      this.tellAll();
      return;
    } finally {
      for (const entry of table.players) {
        this.opening.delete(entry.key);
        this.left.delete(entry.key);
      }
    }
    console.log(`[matchmaker] opened ${matchId} for ${roster.length} players at ${table.stake} wei`);
    this.remember(matchId, table.stake.toString(), table.seats, roster, this.now());
    const message = { type: 'matched', matchId, stake: table.stake.toString(), seats: table.seats } as const;
    for (const player of roster) this.options.notify(player, message);
  }

  /**
   * Sends queued players to open lobbies players opened, at a stake and size
   * in their ranges, as many as each has seats free, first in line first.
   */
  private seatInOpenLobbies(now: number): void {
    const lobbies = this.options.lobbies?.() ?? [];
    const chainNow = this.options.chainTime?.() ?? Math.floor(now / 1000);
    let changed = false;
    for (const lobby of lobbies) {
      if (this.queue.length === 0) break;
      if (lobby.status !== 'open' || lobby.matchmade) continue;
      // Too little of its window left to stake in: sending anyone there only wastes their wait.
      if (lobby.joinDeadline - chainNow < MIN_WINDOW_LEFT_S) continue;
      const stake = BigInt(lobby.stake);
      const id = addressKey(lobby.matchId);
      const seated = new Set(lobby.players.map((player) => addressKey(player.address)));
      // Sent lately and not seated yet: their seats are spoken for.
      const pending = (this.sent.get(id) ?? []).filter((entry) => !seated.has(entry.player) && now - entry.at < SEAT_HOLD_MS);
      let free = lobby.maxSeats - lobby.seatCount - pending.length;
      const picked: Waiting[] = [];
      for (const entry of this.queue) {
        if (free <= 0) break;
        if (seated.has(entry.key)) continue;
        if (stake < entry.minStake || stake > entry.maxStake) continue;
        if (lobby.maxSeats < entry.range.minSeats || lobby.maxSeats > entry.range.maxSeats) continue;
        picked.push(entry);
        free -= 1;
      }
      this.sent.set(id, [...pending, ...picked.map((entry) => ({ player: entry.key, at: now }))]);
      if (picked.length === 0) continue;
      const keys = new Set(picked.map((entry) => entry.key));
      this.queue = this.queue.filter((entry) => !keys.has(entry.key));
      for (const key of keys) this.lastTold.delete(key);
      changed = true;
      console.log(`[matchmaker] sent ${picked.length} to open lobby ${lobby.matchId}`);
      const roster = picked.map((entry) => entry.player);
      this.remember(lobby.matchId, lobby.stake, lobby.maxSeats, roster, now);
      const message = { type: 'matched', matchId: lobby.matchId, stake: lobby.stake, seats: lobby.maxSeats } as const;
      for (const player of roster) this.options.notify(player, message);
    }
    if (changed) this.tellAll();
    // A lobby no longer open is gone for good: forget who was sent there.
    const listed = new Set(lobbies.map((lobby) => addressKey(lobby.matchId)));
    for (const id of this.sent.keys()) if (!listed.has(id)) this.sent.delete(id);
  }

  /** Keeps a table for its roster, to be told again after a reload: see `tablesOf`. */
  private remember(matchId: `0x${string}`, stake: string, seats: number, roster: readonly Address[], now: number): void {
    while (this.tables.length > 0 && now - (this.tables[0]?.at ?? now) >= TABLE_MEMORY_MS) this.tables.shift();
    this.tables.push({ matchId, stake, seats, roster: new Set(roster.map(addressKey)), at: now });
  }

  /** Wallets queued now whose ranges overlap `entry`'s, it included. */
  private countFor(entry: Waiting): number {
    return this.queue.filter((other) => overlaps(entry, other)).length;
  }

  /** Tells everyone queued how many they could be matched with, when that changed. */
  private tellAll(): void {
    for (const entry of this.queue) {
      const message = { type: 'queued', ...entry.range, waiting: this.countFor(entry) } as const;
      const said = JSON.stringify(message);
      if (this.lastTold.get(entry.key) === said) continue;
      this.lastTold.set(entry.key, said);
      this.options.notify(entry.player, message);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

/** Whether two queued players could sit at one table: their stake ranges and size ranges overlap. */
function overlaps(a: Waiting, b: Waiting): boolean {
  return (
    a.minStake <= b.maxStake &&
    b.minStake <= a.maxStake &&
    a.range.minSeats <= b.range.maxSeats &&
    b.range.minSeats <= a.range.maxSeats
  );
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
