import { randomBytes, createHash } from 'node:crypto';
import { keccak256, toHex } from 'viem';
import {
  DEFAULT_RULES,
  PRACTICE_CHAIN_ID,
  ZERO_ADDRESS,
  deriveMatchId,
  errorMessage,
  hashTranscript,
  tallyStyles,
  type AttestedResult,
  type BotDifficulty,
  type Rules,
  type Seat,
  type Transcript,
} from '@lms/protocol';
import type { MatchSetup } from '@lms/engine';
import { Room, type Client, type RoomOptions } from '../match/room.js';
import type { AvatarRegistry } from '../chain/avatars.js';
import type { ArchivedMatch, MatchArchive } from './store.js';
import type { StyleBook } from './styles.js';
import type { Relayer } from '../chain/attestor.js';
import { RequestError } from '../errors.js';

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
  /** Ceiling on practice rooms across all wallets. Defaults to 200. */
  maxPracticeRooms?: number;
  /** Play styles by wallet, for the reads panel. Omitted, nobody has a record. */
  styles?: StyleBook;
  /**
   * Waits before each settlement retry, in order; one attempt more than there
   * are entries. Defaults to 2 s then 10 s. Empty never retries.
   */
  settleBackoffMs?: readonly number[];
  /** Injectable for tests running on virtual time. */
  sleep?: (ms: number) => Promise<void>;
  /** First practice nonce. Defaults to a random 64-bit offset; see `practiceNonce`. Tests pin it to replay a run. */
  practiceNonceStart?: bigint;
  /** Seeds for practice matches. Defaults to 32 random bytes each; tests pin it to replay a run. */
  practiceSeed?: () => `0x${string}`;
  /** The hub chain, which moves and receipts are signed for. Recorded in every transcript. */
  chainId?: number;
  /** The key that signs commit receipts, recorded in every transcript. */
  receiptSigner?: `0x${string}` | null;
}

