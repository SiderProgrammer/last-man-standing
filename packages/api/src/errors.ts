/**
 * Turning an unknown thrown value into something printable.
 *
 * `catch` binds `unknown`, so every catch block needs this, and before it
 * existed six copies had been written across the server and the client.
 */

/** The message of an Error, or the value itself stringified. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The same, trimmed to its first line.
 *
 * A separate function rather than an option because the two behaviours are not
 * interchangeable: the server logs the full message, while the client puts it
 * in a toast, and viem errors carry a multi-paragraph body that would bury the
 * rest of the UI.
 */
export function errorFirstLine(error: unknown): string {
  const message = errorMessage(error);
  return message.split('\n')[0] ?? message;
}
