import { randomBytes, createHash } from 'node:crypto';
import { keccak256, toHex } from 'viem';
import {
  DEFAULT_RULES,
  PRACTICE_CHAIN_ID,
  ZERO_ADDRESS,
  deriveMatchId,
  errorMessage,
  type Rules,
  type Seat,
} from '@lms/protocol';
import type { MatchSetup } from '@lms/engine';
import { Room, type Client, type RoomOptions } from './room.js';
import type { AvatarRegistry } from './avatars.js';
import type { MatchArchive } from './store.js';
import type { Relayer } from './attestor.js';

export interface LobbyOptions {
  archive: MatchArchive;
  relayer: Relayer;
  commitMs: number;
  revealMs: number;
  startingChips: number;
  rules?: Rules;
  /** Resolves the NFT avatars seats are wearing. Omitted, nobody wears one. */
  avatars?: AvatarRegistry;
}

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

  createPractice(human: `0x${string}`, opponents: number, now: number = Date.now()): Room {
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

    return this.open(
      setup,
      Array.from({ length: seatCount - 1 }, (_, i) => i + 1),
      now,
    );
  }

  /** Starts a room for a match whose stakes are already escrowed on-chain. */
  adopt(setup: MatchSetup, botSeats: readonly number[] = [], now: number = Date.now()): Room {
    const existing = this.get(setup.matchId);
    if (existing) return existing;
    return this.open(setup, botSeats, now);
  }

  tick(now: number = Date.now()): void {
    for (const [key, room] of this.rooms) {
      room.tick(now);
      // Finished rooms stay reachable for one sweep so late clients can read
      // the final state, then they are dropped.
      if (room.finished && now > room.deadline + 60_000) this.rooms.delete(key);
    }
  }

  attach(matchId: `0x${string}`, client: Client): Room {
    const room = this.get(matchId);
    if (!room) throw new Error('unknown match');
    room.attach(client);
    return room;
  }

  private open(setup: MatchSetup, botSeats: readonly number[], now: number): Room {
    const options: RoomOptions = {
      commitMs: this.options.commitMs,
      revealMs: this.options.revealMs,
      startingChips: this.options.startingChips,
      botSeats,
      onFinished: (result, history) => {
        void this.finalise(result, history);
      },
    };

    const room = new Room(setup, options, now);
    this.rooms.set(room.matchId.toLowerCase(), room);
    void this.decorate(room, setup);
    return room;
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
    result: Parameters<NonNullable<RoomOptions['onFinished']>>[0],
    history: Parameters<NonNullable<RoomOptions['onFinished']>>[1],
  ): Promise<void> {
    let settledTx: string | null = null;
    try {
      settledTx = await this.options.relayer.settle(result);
    } catch (error) {
      // A failed settlement is recoverable: the escrow stays `Live` until the
      // deadline, so the result can be resubmitted or the match cancelled.
      console.error('[lobby] settlement failed', errorMessage(error));
    }
    await this.options.archive.save({ result, history, settledTx });
  }
}

function botAddress(matchId: `0x${string}`, seat: number): `0x${string}` {
  const digest = createHash('sha256').update(`${matchId}:${seat}`).digest('hex');
  return `0x${digest.slice(0, 40)}` as `0x${string}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}


