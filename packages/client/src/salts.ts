import type { ActionValue } from '@lms/protocol';

const KEY = 'lms.moves.v1';

export interface StoredMove {
  action: ActionValue;
  target: number;
  salt: `0x${string}`;
}

/**
 * Commit-reveal only works if the sealed move outlives the page.
 *
 * A player who refreshes between committing and revealing would otherwise be
 * unable to open their own commitment, and the engine would score them as a
 * no-show. The record is worthless to anyone else once the round resolves, so
 * localStorage is the right amount of durability.
 */
export function freshSalt(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function rememberMove(matchId: string, round: number, move: StoredMove): void {
  const store = read();
  store[`${matchId}:${round}`] = move;
  write(store);
}

export function recallMove(matchId: string, round: number): StoredMove | null {
  return read()[`${matchId}:${round}`] ?? null;
}

/** Drops records for a finished match so the store cannot grow without bound. */
export function forgetMatch(matchId: string): void {
  const store = read();
  for (const key of Object.keys(store)) {
    if (key.startsWith(`${matchId}:`)) delete store[key];
  }
  write(store);
}

function read(): Record<string, StoredMove> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, StoredMove>;
  } catch {
    return {};
  }
}

function write(store: Record<string, StoredMove>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Private-browsing mode: the player just loses refresh resilience.
  }
}
