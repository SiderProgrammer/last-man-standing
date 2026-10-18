import { errorMessage, type MatchResult, type RoundRecord, type Rules, type Seat } from '@lms/protocol';

export interface ArchivedMatch {
  result: MatchResult;
  history: readonly RoundRecord[];
  settledTx: string | null;
  /**
   * Who sat where. Optional because rows archived before it was recorded
   * lack it; `result.ranking` names the wallets but not their seats.
   */
  seats?: readonly Seat[];
  /** The rule set the match was played under. Optional for the same reason. */
  rules?: Rules;
}

export interface MatchArchive {
  save(entry: ArchivedMatch): Promise<void>;
  load(matchId: `0x${string}`): Promise<ArchivedMatch | null>;
  recent(limit: number): Promise<ArchivedMatch[]>;
}

/**
 * Default archive. Everything needed to audit a match is already in the
 * signed result plus the move log, so losing this on restart costs history
 * browsing, not correctness.
 */
export class MemoryArchive implements MatchArchive {
  private readonly entries = new Map<string, ArchivedMatch>();
  private readonly order: string[] = [];

  async save(entry: ArchivedMatch): Promise<void> {
    const key = entry.result.matchId.toLowerCase();
    if (!this.entries.has(key)) this.order.push(key);
    this.entries.set(key, entry);
  }

  async load(matchId: `0x${string}`): Promise<ArchivedMatch | null> {
    return this.entries.get(matchId.toLowerCase()) ?? null;
  }

  async recent(limit: number): Promise<ArchivedMatch[]> {
    return this.order
      .slice(-limit)
      .reverse()
      .map((key) => this.entries.get(key))
      .filter((entry): entry is ArchivedMatch => entry !== undefined);
  }
}

interface PgPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Postgres-backed archive. `pg` is loaded through a computed specifier so the
 * package stays an optional dependency: a deployment without a database just
 * keeps the in-memory archive.
 */
export class PostgresArchive implements MatchArchive {
  private constructor(private readonly pool: PgPool) {}

  static async connect(connectionString: string): Promise<PostgresArchive> {
    const specifier = 'pg';
    const pg = (await import(specifier)) as {
      default?: { Pool: new (config: { connectionString: string }) => PgPool };
      Pool?: new (config: { connectionString: string }) => PgPool;
    };
    const Pool = pg.Pool ?? pg.default?.Pool;
    if (!Pool) throw new Error('pg is installed but does not export Pool');

    const pool = new Pool({ connectionString });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS matches (
        match_id     TEXT PRIMARY KEY,
        rounds       INTEGER NOT NULL,
        history_root TEXT NOT NULL,
        ranking      JSONB NOT NULL,
        history      JSONB NOT NULL,
        settled_tx   TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Added after the table first shipped; nullable, so older rows stay valid.
    await pool.query('ALTER TABLE matches ADD COLUMN IF NOT EXISTS seats JSONB');
    await pool.query('ALTER TABLE matches ADD COLUMN IF NOT EXISTS rules JSONB');
    return new PostgresArchive(pool);
  }

  async save(entry: ArchivedMatch): Promise<void> {
    await this.pool.query(
      `INSERT INTO matches (match_id, rounds, history_root, ranking, history, settled_tx, seats, rules)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (match_id) DO UPDATE SET settled_tx = EXCLUDED.settled_tx`,
      [
        entry.result.matchId,
        entry.result.rounds,
        entry.result.historyRoot,
        JSON.stringify(entry.result.ranking),
        JSON.stringify(entry.history),
        entry.settledTx,
        entry.seats ? JSON.stringify(entry.seats) : null,
        entry.rules ? JSON.stringify(entry.rules) : null,
      ],
    );
  }

  async load(matchId: `0x${string}`): Promise<ArchivedMatch | null> {
    const { rows } = await this.pool.query('SELECT * FROM matches WHERE match_id = $1', [matchId]);
    const row = rows[0];
    return row ? rowToEntry(row) : null;
  }

  async recent(limit: number): Promise<ArchivedMatch[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM matches ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    return rows.map(rowToEntry);
  }
}

function rowToEntry(row: Record<string, unknown>): ArchivedMatch {
  const entry: ArchivedMatch = {
    result: {
      matchId: row.match_id as `0x${string}`,
      rounds: Number(row.rounds),
      historyRoot: row.history_root as `0x${string}`,
      ranking: row.ranking as `0x${string}`[],
    },
    history: row.history as RoundRecord[],
    settledTx: (row.settled_tx as string | null) ?? null,
  };
  if (row.seats) entry.seats = row.seats as Seat[];
  if (row.rules) entry.rules = row.rules as Rules;
  return entry;
}

export async function createArchive(databaseUrl: string): Promise<MatchArchive> {
  if (!databaseUrl) return new MemoryArchive();
  try {
    return await PostgresArchive.connect(databaseUrl);
  } catch (error) {
    console.warn('[store] falling back to in-memory archive:', errorMessage(error));
    return new MemoryArchive();
  }
}

