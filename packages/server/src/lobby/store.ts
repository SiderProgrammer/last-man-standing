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
  /** The oracle seed, without which the browser cannot replay the match. Optional for the same reason. */
  seed?: `0x${string}`;
  /** Unix milliseconds the match was archived. Optional for the same reason. */
  finishedAt?: number;
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
  /**
   * The matches a wallet sat in, newest first, at most `limit` of them, and
   * only those archived before `before` (unix ms) when it is given.
   */
  forPlayer(address: `0x${string}`, limit: number, before?: number): Promise<ArchivedMatch[]>;
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

  async forPlayer(address: `0x${string}`, limit: number, before?: number): Promise<ArchivedMatch[]> {
    const key = address.toLowerCase();
    const out: ArchivedMatch[] = [];
    for (let i = this.order.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const entry = this.entries.get(this.order[i] as string);
      if (!entry || !playersOf(entry).includes(key)) continue;
      if (before !== undefined && !((entry.finishedAt ?? 0) < before)) continue;
      out.push(entry);
    }
    return out;
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
    await pool.query('ALTER TABLE matches ADD COLUMN IF NOT EXISTS seed TEXT');
    // Lower-cased seat addresses, so one wallet's history is an index lookup.
    await pool.query('ALTER TABLE matches ADD COLUMN IF NOT EXISTS players TEXT[]');
    await pool.query(`
      UPDATE matches
         SET players = ARRAY(SELECT lower(address) FROM jsonb_array_elements_text(ranking) AS address)
       WHERE players IS NULL
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS matches_players ON matches USING GIN (players)');
    await pool.query('CREATE INDEX IF NOT EXISTS matches_created_at ON matches (created_at DESC)');
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
      `INSERT INTO matches
         (match_id, rounds, history_root, ranking, history, settled_tx, seats, rules, staked, seed, players, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE(to_timestamp($12::double precision / 1000), now()))
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
        entry.seed ?? null,
        playersOf(entry),
        // Stored at millisecond precision, so `finishedAt` read back is exactly
        // the cursor a later `forPlayer` page compares against.
        entry.finishedAt ?? null,
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

  async forPlayer(address: `0x${string}`, limit: number, before?: number): Promise<ArchivedMatch[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM matches
        WHERE players @> ARRAY[$1::text]
          AND ($2::double precision IS NULL OR created_at < to_timestamp($2::double precision / 1000))
        ORDER BY created_at DESC
        LIMIT $3`,
      [address.toLowerCase(), before ?? null, limit],
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
  if (row.seed) entry.seed = row.seed as `0x${string}`;
  if (row.created_at instanceof Date) entry.finishedAt = row.created_at.getTime();
  return entry;
}

/** Every wallet that sat in the match, lower-cased. The ranking names all of them. */
function playersOf(entry: ArchivedMatch): string[] {
  const addresses = entry.seats?.map((seat) => seat.address) ?? entry.result.ranking;
  return addresses.map((address) => address.toLowerCase());
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

