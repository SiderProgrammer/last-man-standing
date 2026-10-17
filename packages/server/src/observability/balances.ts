import type { Address } from 'viem';
import { errorMessage } from '@lms/protocol';
import { log } from './log.js';
import { walletBalance } from './metrics.js';

const logger = log.child({ component: 'balances' });

/**
 * Exports the native balance of every key the server spends gas from.
 *
 * The attestor pays for settlement, the keeper for locks and harvests, the
 * relayer for players' session calls. Each fails quietly when its key runs
 * dry — a lobby that never locks, a match that never settles, a session call
 * the client has to fall back on — so the alert has to come from here, while
 * there is still time to top it up.
 */
export class BalanceWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly read: (address: Address) => Promise<bigint>,
    private readonly wallets: ReadonlyArray<{ role: string; address: Address }>,
  ) {}

  start(pollMs = 60_000): this {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), pollMs);
    this.timer.unref?.();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    for (const { role, address } of this.wallets) {
      try {
        // Wei exceed 2^53, but a gauge is a float; the precision lost is far
        // below anything an alert threshold would care about.
        walletBalance.set({ role }, Number(await this.read(address)));
      } catch (error) {
        logger.warn('balance read failed', { role, address, error: errorMessage(error) });
      }
    }
  }
}
