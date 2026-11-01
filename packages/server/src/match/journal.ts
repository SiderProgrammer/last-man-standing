import type { SealedMove } from '@lms/consensus';
import type { MoveAim } from '@lms/api';
import type { Queryable } from '../db/database.js';
import type { MoveProof } from './room.js';

/**
 * One thing that moved a room on, in the order it happened: enough, replayed
 * into a fresh `Room` with the same setup, to bring it to exactly the state
 * it was in — the same commitments, so the same rolls.
 */
export type JournalEntry =
  /** The room opened. Always the first entry. */
  | { kind: 'open'; at: number }
  | { kind: 'commit'; at: number; seat: number; commitment: `0x${string}`; aim: MoveAim; hold?: SealedMove; proof?: MoveProof }
  | { kind: 'reveal'; at: number; seat: number; move: SealedMove; aim: MoveAim; proof?: MoveProof }
  /** The clock moved the room on: the ready phase ran out, a window closed. */
  | { kind: 'tick'; at: number }
  /** Every player had connected, and round 1's clock started. */
  | { kind: 'start'; at: number }
  /** The room was resumed after a restart, and its clock given back. */
  | { kind: 'rebase'; at: number };

/**
 * Where rooms' journals are kept, so a staked match survives a restart.
 * Entries are numbered from zero per match and written in that order.
 */
export interface RoomJournal {
  append(matchId: `0x${string}`, seq: number, entry: JournalEntry): Promise<void>;
  /** Every entry for the match, in order; empty if it has none. */
  load(matchId: `0x${string}`): Promise<JournalEntry[]>;
  /** Forgets a match once nothing can need to resume it. */
  drop(matchId: `0x${string}`): Promise<void>;
}

/** Dies with the process: with it, a restart still refunds every live match. */
export class MemoryJournal implements RoomJournal {
  private readonly entries = new Map<string, JournalEntry[]>();

  async append(matchId: `0x${string}`, seq: number, entry: JournalEntry): Promise<void> {
    const key = matchId.toLowerCase();
    const list = this.entries.get(key) ?? [];
    if (seq !== list.length) throw new Error(`journal entry ${seq} for ${matchId} is out of order`);
    list.push(structuredClone(entry));
    this.entries.set(key, list);
  }

  async load(matchId: `0x${string}`): Promise<JournalEntry[]> {
    return structuredClone(this.entries.get(matchId.toLowerCase()) ?? []);
  }

  async drop(matchId: `0x${string}`): Promise<void> {
    this.entries.delete(matchId.toLowerCase());
  }
}

/** The repository over `room_journal`, on the server's one pool. */
export class PostgresJournal implements RoomJournal {
  constructor(private readonly pool: Queryable) {}

  async append(matchId: `0x${string}`, seq: number, entry: JournalEntry): Promise<void> {
    await this.pool.query('INSERT INTO room_journal (match_id, seq, entry) VALUES ($1, $2, $3)', [
      matchId.toLowerCase(),
      seq,
      JSON.stringify(entry),
    ]);
  }

  async load(matchId: `0x${string}`): Promise<JournalEntry[]> {
    const { rows } = await this.pool.query('SELECT entry FROM room_journal WHERE match_id = $1 ORDER BY seq', [
      matchId.toLowerCase(),
    ]);
    return rows.map((row) => row.entry as JournalEntry);
  }

  async drop(matchId: `0x${string}`): Promise<void> {
    await this.pool.query('DELETE FROM room_journal WHERE match_id = $1', [matchId.toLowerCase()]);
  }
}
