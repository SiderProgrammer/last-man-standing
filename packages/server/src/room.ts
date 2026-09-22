import { keccak256, toHex } from 'viem';
import {
  Action,
  MatchPhase,
  addressKey,
  commitMove,
  sameAddress,
  settleEliminationBook,
  type AvatarEntry,
  type BookSnapshot,
  type EliminationBet,
  type MatchResult,
  type RoundRecord,
  type SealedMove,
  type ServerMessage,
} from '@lms/protocol';
import { Match, Prng, describeRound, readerStrategy, type MatchSetup } from '@lms/engine';

/** Anything the room can push a message to. The gateway supplies a WebSocket. */
export interface Client {
  address: `0x${string}` | null;
  send(message: ServerMessage): void;
}

export interface RoomOptions {
  commitMs: number;
  revealMs: number;
  startingChips: number;
  /** Seats played by the server's bots. Empty for a fully human lobby. */
  botSeats?: readonly number[];
  /** Called once the match reaches a signable result. */
  onFinished?: (result: MatchResult, history: readonly RoundRecord[]) => void;
}

/**
 * One authoritative match plus its spectator book.
 *
 * The room owns the clock but never reads it: `tick(now)` is driven from the
 * outside, so tests can run a whole match in a loop and the production server
 * can drive it from an interval. Nothing here touches the network directly —
 * clients are opaque sinks, which keeps the state machine testable.
 */
export class Room {
  readonly match: Match;

  private readonly options: RoomOptions;
  private readonly bots: Set<number>;
  private readonly clients = new Set<Client>();
  private readonly chipStacks = new Map<string, number>();
  private readonly seatByAddress = new Map<string, number>();
  private readonly botMoves = new Map<number, SealedMove>();
  private bets: EliminationBet[] = [];
  /** Cosmetic only, and resolved off the match's critical path. */
  private avatars: AvatarEntry[] = [];
  private deadlineAt: number;
  private settled = false;

  constructor(setup: MatchSetup, options: RoomOptions, now: number = Date.now()) {
    this.match = new Match(setup);
    this.options = options;
    this.bots = new Set(options.botSeats ?? []);

    for (const seat of setup.seats) {
      this.seatByAddress.set(addressKey(seat.address), seat.index);
      if (!this.bots.has(seat.index)) {
        this.chipStacks.set(addressKey(seat.address), options.startingChips);
      }
    }

    this.deadlineAt = now + options.commitMs;
    this.commitBots();
  }

  get matchId(): `0x${string}` {
    return this.match.matchId;
  }

  get finished(): boolean {
    return this.match.finished;
  }

  get deadline(): number {
    return this.deadlineAt;
  }

  seatOf(address: `0x${string}`): number | null {
    return this.seatByAddress.get(addressKey(address)) ?? null;
  }

  chipsOf(address: `0x${string}` | null): number {
    if (!address) return 0;
    return this.chipStacks.get(addressKey(address)) ?? 0;
  }

  attach(client: Client): void {
    this.clients.add(client);
    // A spectator who never staked still gets a stack, so the book stays lively.
    if (client.address && !this.chipStacks.has(addressKey(client.address))) {
      this.chipStacks.set(addressKey(client.address), this.options.startingChips);
    }
    this.pushState(client);
    if (this.avatars.length > 0) this.pushAvatars(client);
  }

  /**
   * Publishes the avatars the seats are wearing.
   *
   * Called once the registry has answered, which is after the match is already
   * playable: resolving an NFT means a chain read and an IPFS fetch, and no
   * round waits for either. A client that connects later gets them on attach.
   */
  setAvatars(entries: readonly AvatarEntry[]): void {
    this.avatars = [...entries];
    if (this.avatars.length === 0) return;
    for (const client of this.clients) this.pushAvatars(client);
  }

  detach(client: Client): void {
    this.clients.delete(client);
  }

  submitCommit(address: `0x${string}`, commitment: `0x${string}`, now: number = Date.now()): void {
    const seat = this.requireSeat(address);
    this.match.submitCommit(seat, commitment);
    if (this.match.allCommitted()) this.openReveal(now);
    else this.broadcastState();
  }

  submitReveal(address: `0x${string}`, move: SealedMove, now: number = Date.now()): void {
    const seat = this.requireSeat(address);
    this.match.submitReveal(seat, move);
    if (this.match.allRevealed()) this.resolveRound(now);
    else this.broadcastState();
  }