const DEFAULT_SETTLE_BACKOFF_MS = [2_000, 10_000];

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
  /**
   * Staked matches that were live when this server started. Their rooms died
   * with the previous process, so they are aborted and refunded rather than
   * resumed; a player reconnecting to one is told so.
   */
  /** Staked matches this server will not play, with the reason a reconnecting player is told. */
  private readonly abandoned = new Map<string, string>();
  /** The one practice room each wallet may hold, keyed by address. */
  private readonly practiceOf = new Map<string, string>();
  /**
   * Starts at a random 64-bit offset rather than zero. From zero, every
   * process handed out the same practice match ids, so after a restart a
   * player re-attaching to its old match id landed — as a spectator — in a
   * stranger's new match that happened to reuse it. Two server instances
   * would collide the same way.
   */
  private practiceNonce: bigint;

  constructor(private readonly options: LobbyOptions) {
    this.practiceNonce = options.practiceNonceStart ?? BigInt(`0x${randomBytes(8).toString('hex')}`) << 64n;
  }

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
  createPractice(
    human: `0x${string}`,
    opponents: number,
    now: number = Date.now(),
    difficulty: BotDifficulty = 'normal',
  ): Room {
    const owner = human.toLowerCase();
    const previous = this.practiceOf.get(owner);
    if (previous) {
      this.rooms.delete(previous);
      this.practiceOf.delete(owner);
    }
    const ceiling = this.options.maxPracticeRooms ?? DEFAULT_MAX_PRACTICE_ROOMS;
    if (this.practiceOf.size >= ceiling) {
      throw new RequestError('BUSY', 'the server is at its practice-room limit; try again shortly');
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
      seed: this.options.practiceSeed?.() ?? keccak256(toHex(randomBytes(32))),
      rules,
    };

    const room = this.open(
      setup,
      Array.from({ length: seatCount - 1 }, (_, i) => i + 1),
      now,
      false,
      difficulty,
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

  /** Records a staked match this server will not play: see `abandoned`. */
  markAbandoned(matchId: `0x${string}`, reason = 'it was cancelled after a server restart'): void {
    this.abandoned.set(matchId.toLowerCase(), reason);
  }

  tick(now: number = Date.now()): void {
    for (const [key, room] of this.rooms) {
      // One room's failure must not stop the others' clocks, and this runs on
      // a bare interval, where an escaping error takes the whole server down.
      try {
        room.tick(now);
      } catch (error) {
        console.error(`[lobby] room ${key} failed to advance:`, errorMessage(error));
      }
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
    const abandoned = room ? undefined : this.abandoned.get(matchId.toLowerCase());
    if (abandoned) {
      throw new RequestError('MATCH_ABANDONED', `this match will not be played: ${abandoned}; every stake is being refunded`);
    }
    if (!room) throw new RequestError('NOT_FOUND', 'unknown match');
    room.attach(client);
    return room;
  }

  /**
   * @param staked Whether the room holds escrowed stakes. Only those settle,
   *        and only those feed the style book.
   */
  private open(
    setup: MatchSetup,
    botSeats: readonly number[],
    now: number,
    staked: boolean,
    botDifficulty: BotDifficulty = 'normal',
  ): Room {
    const room = new Room(setup, this.roomOptions(setup, botSeats, staked, botDifficulty), now);
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

  private roomOptions(
    setup: MatchSetup,
    botSeats: readonly number[],
    staked: boolean,
    botDifficulty: BotDifficulty,
  ): RoomOptions {
    return {
      commitMs: this.options.commitMs,
      revealMs: this.options.revealMs,
      replayMs: this.options.replayMs ?? 0,
      botSeats,
      botDifficulty,
      ...(this.options.chainId !== undefined ? { chainId: this.options.chainId } : {}),
      receiptSigner: this.options.receiptSigner ?? null,
      onFinished: (transcript) => {
        void this.finalise(transcript, staked);
      },
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

  /**
   * Runs `attempt` until it succeeds, waiting `settleBackoffMs` between tries.
   * Returns null, after logging, once the last try fails.
   *
   * A failure is usually transient — an RPC timeout, a nonce race, a gas
   * spike, a dropped database connection — so a retry a few seconds later
   * normally lands.
   */
  private async withRetry<T>(what: string, attempt: () => Promise<T>): Promise<T | null> {
    const backoff = this.options.settleBackoffMs ?? DEFAULT_SETTLE_BACKOFF_MS;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let tries = 0; ; tries += 1) {
      try {
        return await attempt();
      } catch (error) {
        const wait = backoff[tries];
        if (wait === undefined) {
          console.error(`[lobby] ${what} failed after ${tries + 1} attempts:`, errorMessage(error));
          return null;
        }
        console.warn(`[lobby] ${what} failed; retrying in ${wait} ms:`, errorMessage(error));
        await sleep(wait);
      }
    }
  }

  /**
   * Archives the transcript, and only then settles.
   *
   * The order is the point: `settle` carries the transcript's hash, so once a
   * result is proposed on-chain the evidence for it must already be
   * fetchable, or nobody could check it inside the challenge window. A match
   * whose transcript cannot be archived is therefore never settled; it is
   * aborted, which refunds every stake at once.
   *
   * Retrying a settlement that did in fact land is harmless: the escrow is no
   * longer `Live`, so the relayer's simulation reverts before spending gas.
   * After the last attempt the match refunds at its deadline.
   */
  private async finalise(transcript: Transcript, staked: boolean): Promise<void> {
    const result = transcript.result;
    const transcriptHash = hashTranscript(transcript);
    const entry: ArchivedMatch = {
      result,
      history: transcript.rounds.map((round) => round.record),
      settledTx: null,
      seats: transcript.seats,
      rules: transcript.rules,
      staked,
      seed: transcript.seed,
      finishedAt: Date.now(),
      transcript,
      transcriptHash,
    };
    const archived = await this.withRetry(`archiving ${result.matchId}`, () => this.options.archive.save(entry));
    if (archived === null) {
      if (staked) {
        console.error(`[lobby] ${result.matchId} is not settled without its transcript; aborting it instead`);
        await this.options.relayer.abort(result.matchId).catch((error: unknown) => {
          console.error(`[lobby] abort of ${result.matchId} failed; it refunds at its deadline:`, errorMessage(error));
        });
        this.get(result.matchId)?.announceSettled(null);
      }
      return;
    }

    const attested: AttestedResult = { ...result, transcriptHash };
    const settledTx = staked
      ? await this.withRetry(`settlement of ${result.matchId}`, () => this.options.relayer.settle(attested))
      : await this.options.relayer.settle(attested).catch(() => null);
    if (settledTx) {
      await this.options.archive.recordSettlement(result.matchId, settledTx).catch((error: unknown) => {
        console.warn(`[lobby] could not record the settlement of ${result.matchId}:`, errorMessage(error));
      });
    }
    if (staked && this.options.styles) {
      try {
        await this.options.styles.record(tallyStyles(result, entry.history, transcript.seats.map((seat) => seat.address)));
      } catch (error) {
        console.warn('[lobby] style record failed:', errorMessage(error));
      }
    }
    if (staked) this.get(result.matchId)?.announceSettled(settledTx);
  }
}

function botAddress(matchId: `0x${string}`, seat: number): `0x${string}` {
  const digest = createHash('sha256').update(`${matchId}:${seat}`).digest('hex');
  return `0x${digest.slice(0, 40)}` as `0x${string}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}


