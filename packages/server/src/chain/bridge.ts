import type { Address, Hex } from 'viem';
import {
  DEFAULT_RULES,
  MatchStatus,
  addressKey,
  errorMessage,
  normaliseOriginChainId,
  type LobbyInfo,
  type LobbySeat,
  type Seat,
} from '@lms/protocol';
import type { MatchSetup } from '@lms/engine';
import type { Lobby } from '../rooms/lobby.js';
import { viemEscrowReader, type EscrowReader } from './escrowReader.js';

export interface ChainBridgeOptions {
  rpcUrl: string;
  chainId: number;
  escrow: Address;
  lobby: Lobby;
  /** Funds the permissionless `lockMatch` call. Without it, someone else must lock. */
  keeperKey?: Hex;
  pollMs?: number;
}

/** What the bridge needs once the transport has been chosen. */
export interface ChainBridgeDeps {
  reader: EscrowReader;
  lobby: Lobby;
  /** Hub chain id, used to map a seat's origin out of the messenger's id space. */
  chainId: number;
  pollMs?: number;
  /** Injectable clock, so the lock window can be tested without waiting. */
  now?: () => number;
}

interface TrackedMatch {
  info: LobbyInfo;
  adopted: boolean;
  /**
   * Chain each seat staked from, keyed by lowercased address and already
   * normalised to an EVM chain id. Filled from `PlayerJoined` as it is seen and
   * back-filled by a read for a seat that joined before this server started
   * watching. An origin never changes, so it is only ever resolved once.
   */
  origins: Map<string, number>;
}

/**
 * Keeps the server's view of the escrow up to date.
 *
 * One polling loop does three jobs: it discovers new lobbies from
 * `MatchCreated`, it advertises their state to clients, and it opens a room the
 * moment a match goes `Live`. Going through a single loop rather than a web of
 * event subscriptions means the server converges on the chain's view even if it
 * missed a block, restarted, or watched through a flaky RPC.
 *
 * A room is only ever opened for a `Live` match, which is the first moment the
 * randomness oracle has answered for a locked seat list. The server therefore
 * cannot start play before the seed exists, and cannot pick moves against rolls
 * it already knows.
 */
export class ChainBridge {
  private readonly tracked = new Map<string, TrackedMatch>();
  private readonly reader: EscrowReader;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cursor: bigint | null = null;
  private polling = false;

  constructor(private readonly deps: ChainBridgeDeps) {
    this.reader = deps.reader;
    this.now = deps.now ?? Date.now;
  }