  /**
   * Backs a seat to be eliminated this round. Chips are escrowed immediately so
   * a player cannot bet the same stack twice, and the book locks with the
   * commit window — betting after commitments are in would leak information.
   */
  placeBet(address: `0x${string}`, target: number, chips: number): void {
    if (this.match.phase !== MatchPhase.Commit) {
      throw new Error('the book is closed for this round');
    }
    if (!Number.isSafeInteger(chips) || chips <= 0) {
      throw new Error('chips must be a positive integer');
    }
    const stack = this.chipsOf(address);
    if (chips > stack) throw new Error('not enough chips');
    if (!this.match.playerState(target).alive) throw new Error('target is already eliminated');

    this.chipStacks.set(addressKey(address), stack - chips);
    this.bets.push({ better: address, target, chips });
    this.broadcastState();
  }

  /** Advances the phase clock. Safe to call at any frequency. */
  tick(now: number = Date.now()): void {
    if (this.match.finished || now < this.deadlineAt) return;
    if (this.match.phase === MatchPhase.Commit) this.openReveal(now);
    else if (this.match.phase === MatchPhase.Reveal) this.resolveRound(now);
  }

  bookSnapshot(address: `0x${string}` | null): BookSnapshot {
    const pots: Record<number, number> = {};
    const yours: Record<number, number> = {};
    for (const bet of this.bets) {
      pots[bet.target] = (pots[bet.target] ?? 0) + bet.chips;
      if (sameAddress(bet.better, address)) {
        yours[bet.target] = (yours[bet.target] ?? 0) + bet.chips;
      }
    }
    return { round: this.match.round, pots, yours };
  }

  private requireSeat(address: `0x${string}`): number {
    const seat = this.seatOf(address);
    if (seat === null) throw new Error('you are not seated in this match');
    if (this.bots.has(seat)) throw new Error('seat is played by the house bot');
    return seat;
  }

  private openReveal(now: number): void {
    if (this.match.phase !== MatchPhase.Commit) return;
    this.match.openRevealPhase();
    this.revealBots();

    if (this.match.allRevealed()) {
      this.resolveRound(now);
      return;
    }
    this.deadlineAt = now + this.options.revealMs;
    this.broadcastState();
  }

  private resolveRound(now: number): void {
    if (this.match.phase !== MatchPhase.Reveal) return;

    const record = this.match.resolve();
    this.payBook(record);

    for (const client of this.clients) {
      client.send({
        type: 'round',
        record,
        lines: describeRound(record),
        book: this.bookSnapshot(client.address),
        chips: this.chipsOf(client.address),
      });
    }

    if (this.match.finished) {
      this.finish();
      return;
    }

    this.deadlineAt = now + this.options.commitMs;
    this.commitBots();
    this.broadcastState();
  }

  private payBook(record: RoundRecord): void {
    const payouts = settleEliminationBook(this.bets, record.eliminated);
    for (const [better, amount] of payouts) {
      const key = addressKey(better);
      this.chipStacks.set(key, (this.chipStacks.get(key) ?? 0) + amount);
    }
    this.bets = [];
  }

  private finish(): void {
    if (this.settled) return;
    this.settled = true;

    const result = this.match.result();
    const ranking = this.match.ranking();
    for (const client of this.clients) {
      client.send({ type: 'finished', result, ranking, chips: this.chipsOf(client.address) });
    }
    this.options.onFinished?.(result, this.match.history);
  }

  /**
   * Bots commit as soon as the window opens. Their salts are derived from the
   * match seed rather than stored secrets, so a replay can reproduce them.
   */
  private commitBots(): void {
    if (this.match.phase !== MatchPhase.Commit) return;

    const prng = new Prng(keccak256(toHex(`${this.match.seed}:${this.match.round}`)));
    const strategy = readerStrategy(prng);

    for (const seat of this.bots) {
      if (!this.match.playerState(seat).alive) continue;
      const move = strategy(seat, this.match);
      const sealed: SealedMove = {
        ...move,
        salt: keccak256(toHex(`bot:${this.match.seed}:${this.match.round}:${seat}`)),
      };
      this.botMoves.set(seat, sealed);
      this.match.submitCommit(seat, commitMove(this.match.matchId, this.match.round, seat, sealed));
    }
  }

  private revealBots(): void {
    for (const [seat, move] of this.botMoves) {
      if (!this.match.playerState(seat).alive) continue;
      this.match.submitReveal(seat, move);
    }
    this.botMoves.clear();
  }

  private broadcastState(): void {
    for (const client of this.clients) this.pushState(client);
  }

  private pushAvatars(client: Client): void {
    client.send({ type: 'avatars', matchId: this.matchId, entries: this.avatars });
  }

  private pushState(client: Client): void {
    client.send({
      type: 'state',
      state: this.match.publicState(),
      you: client.address ? this.seatOf(client.address) : null,
      deadline: this.deadlineAt,
      chips: this.chipsOf(client.address),
      book: this.bookSnapshot(client.address),
    });
  }
}

