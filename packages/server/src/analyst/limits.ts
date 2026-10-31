import { addressKey } from '@lms/consensus';
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
  /** Model requests the provider allows per minute, server-wide. Infinity for no ceiling. */
  requestsPerMinute: number;
  /**
   * Model requests the provider allows per day, server-wide. The day turns at
   * midnight Pacific time, when Gemini's daily quota resets. Infinity for no ceiling.
   */
  requestsPerDay: number;
}

/** Why an analysis or a model request may not go ahead. */
export type Refusal =
  | { code: 'quota'; message: string }
  | { code: 'busy'; message: string };

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** The calendar day in the provider's quota zone, e.g. `2026-10-20`. */
const pacificDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' });

/**
 * What stands between a player's click and a paid model call.
 *
 * Per analysis: a per-wallet bucket stops one player spending everyone's
 * allowance, the concurrency cap keeps a burst from queueing slow calls, and
 * the daily budget is the operator's circuit breaker on the bill. A wallet is
 * charged only for a fresh analysis, and refunded when the provider, not the
 * player, made it fail.
 *
 * Per model request: the provider's own rate limits — requests per minute
 * and per day — are enforced here rather than discovered as 429s. A request
 * over the minute's allowance waits for a slot; one over the day's is
 * refused, and an analysis is only started if the day has room for all of
 * its turns, so it is not abandoned halfway.
 *
 * In-memory, so a restart forgives every wallet and forgets the day's spend.
 * Several server instances would each enforce their own limits.
 */
export class AnalystLimits {
  private readonly wallets: KeyedLimiter;
  private running = 0;
  private day = '';
  private spentToday = 0;
  private quotaDay = '';
  private requestsToday = 0;
  /** When each request in the last minute went (or will go) out, ascending. */
  private recent: number[] = [];

  constructor(private readonly options: AnalystLimitOptions) {
    const burst = Math.max(1, options.perWalletPerHour);
    this.wallets = new KeyedLimiter(options.perWalletPerHour / (HOUR_MS / 1000), burst);
  }

  /**
   * Claims a slot for a fresh analysis that may take up to `requests` model
   * calls, or says why not. On success the caller must call `release` exactly
   * once, however the analysis ends.
   */
  admit(wallet: `0x${string}`, now: number, requests = 1): Refusal | { release: (refund: boolean, now: number) => void } {
    this.rollDay(now);
    if (this.spentToday >= this.options.dailyBudgetUsd) {
      return { code: 'quota', message: "the server's analysis budget for today is spent; try again tomorrow" };
    }
    if (this.requestsToday + requests > this.options.requestsPerDay) {
      return { code: 'quota', message: "the analyst has used today's model requests; try again tomorrow" };
    }
    if (this.running >= this.options.maxConcurrent) {
      return { code: 'busy', message: 'the analyst is busy with another match; try again in a minute' };
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

  /**
   * Books one model request: how long to wait before sending it, so the
   * minute's allowance holds, or a refusal once the day's is used up.
   */
  reserve(now: number): Refusal | { waitMs: number } {
    this.rollDay(now);
    if (this.requestsToday >= this.options.requestsPerDay) {
      return { code: 'quota', message: "the analyst has used today's model requests; try again tomorrow" };
    }
    this.recent = this.recent.filter((at) => at > now - MINUTE_MS);
    const limit = this.options.requestsPerMinute;
    // Full: the next slot opens a minute after the request that would fall out of the window.
    const at = this.recent.length < limit ? now : (this.recent[this.recent.length - limit] ?? now) + MINUTE_MS;
    this.recent.push(at);
    this.requestsToday += 1;
    return { waitMs: Math.max(0, at - now) };
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

  /** Model requests booked since the provider's day began. */
  get requests(): number {
    return this.requestsToday;
  }

  private rollDay(now: number): void {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.spentToday = 0;
    }
    const quotaDay = pacificDay.format(now);
    if (quotaDay !== this.quotaDay) {
      this.quotaDay = quotaDay;
      this.requestsToday = 0;
    }
  }
}
