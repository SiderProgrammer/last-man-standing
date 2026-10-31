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
 * The newest block a log scan may read: `confirmations` behind the head, so
 * a block that could still be reorged away is never read and then skipped
 * past. Null while the chain is younger than that.
 */
export function confirmedHead(head: bigint, confirmations: number): bigint | null {
  const depth = BigInt(confirmations);
  return head >= depth ? head - depth : null;
}
