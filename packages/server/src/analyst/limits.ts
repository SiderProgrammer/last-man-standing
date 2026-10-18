import { addressKey } from '@lms/protocol';
import { KeyedLimiter } from '../gateway/limits.js';

export interface AnalystLimitOptions {
  /** Fresh analyses one wallet may request per hour; cached answers are free. */
  perWalletPerHour: number;
  /** Analyses being written at once, across every wallet. */
  maxConcurrent: number;
  /**
   * Estimated spend allowed per UTC day, in US dollars, after which fresh
   * analyses stop until midnight. Infinity for no ceiling.
   */
  dailyBudgetUsd: number;
}

/** Why an analysis may not start now. */
export type Refusal =
  | { code: 'quota'; message: string }
  | { code: 'busy'; message: string };

const HOUR_MS = 3_600_000;

/**
 * What stands between a player's click and a paid model call.
 *
 * Three independent ceilings, because each fails differently. The per-wallet
 * bucket stops one player spending everyone's budget; the concurrency cap
 * keeps a burst from queueing dozens of slow calls at the provider; the daily
 * budget is the operator's circuit breaker, the one number that bounds the
 * bill however the other two are tuned. A wallet is charged only for a fresh
 * analysis, and refunded when the provider, not the player, made it fail.
 *
 * In-memory, so a restart forgives every wallet and forgets the day's spend.
 * Several server instances would each enforce their own limits.
 */
export class AnalystLimits {
  private readonly wallets: KeyedLimiter;
  private running = 0;
  private day = '';
  private spentToday = 0;

  constructor(private readonly options: AnalystLimitOptions) {
    const burst = Math.max(1, options.perWalletPerHour);
    this.wallets = new KeyedLimiter(options.perWalletPerHour / (HOUR_MS / 1000), burst);
  }

  /**
   * Claims a slot for a fresh analysis, or says why not. On success the
   * caller must call `release` exactly once, however the analysis ends.
   */
  admit(wallet: `0x${string}`, now: number): Refusal | { release: (refund: boolean, now: number) => void } {
    this.rollDay(now);
    if (this.spentToday >= this.options.dailyBudgetUsd) {
      return { code: 'quota', message: "the server's analysis budget for today is spent; try again tomorrow" };
    }
    if (this.running >= this.options.maxConcurrent) {
      return { code: 'busy', message: 'the analyst is busy with other matches; try again in a minute' };
    }
    const key = addressKey(wallet);
    if (!this.wallets.take(key, now)) {
      return { code: 'quota', message: `you can request ${this.options.perWalletPerHour} new analyses an hour; try again later` };
    }

    this.running += 1;
    let released = false;
    return {
      release: (refund, at) => {
        if (released) return;
        released = true;
        this.running -= 1;
        if (refund) this.wallets.refund(key, at);
      },
    };
  }

  /** Records what an analysis cost, against today's budget. */
  spend(usd: number, now: number): void {
    this.rollDay(now);
    this.spentToday += usd;
  }

  /** Drops wallets whose allowance has refilled. */
  sweep(now: number): void {
    this.wallets.sweep(now);
  }

  get spent(): number {
    return this.spentToday;
  }

  private rollDay(now: number): void {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.spentToday = 0;
    }
  }
}
