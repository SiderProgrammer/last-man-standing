import { errorMessage } from '@lms/protocol';
import type { MatchSetup } from '@lms/engine';
import type { RoomEvent } from '../match/room.js';

/** Everything needed to rebuild one live room after a restart. */
export interface JournaledRoom {
  setup: MatchSetup;
  botSeats: number[];
  openedAt: number;
  events: RoomEvent[];
}

/**
 * Durable log of live staked rooms.
 *
 * Without it, round state lived only in memory: a restart mid-match lost the
 * round, and a staked match could then only end by cancellation after its
 * settlement deadline. With it, `Lobby.restore` replays each live room from
 * its journal and play resumes where it stopped.
 *
 * Writes are fire-and-forget from the room's point of view — a room never
 * waits on the database before accepting the next move — but each journal
 * keeps them in order per match, which is what a replay depends on.
 */
export interface RoundJournal {
  open(matchId: `0x${string}`, room: Omit<JournaledRoom, 'events'>): void;
  append(matchId: `0x${string}`, event: RoomEvent): void;
  /** Forgets a room whose result is archived. */
  close(matchId: `0x${string}`): void;
  /** Every room still open, for `Lobby.restore`. */
  live(): Promise<JournaledRoom[]>;
  /** Resolves once every write issued so far has landed. */
  flush(): Promise<void>;
}

/**
 * Process-local journal. Survives nothing — it is the default for practice-only
 * servers and for tests, where `Lobby.restore` against it exercises the same
 * replay path a database-backed journal would.
 */
export class MemoryJournal implements RoundJournal {
  private readonly rooms = new Map<string, JournaledRoom>();

  open(matchId: `0x${string}`, room: Omit<JournaledRoom, 'events'>): void {
    this.rooms.set(matchId.toLowerCase(), { ...structuredClone(room), events: [] });
  }

  append(matchId: `0x${string}`, event: RoomEvent): void {
    this.rooms.get(matchId.toLowerCase())?.events.push(structuredClone(event));
  }

  close(matchId: `0x${string}`): void {
    this.rooms.delete(matchId.toLowerCase());
  }

  async live(): Promise<JournaledRoom[]> {
    return [...this.rooms.values()].map((room) => structuredClone(room));
  }

  async flush(): Promise<void> {}
}

interface PgPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Postgres journal: one row per room, one row per event, ordered by a
 * per-process sequence. Loaded through a computed specifier for the same reason
 * as `PostgresArchive`: `pg` stays optional.
 */
export class PostgresJournal implements RoundJournal {
  /** Serialises writes, so events land in the order the rooms emitted them. */
  private chain: Promise<void> = Promise.resolve();
  private sequence = Date.now() * 1000;

  private constructor(private readonly pool: PgPool) {}

  static async connect(connectionString: string): Promise<PostgresJournal> {
    const specifier = 'pg';
    const pg = (await import(specifier)) as {
      default?: { Pool: new (config: { connectionString: string }) => PgPool };
      Pool?: new (config: { connectionString: string }) => PgPool;
    };
    const Pool = pg.Pool ?? pg.default?.Pool;
    if (!Pool) throw new Error('pg is installed but does not export Pool');

    const pool = new Pool({ connectionString });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS live_rooms (
        match_id   TEXT PRIMARY KEY,
        room       JSONB NOT NULL,
        opened_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS room_events (
        match_id TEXT NOT NULL REFERENCES live_rooms (match_id) ON DELETE CASCADE,
        seq      BIGINT NOT NULL,
        event    JSONB NOT NULL,
        PRIMARY KEY (match_id, seq)
      )
    `);
    return new PostgresJournal(pool);
  }

  open(matchId: `0x${string}`, room: Omit<JournaledRoom, 'events'>): void {
    this.write(
      `INSERT INTO live_rooms (match_id, room) VALUES ($1, $2) ON CONFLICT (match_id) DO NOTHING`,
      [matchId.toLowerCase(), JSON.stringify(room)],
    );
  }

  append(matchId: `0x${string}`, event: RoomEvent): void {
    this.sequence += 1;
    this.write(`INSERT INTO room_events (match_id, seq, event) VALUES ($1, $2, $3)`, [
      matchId.toLowerCase(),
      this.sequence,
      JSON.stringify(event),
    ]);
  }

  close(matchId: `0x${string}`): void {
    this.write(`DELETE FROM live_rooms WHERE match_id = $1`, [matchId.toLowerCase()]);
  }

  async live(): Promise<JournaledRoom[]> {
    await this.flush();
    const rooms = await this.pool.query('SELECT match_id, room FROM live_rooms');
    const events = await this.pool.query('SELECT match_id, event FROM room_events ORDER BY match_id, seq');
    const byMatch = new Map<string, RoomEvent[]>();
    for (const row of events.rows) {
      const key = row.match_id as string;
      byMatch.set(key, [...(byMatch.get(key) ?? []), row.event as RoomEvent]);
    }
    return rooms.rows.map((row) => ({
      ...(row.room as Omit<JournaledRoom, 'events'>),
      events: byMatch.get(row.match_id as string) ?? [],
    }));
  }

  flush(): Promise<void> {
    return this.chain;
  }

  private write(text: string, values: unknown[]): void {
    this.chain = this.chain
      .then(() => this.pool.query(text, values))
      .then(
        () => undefined,
        (error: unknown) => {
          // A lost write costs resumability for one room, never the match in
          // progress: log it and keep the chain alive for the next write.
          console.error('[journal] write failed:', errorMessage(error));
        },
      );
  }
}

export async function createJournal(databaseUrl: string): Promise<RoundJournal> {
  if (!databaseUrl) return new MemoryJournal();
  try {
    return await PostgresJournal.connect(databaseUrl);
  } catch (error) {
    console.warn('[journal] falling back to in-memory journal:', errorMessage(error));
    return new MemoryJournal();
  }
}
