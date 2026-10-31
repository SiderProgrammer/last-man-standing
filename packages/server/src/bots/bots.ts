import { keccak256, toHex } from 'viem';
import { commitMove, type BotDifficulty, type SealedMove } from '@lms/consensus';
import type { Match } from '@lms/engine';
import { Prng, smartStrategy } from '@lms/engine/bots';

/**
 * Plays the seats the server fills with house bots.
 *
 * Split out of `Room` because it is the only reason the room knew about the
 * engine's strategy layer at all. The room now owns the clock and the clients;
 * this owns what a bot does when the window opens.
 *
 * Every secret here is derived from the match seed rather than stored, so a
 * third party replaying the published match reproduces the bots' salts exactly
 * and the lobby stays auditable.
 */
export class BotDriver {
  private readonly seats: ReadonlySet<number>;
  private readonly pending = new Map<number, SealedMove>();

  constructor(
    seats: readonly number[],
    private readonly difficulty: BotDifficulty = 'normal',
  ) {
    this.seats = new Set(seats);
  }

  has(seat: number): boolean {
    return this.seats.has(seat);
  }

  /** Commits every living bot's move for the current round. */
  commit(match: Match): void {
    const prng = new Prng(keccak256(toHex(`${match.seed}:${match.round}`)));
    const strategy = smartStrategy(prng, this.difficulty);

    for (const seat of this.seats) {
      if (!match.playerState(seat).alive) continue;
      const move = strategy(seat, match);
      const sealed: SealedMove = {
        ...move,
        salt: keccak256(toHex(`bot:${match.seed}:${match.round}:${seat}`)),
      };
      this.pending.set(seat, sealed);
      match.submitCommit(seat, commitMove(match.matchId, match.round, seat, sealed));
    }
  }

  /** Opens every commitment made this round. */
  reveal(match: Match): void {
    for (const [seat, move] of this.pending) {
      if (!match.playerState(seat).alive) continue;
      match.submitReveal(seat, move);
    }
    this.pending.clear();
  }
}
