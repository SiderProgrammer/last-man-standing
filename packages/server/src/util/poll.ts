/**
 * Runs `run` now and then every `ms`, on a timer that does not hold the
 * process open.
 *
 * @returns Stops the timer.
 */
export function repeat(run: () => void, ms: number): () => void {
  run();
  const timer = setInterval(run, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * `job`, but never twice at once: a call made while one is still running
 * resolves to undefined at once instead. For a poll whose overlapping runs
 * would double-submit a transaction or report the same blocks twice.
 */
export function exclusive<T>(job: () => Promise<T>): () => Promise<T | undefined> {
  let running = false;
  return async () => {
    if (running) return undefined;
    running = true;
    try {
      return await job();
    } finally {
      running = false;
    }
  };
}
