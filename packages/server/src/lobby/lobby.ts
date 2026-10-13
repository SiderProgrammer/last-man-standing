import { randomBytes, createHash } from 'node:crypto';
import { keccak256, toHex } from 'viem';
import {
  DEFAULT_RULES,
  PRACTICE_CHAIN_ID,
  ZERO_ADDRESS,
  deriveMatchId,
  errorMessage,
  tallyStyles,
  type MatchResult,
  type RoundRecord,
  type Rules,
  type Seat,
} from '@lms/protocol';
import type { MatchSetup } from '@lms/engine';
import { Room, type Client, type RoomOptions } from '../match/room.js';
import type { AvatarRegistry } from '../chain/avatars.js';
import type { MatchArchive } from './store.js';
import type { RoundJournal } from './journal.js';
import type { StyleBook } from './styles.js';
import type { Relayer } from '../chain/attestor.js';

export interface LobbyOptions {
  archive: MatchArchive;
  relayer: Relayer;
  commitMs: number;
  revealMs: number;
  /** Pause after each round for the client-side replay. Defaults to none. */
  replayMs?: number;
  rules?: Rules;
  /** Resolves the NFT avatars seats are wearing. Omitted, nobody wears one. */
  avatars?: AvatarRegistry;
  /** Persists staked rooms so a restart can resume them. Omitted, nothing survives one. */
  journal?: RoundJournal;
  /** Ceiling on practice rooms across all wallets. Defaults to 200. */
  maxPracticeRooms?: number;
  /** Play styles by wallet, for the reads panel. Omitted, nobody has a record. */
  styles?: StyleBook;
}

const DEFAULT_MAX_PRACTICE_ROOMS = 200;

/**
 * Registry of live rooms.
 *
 * Practice lobbies are created on demand and never touch the chain. Staked
 * lobbies are adopted from an on-chain `MatchStarted` event, which is what
 * fixes the seed: the server cannot start a match before the oracle has
 * answered, so it can never pick moves against known rolls.
 */
export class Lobby {
  private readonly rooms = new Map<string, Room>();
  /** The one practice room each wallet may hold, keyed by address. */
  private readonly practiceOf = new Map<string, string>();
  private practiceNonce = 0n;

  constructor(private readonly options: LobbyOptions) {}

  get size(): number {
    return this.rooms.size;
  }

  list(): Room[] {
    return [...this.rooms.values()];
  }

  get(matchId: `0x${string}`): Room | null {
    return this.rooms.get(matchId.toLowerCase()) ?? null;
  }

  /** The room a wallet currently holds a seat in, if any. */
  roomFor(address: `0x${string}`): Room | null {
    for (const room of this.rooms.values()) {
      if (room.seatOf(address) !== null && !room.finished) return room;
    }
    return null;
  }

  /**
   * Opens a practice room against house bots.
   *
   * One per wallet: asking for another ends the previous one, which is what a
   * player clicking "practice" again means anyway. And a global ceiling, so a
   * flood of fresh wallets cannot grow the room table without bound — each room
   * holds a match, a bot driver and a timer.
   */
  createPractice(human: `0x${string}`, opponents: number, now: number = Date.now()): Room {
    const owner = human.toLowerCase();
    const previous = this.practiceOf.get(owner);
    if (previous) {
      this.rooms.delete(previous);
      this.practiceOf.delete(owner);
    }
    const ceiling = this.options.maxPracticeRooms ?? DEFAULT_MAX_PRACTICE_ROOMS;
    if (this.practiceOf.size >= ceiling) {
      throw new Error('the server is at its practice-room limit; try again shortly');
    }

    const rules = this.options.rules ?? DEFAULT_RULES;
    const seatCount = clamp(opponents + 1, rules.minPlayers, rules.maxPlayers);
    const matchId = deriveMatchId(PRACTICE_CHAIN_ID, ZERO_ADDRESS, this.practiceNonce++);
    const seats: Seat[] = Array.from({ length: seatCount }, (_, index) => ({
      index,
      address: index === 0 ? human : botAddress(matchId, index),
      chainId: PRACTICE_CHAIN_ID,
    }));

    const setup: MatchSetup = {
      matchId,
      seats,
      seed: keccak256(toHex(randomBytes(32))),
      rules,
    };

    const room = this.open(
      setup,
      Array.from({ length: seatCount - 1 }, (_, i) => i + 1),
      now,
      false,
    );
    this.practiceOf.set(owner, room.matchId.toLowerCase());
    return room;
  }

  /** Starts a room for a match whose stakes are already escrowed on-chain. */
  adopt(setup: MatchSetup, botSeats: readonly number[] = [], now: number = Date.now()): Room {
    const existing = this.get(setup.matchId);
    if (existing) return existing;
    return this.open(setup, botSeats, now, true);
  }

