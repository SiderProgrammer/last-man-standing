/**
 * The hub's clock, as the server last read it from a block.
 *
 * Every lobby, challenge-window, unstake and governance deadline is the
 * chain's, counted in block time. A browser whose clock is off, or a fork
 * whose clock was moved weeks ahead, would otherwise say "closes in 1d" of a
 * lobby that can already be cancelled. The server stamps each directory it
 * sends with the chain's time; between stamps the offset carries it forward.
 */

/** The chain's clock less this browser's, in milliseconds. Zero until the server says otherwise. */
let offsetMs = 0;

/** Takes the chain's time, in unix seconds, as the server read it just now. */
export function syncChainClock(chainSeconds: number): void {
  offsetMs = chainSeconds * 1000 - Date.now();
}

/** The chain's time now, in milliseconds. */
export function chainNowMs(): number {
  return Date.now() + offsetMs;
}

/** The chain's time now, in unix seconds, as the contracts count deadlines. */
export function chainNow(): number {
  return Math.floor(chainNowMs() / 1000);
}
