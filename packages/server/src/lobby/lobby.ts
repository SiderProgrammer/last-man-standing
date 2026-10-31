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
   * Waits before each archive or settlement retry, in order. Defaults to 2 s,
   * 10 s, 30 s, then 60 s. Empty never retries. An archive write gets one
   * attempt more than there are entries; a settlement keeps retrying at the
   * last wait until `settleRetryForMs` of waiting has passed.
   */
  settleBackoffMs?: readonly number[];
  /**
   * How long a settlement is retried before it is left to the escrow's
   * refund. Defaults to an hour, the settle window `Deploy.s.sol` sets: after
   * that `settle` reverts and only `cancelMatch` is left.
   */
  settleRetryForMs?: number;
  /** Injectable for tests running on virtual time. */
  sleep?: (ms: number) => Promise<void>;
  /** First practice nonce. Defaults to a random 64-bit offset; see `practiceNonce`. Tests pin it to replay a run. */
  practiceNonceStart?: bigint;
  /** Seeds for practice matches. Defaults to 32 random bytes each; tests pin it to replay a run. */
  practiceSeed?: () => `0x${string}`;
  /** The hub chain, which moves and receipts are signed for. Recorded in every transcript. */
  chainId?: number;
  /** The key that signs staked rooms' commit receipts — the attestor — recorded in their transcripts. */
  receiptSigner?: `0x${string}` | null;
  /** The key that signs practice rooms' commit receipts: never the attestor. */
  practiceReceiptSigner?: `0x${string}` | null;
}

const DEFAULT_SETTLE_BACKOFF_MS = [2_000, 10_000, 30_000, 60_000];

const DEFAULT_SETTLE_RETRY_FOR_MS = 60 * 60 * 1000;

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
   * Finished matches still being archived or settled, by lower-cased id: the
   * retry queue. A match is in it once, however often its room reports it.
   */
  private readonly settling = new Map<string, Promise<void>>();
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

  /** Finished matches whose archive write or settlement has not landed yet. */
  get pendingSettlements(): number {
    return this.settling.size;
  }

  /** Resolves once every queued archive write and settlement has landed or been given up. */
  async drain(): Promise<void> {
    while (this.settling.size > 0) await Promise.all(this.settling.values());
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
      receiptSigner: (staked ? this.options.receiptSigner : this.options.practiceReceiptSigner) ?? null,
      staked,
      onFinished: (transcript) => this.enqueue(transcript, staked),
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
   * Queues a finished match for archiving and settlement. Nothing it does can
   * escape as an unhandled rejection: the room calls this from its clock, and
   * a rejection there would take the whole server down.
   */
  private enqueue(transcript: Transcript, staked: boolean): void {
    const key = transcript.matchId.toLowerCase();
    if (this.settling.has(key)) return;
    const job = this.finalise(transcript, staked)
      .catch((error: unknown) => {
        console.error(`[lobby] finalising ${transcript.matchId} failed:`, errorMessage(error));
      })
      .finally(() => this.settling.delete(key));
    this.settling.set(key, job);
  }

  /**
   * Runs `attempt` until it succeeds, waiting `settleBackoffMs` between tries.
   * Returns null, after logging, once it gives up: after the last wait in the
   * list, or with `forMs`, once the next wait would take the time spent
   * waiting past it, repeating the last wait until then.
   *
   * A failure is usually transient — an RPC timeout, a nonce race, a gas
   * spike, a dropped database connection — so a retry a few seconds later
   * normally lands.
   */
  private async withRetry<T>(what: string, attempt: () => Promise<T>, forMs?: number): Promise<T | null> {
    const backoff = this.options.settleBackoffMs ?? DEFAULT_SETTLE_BACKOFF_MS;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let waited = 0;
    for (let tries = 0; ; tries += 1) {
      try {
        return await attempt();
      } catch (error) {
        const wait = backoff[tries] ?? (forMs !== undefined ? backoff[backoff.length - 1] : undefined);
        if (wait === undefined || (forMs !== undefined && waited + wait > forMs)) {
          console.error(`[lobby] ${what} failed after ${tries + 1} attempts:`, errorMessage(error));
          return null;
        }
        console.warn(`[lobby] ${what} failed; retrying in ${wait} ms:`, errorMessage(error));
        await sleep(wait);
        waited += wait;
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
   * A settlement is retried for `settleRetryForMs`; after that the match
   * refunds at its deadline.
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

    // A practice match is archived for its player, and that is all: nothing
    // in it reaches the relayer or the attestor.
    if (!staked) return;

    const attested: AttestedResult = { ...result, transcriptHash };
    const settledTx = await this.withRetry(
      `settlement of ${result.matchId}`,
      () => this.options.relayer.settle(attested, transcript),
      this.options.settleRetryForMs ?? DEFAULT_SETTLE_RETRY_FOR_MS,
    );
    if (settledTx) {
      await this.options.archive.recordSettlement(result.matchId, settledTx).catch((error: unknown) => {
        console.warn(`[lobby] could not record the settlement of ${result.matchId}:`, errorMessage(error));
      });
    }
    if (this.options.styles) {
      try {
        await this.options.styles.record(tallyStyles(result, entry.history, transcript.seats.map((seat) => seat.address)));
      } catch (error) {
        console.warn('[lobby] style record failed:', errorMessage(error));
      }
    }
    this.get(result.matchId)?.announceSettled(settledTx);
  }
}

function botAddress(matchId: `0x${string}`, seat: number): `0x${string}` {
  const digest = createHash('sha256').update(`${matchId}:${seat}`).digest('hex');
  return `0x${digest.slice(0, 40)}` as `0x${string}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}