  /** Builds a bridge over a real RPC and starts its poll loop. */
  static start(options: ChainBridgeOptions): ChainBridge {
    const bridge = new ChainBridge({
      reader: viemEscrowReader({
        rpcUrl: options.rpcUrl,
        chainId: options.chainId,
        escrow: options.escrow,
        ...(options.keeperKey ? { keeperKey: options.keeperKey } : {}),
      }),
      lobby: options.lobby,
      chainId: options.chainId,
    });
    void bridge.poll();
    bridge.timer = setInterval(() => void bridge.poll(), options.pollMs ?? 4_000);
    bridge.timer.unref?.();
    return bridge;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Lobby directory served to clients. */
  directory(): { open: LobbyInfo[]; live: LobbyInfo[] } {
    const open: LobbyInfo[] = [];
    const live: LobbyInfo[] = [];
    for (const entry of this.tracked.values()) {
      if (entry.info.status === 'open') open.push(entry.info);
      else live.push(entry.info);
    }
    return { open, live };
  }

  async poll(): Promise<void> {
    // Overlapping polls would double-submit keeper transactions.
    if (this.polling) return;
    this.polling = true;
    try {
      await this.discover();
      await this.refresh();
    } catch (error) {
      console.error('[chain] poll failed:', errorMessage(error));
    } finally {
      this.polling = false;
    }
  }

  private async discover(): Promise<void> {
    const latest = await this.reader.blockNumber();
    // First pass starts a little way back so a restart still sees a fresh lobby.
    const from = this.cursor ?? (latest > 5_000n ? latest - 5_000n : 0n);
    if (from > latest) return;

    for (const { matchId } of await this.reader.matchCreatedLogs(from, latest)) {
      const key = matchId.toLowerCase();
      if (this.tracked.has(key)) continue;
      this.tracked.set(key, { adopted: false, info: placeholder(matchId), origins: new Map() });
    }

    // Joins are read from the log rather than by polling `seatOrigin` per seat:
    // the event already carries the origin, and an origin never changes.
    for (const join of await this.reader.playerJoinedLogs(from, latest)) {
      const entry = this.tracked.get(join.matchId.toLowerCase());
      if (!entry) continue;
      entry.origins.set(
        addressKey(join.player),
        normaliseOriginChainId(join.originChainId, this.deps.chainId),
      );
    }

    this.cursor = latest + 1n;
  }

  private async refresh(): Promise<void> {
    for (const [key, entry] of this.tracked) {
      const matchId = entry.info.matchId;
      const raw = await this.reader.getMatch(matchId);

      if (raw.status === MatchStatus.Settled || raw.status === MatchStatus.Cancelled) {
        this.tracked.delete(key);
        continue;
      }

      const players = await this.reader.getSeats(matchId);

      const seats: LobbySeat[] = [];
      for (const address of players) {
        seats.push({ address, chainId: await this.originOf(entry, matchId, address) });
      }

      entry.info = {
        matchId,
        stake: raw.stake.toString(),
        seatCount: raw.seatCount,
        maxSeats: raw.maxSeats,
        minSeats: raw.minSeats,
        joinDeadline: Number(raw.joinDeadline),
        status: raw.status === MatchStatus.Open ? 'open' : raw.status === MatchStatus.Pending ? 'pending' : 'live',
        players: seats,
      };

      if (raw.status === MatchStatus.Open) {
        await this.maybeLock(entry.info);
      } else if (raw.status === MatchStatus.Live && !entry.adopted) {
        entry.adopted = true;
        this.adopt(matchId, raw.seed, seats);
      }
    }
  }

  /**
   * Locking is permissionless, so the keeper is a convenience rather than a
   * trusted role: if it is offline, any player can lock the lobby themselves.
   */
  private async maybeLock(info: LobbyInfo): Promise<void> {
    const full = info.seatCount >= info.maxSeats;
    const expired = Math.floor(this.now() / 1000) >= info.joinDeadline;
    if (!full && !expired) return;
    if (info.seatCount < info.minSeats) return;

    if (await this.reader.lockMatch(info.matchId)) {
      console.log(`[chain] locked ${info.matchId}`);
    }
  }

  /**
   * Resolves which chain a seat staked from, reading the escrow only for a seat
   * whose join event fell outside the backfill window.
   */
  private async originOf(
    entry: TrackedMatch,
    matchId: `0x${string}`,
    address: Address,
  ): Promise<number> {
    const key = addressKey(address);
    const known = entry.origins.get(key);
    if (known !== undefined) return known;

    const origin = await this.reader.seatOrigin(matchId, address);
    // Zero means the player staked on the hub chain itself; anything else is in
    // the messenger's id space and has to be mapped back to a chain id.
    const chainId = normaliseOriginChainId(origin, this.deps.chainId);
    entry.origins.set(key, chainId);
    return chainId;
  }

  private adopt(matchId: `0x${string}`, seed: `0x${string}`, lobbySeats: readonly LobbySeat[]): void {
    const seats: Seat[] = lobbySeats.map((seat, index) => ({
      index,
      address: seat.address,
      chainId: seat.chainId,
    }));

    const setup: MatchSetup = { matchId, seats, seed, rules: DEFAULT_RULES };
    this.deps.lobby.adopt(setup);
    console.log(`[chain] opened room for ${matchId} with ${seats.length} seats`);
  }
}

function placeholder(matchId: `0x${string}`): LobbyInfo {
  return {
    matchId,
    stake: '0',
    seatCount: 0,
    maxSeats: 0,
    minSeats: 0,
    joinDeadline: 0,
    status: 'open',
    players: [],
  };
}

