/** Many public RPCs cap `eth_getLogs` at 10k blocks. */
export const LOG_CHUNK = 10_000n;

/**
 * Reads `[from, to]` in ranges of at most `chunk` blocks, in order, and
 * concatenates what each returns. Every log scan the server makes goes
 * through this, so none of them can ask an RPC for more blocks than it serves.
 */
export async function chunkedLogs<T>(
  from: bigint,
  to: bigint,
  read: (from: bigint, to: bigint) => Promise<readonly T[]>,
  chunk: bigint = LOG_CHUNK,
): Promise<T[]> {
  const out: T[] = [];
  for (let start = from; start <= to; start += chunk) {
    const end = start + chunk - 1n < to ? start + chunk - 1n : to;
    out.push(...(await read(start, end)));
  }
  return out;
}

/**
 * Reads log ranges the way `chunkedLogs` does, but learns how wide a range
 * the RPC will serve. It starts at `size` blocks; when the RPC refuses a range
 * as too wide, it narrows to the range the refusal suggests (Alchemy names
 * one, e.g. "this block range should work: [0x10, 0x19]"), or else halves,
 * and reads the same blocks again. The narrower size is kept for later reads,
 * so a stingy RPC (Alchemy's free tier allows 10 blocks on some chains) costs
 * one refused request, not one per poll. Any other error is thrown as is.
 */
export class AdaptiveLogRange {
  constructor(
    private size: bigint,
    /** Told each time the size shrinks, so the server can say so once. */
    private readonly onNarrow?: (size: bigint) => void,
  ) {}

  /** The widest range the next read will ask for. */
  get chunk(): bigint {
    return this.size;
  }

  async read<T>(from: bigint, to: bigint, read: (from: bigint, to: bigint) => Promise<readonly T[]>): Promise<T[]> {
    const out: T[] = [];
    let start = from;
    while (start <= to) {
      const end = start + this.size - 1n < to ? start + this.size - 1n : to;
      let logs: readonly T[];
      try {
        logs = await read(start, end);
      } catch (error) {
        const narrower = narrowerRange(error, end - start + 1n);
        if (narrower === null) throw error;
        this.size = narrower;
        this.onNarrow?.(narrower);
        continue;
      }
      out.push(...logs);
      start = end + 1n;
    }
    return out;
  }
}

/** What RPCs say when an `eth_getLogs` range is wider than they serve. */
const RANGE_REFUSAL =
  /block range|range (?:is )?too (?:large|wide|big)|range limit|too many blocks|exceeds? (?:the )?(?:max|limit)|more than \d+ (?:blocks|results)|query returned more than|response size (?:is )?(?:exceeded|too large)/i;

/**
 * The range to try after `error` refused one of `tried` blocks: the width the
 * error suggests, else half. Null when `error` is not a range refusal, or the
 * range cannot get narrower.
 */
export function narrowerRange(error: unknown, tried: bigint): bigint | null {
  const text = errorTexts(error).join('\n');
  if (!RANGE_REFUSAL.test(text) || tried <= 1n) return null;
  const hint = /\[\s*(0x[0-9a-f]+|\d+)\s*,\s*(0x[0-9a-f]+|\d+)\s*\]/i.exec(text);
  if (hint?.[1] && hint[2]) {
    const width = BigInt(hint[2]) - BigInt(hint[1]) + 1n;
    if (width >= 1n && width < tried) return width;
  }
  return tried / 2n;
}

/** The message, details and causes of an error, as viem nests them. */
function errorTexts(error: unknown, depth = 0): string[] {
  if (depth > 5 || error === null || typeof error !== 'object') return error === undefined ? [] : [String(error)];
  const { message, details, cause } = error as { message?: unknown; details?: unknown; cause?: unknown };
  return [
    ...(typeof message === 'string' ? [message] : []),
    ...(typeof details === 'string' ? [details] : []),
    ...(cause === undefined ? [] : errorTexts(cause, depth + 1)),
  ];
}

/**
 * The newest block a log scan may read: `confirmations` behind the head, so
 * a block that could still be reorged away is never read and then skipped
 * past. Null while the chain is younger than that.
 */
export function confirmedHead(head: bigint, confirmations: number): bigint | null {
  const depth = BigInt(confirmations);
  return head >= depth ? head - depth : null;
}
