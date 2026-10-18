import {
  errorMessage,
  type MatchAnalysis,
  type MatchResult,
  type RoundRecord,
  type Rules,
  type Seat,
} from '@lms/protocol';

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
  /**
   * True for a match played for escrowed stakes, which anyone may watch and
   * so anyone may have analysed; false for a practice match, which is the
   * practising player's own. Absent on older rows, which are treated as private.
   */
  staked?: boolean;
}

/**
 * A finished analysis, kept so the same question is never paid for twice.
 *
 * Keyed by match, by the seat it was written for (advice differs per seat;
 * null is the spectator's view), and by `version`, a digest of everything
 * that shapes an answer — model, effort, prompt, tools, schema. Changing any
 * of those changes the version, and older answers simply stop matching.
 */
export interface ArchivedAnalysis {
  analysis: MatchAnalysis;
  version: string;
}

export interface MatchArchive {
  save(entry: ArchivedMatch): Promise<void>;
  load(matchId: `0x${string}`): Promise<ArchivedMatch | null>;
  recent(limit: number): Promise<ArchivedMatch[]>;
  saveAnalysis(entry: ArchivedAnalysis): Promise<void>;
  loadAnalysis(matchId: `0x${string}`, seat: number | null, version: string): Promise<MatchAnalysis | null>;
}

/** Seats are 0-255; the spectator's view is stored under -1 so the key has no nulls. */
const SPECTATOR = -1;

function analysisKey(matchId: `0x${string}`, seat: number | null, version: string): string {
  return `${matchId.toLowerCase()}:${seat ?? SPECTATOR}:${version}`;
}

/**
 * Default archive. Everything needed to audit a match is already in the
 * signed result plus the move log, so losing this on restart costs history
 * browsing, not correctness.
 */
export class MemoryArchive implements MatchArchive {
  private readonly entries = new Map<string, ArchivedMatch>();
  private readonly order: string[] = [];
  private readonly analyses = new Map<string, MatchAnalysis>();

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

  async saveAnalysis(entry: ArchivedAnalysis): Promise<void> {
    this.analyses.set(analysisKey(entry.analysis.matchId, entry.analysis.seat, entry.version), entry.analysis);
  }

  async loadAnalysis(matchId: `0x${string}`, seat: number | null, version: string): Promise<MatchAnalysis | null> {
    return this.analyses.get(analysisKey(matchId, seat, version)) ?? null;
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

  /** Wraps a pool whose tables already exist; `connect` is the normal way in. */
  static fromPool(pool: PgPool): PostgresArchive {
    return new PostgresArchive(pool);
  }

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
    await pool.query('ALTER TABLE matches ADD COLUMN IF NOT EXISTS staked BOOLEAN');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS match_analyses (
        match_id   TEXT NOT NULL,
        seat       INTEGER NOT NULL,
        version    TEXT NOT NULL,
        analysis   JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (match_id, seat, version)
      )
    `);
    return new PostgresArchive(pool);
  }

  async save(entry: ArchivedMatch): Promise<void> {
    await this.pool.query(
      `INSERT INTO matches (match_id, rounds, history_root, ranking, history, settled_tx, seats, rules, staked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
        entry.staked ?? null,
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

  async saveAnalysis(entry: ArchivedAnalysis): Promise<void> {
    // Lower-cased like the memory archive's keys, so either finds what the other wrote.
    await this.pool.query(
      `INSERT INTO match_analyses (match_id, seat, version, analysis)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (match_id, seat, version) DO NOTHING`,
      [
        entry.analysis.matchId.toLowerCase(),
        entry.analysis.seat ?? SPECTATOR,
        entry.version,
        JSON.stringify(entry.analysis),
      ],
    );
  }

  async loadAnalysis(matchId: `0x${string}`, seat: number | null, version: string): Promise<MatchAnalysis | null> {
    const { rows } = await this.pool.query(
      'SELECT analysis FROM match_analyses WHERE match_id = $1 AND seat = $2 AND version = $3',
      [matchId.toLowerCase(), seat ?? SPECTATOR, version],
    );
    return (rows[0]?.analysis as MatchAnalysis | undefined) ?? null;
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
  if (typeof row.staked === 'boolean') entry.staked = row.staked;
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