  /**
   * Rebuilds every staked room the journal still holds, after a restart.
   * Returns how many came back. A room that fails to replay is dropped from
   * the journal and logged: its escrow still refunds everyone at the deadline.
   */
  async restore(now: number = Date.now()): Promise<number> {
    const journal = this.options.journal;
    if (!journal) return 0;
    let restored = 0;
    for (const entry of await journal.live()) {
      try {
        const room = Room.restore(
          entry.setup,
          this.roomOptions(entry.botSeats, entry.setup.matchId, true),
          entry.openedAt,
          entry.events,
          now,
        );
        this.rooms.set(room.matchId.toLowerCase(), room);
        void this.decorate(room, entry.setup);
        void this.brief(room, entry.setup);
        restored += 1;
      } catch (error) {
        console.error(`[lobby] could not restore ${entry.setup.matchId}:`, errorMessage(error));
        journal.close(entry.setup.matchId);
      }
    }
    return restored;
  }

  tick(now: number = Date.now()): void {
    for (const [key, room] of this.rooms) {
      room.tick(now);
      // Finished rooms stay reachable for one sweep so late clients can read
      // the final state, then they are dropped.
      if (room.finished && now > room.deadline + 60_000) {
        this.rooms.delete(key);
        for (const [owner, matchKey] of this.practiceOf) {
          if (matchKey === key) this.practiceOf.delete(owner);
        }
      }
    }
  }

  attach(matchId: `0x${string}`, client: Client): Room {
    const room = this.get(matchId);
    if (!room) throw new Error('unknown match');
    room.attach(client);
    return room;
  }

  /**
   * @param staked Whether the room holds escrowed stakes. Only those are
   *        journaled and settled: a practice room lost to a restart costs
   *        nobody anything.
   */
  private open(setup: MatchSetup, botSeats: readonly number[], now: number, staked: boolean): Room {
    if (staked) {
      this.options.journal?.open(setup.matchId, { setup, botSeats: [...botSeats], openedAt: now });
    }
    const room = new Room(setup, this.roomOptions(botSeats, setup.matchId, staked), now);
    this.rooms.set(room.matchId.toLowerCase(), room);
    void this.decorate(room, setup);
    if (staked) void this.brief(room, setup);
    return room;
  }

  /**
   * Looks up what the table's wallets have done before. Off the match's
   * critical path, like avatars: the first round never waits on a database.
   */
  private async brief(room: Room, setup: MatchSetup): Promise<void> {
    const book = this.options.styles;
    if (!book) return;
    try {
      const styles = await book.lookup(setup.seats.map((seat) => seat.address));
      room.setDossier(
        setup.seats.flatMap((seat) => {
          const style = styles.get(seat.address.toLowerCase());
          return style ? [{ address: seat.address, style }] : [];
        }),
      );
    } catch (error) {
      console.warn('[lobby] style lookup failed:', errorMessage(error));
    }
  }

  private roomOptions(botSeats: readonly number[], matchId: `0x${string}`, staked: boolean): RoomOptions {
    const journal = staked ? this.options.journal : undefined;
    return {
      commitMs: this.options.commitMs,
      revealMs: this.options.revealMs,
      replayMs: this.options.replayMs ?? 0,
      botSeats,
      onFinished: (result, history) => {
        void this.finalise(result, history, staked);
      },
      ...(journal ? { journal: (event) => journal.append(matchId, event) } : {}),
    };
  }

  /**
   * Resolves avatars in the background.
   *
   * Deliberately not awaited: the room is already playable and the first commit
   * window is already open. An avatar arriving a second later costs nothing,
   * whereas making the match wait on an IPFS gateway would let a slow one
   * eat into the round clock.
   */
  private async decorate(room: Room, setup: MatchSetup): Promise<void> {
    const registry = this.options.avatars;
    if (!registry || registry.empty) return;

    try {
      room.setAvatars(await registry.resolve(setup.seats));
    } catch (error) {
      // Cosmetic: a failure here must never surface to the players.
      console.warn('[lobby] avatar resolution failed:', errorMessage(error));
    }
  }

  private async finalise(
    result: MatchResult,
    history: readonly RoundRecord[],
    staked: boolean,
  ): Promise<void> {
    let settledTx: string | null = null;
    try {
      settledTx = await this.options.relayer.settle(result, history);
    } catch (error) {
      // A failed settlement is recoverable: the escrow stays `Live` until the
      // deadline, so the result can be resubmitted or the match cancelled.
      console.error('[lobby] settlement failed', errorMessage(error));
    }
    await this.options.archive.save({ result, history, settledTx });
    if (staked && this.options.styles) {
      const seats = this.get(result.matchId)?.match.seats.map((seat) => seat.address) ?? [];
      try {
        await this.options.styles.record(tallyStyles(result, history, seats));
      } catch (error) {
        console.warn('[lobby] style record failed:', errorMessage(error));
      }
    }
    if (staked) {
      this.options.journal?.close(result.matchId);
      this.get(result.matchId)?.announceSettled(settledTx as `0x${string}` | null);
    }
  }
}

function botAddress(matchId: `0x${string}`, seat: number): `0x${string}` {
  const digest = createHash('sha256').update(`${matchId}:${seat}`).digest('hex');
  return `0x${digest.slice(0, 40)}` as `0x${string}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}


