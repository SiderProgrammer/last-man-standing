/**
 * localStorage that cannot throw.
 *
 * Private-browsing mode and blocked site data make every one of these calls a
 * potential exception, which is why both callers wrapped them. Shared at the
 * raw-string level only: `salts.ts` treats a failed read as an empty store
 * while `session.ts` treats it as "no session", and those are different
 * answers. Parsing stays with the caller.
 */

export function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Nothing to do: the caller loses durability, not correctness.
  }
}

export function removeRaw(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // As above.
  }
}
