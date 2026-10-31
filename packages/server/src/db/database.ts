import { errorMessage } from '@lms/api';
import { MIGRATIONS, type Migration } from './migrations.js';

/** Anything SQL can be sent to: the pool, or one transaction's connection. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * The one connection pool the server holds. Every repository — the archive,
 * the style book, the room journal — takes this rather than opening a pool
 * of its own, so the process holds one set of connections and one place
 * decides how they are made.
 */
export interface Database extends Queryable {
  /** Runs `work` on one connection inside BEGIN … COMMIT, rolled back if it throws. */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  /** A connection of its own, out of the pool until released: what a session-level lock needs. */
  session(): Promise<Queryable & { release(): void }>;
  close(): Promise<void>;
}

/** Another server is already running against this database. */
export class InstanceLockHeld extends Error {
  override name = 'InstanceLockHeld';
}

/** The advisory lock key one server instance holds for its whole life. */
const INSTANCE_LOCK = 7429;

/**
 * Claims the database for this process, or throws `InstanceLockHeld`.
 *
 * The server is one instance by design: rooms, the matchmaking queue and
 * every rate limit live in its memory, and a second instance would split
 * them, and send the keeper's transactions twice. So the first thing a
 * server does with its database is take a session-level advisory lock on a
 * connection it keeps for as long as it runs; a second server against the
 * same database is refused at start. The lock goes with the connection, so
 * a crashed server frees it.
 *
 * @returns Releases the lock and its connection.
 */
export async function claimInstance(database: Database): Promise<() => Promise<void>> {
  const session = await database.session();
  const { rows } = await session.query('SELECT pg_try_advisory_lock($1) AS held', [INSTANCE_LOCK]);
  if (rows[0]?.held !== true) {
    session.release();
    throw new InstanceLockHeld('another server instance is already running against this database; run one');
  }
  return async () => {
    await session.query('SELECT pg_advisory_unlock($1)', [INSTANCE_LOCK]).catch(() => undefined);
    session.release();
  };
}

/** The parts of `pg.Pool` used here. */
interface PgPool extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  end(): Promise<void>;
}

/**
 * Opens the pool for `connectionString` and brings its schema up to date.
 *
 * `pg` is loaded through a computed specifier so it stays an optional
 * dependency: a server with no database never needs it installed.
 */
export async function connectDatabase(connectionString: string): Promise<Database> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as {
    default?: { Pool: new (config: { connectionString: string }) => PgPool };
    Pool?: new (config: { connectionString: string }) => PgPool;
  };
  const Pool = pg.Pool ?? pg.default?.Pool;
  if (!Pool) throw new Error('pg is installed but does not export Pool');

  const pool = new Pool({ connectionString });
  // A serverless host such as Neon drops idle connections when it scales to
  // zero. The pool reports that on an idle client as an `error` event, which
  // would crash the process if nothing listened; the next query reconnects.
  pool.on('error', (error) => console.warn('[db] idle database connection lost:', errorMessage(error)));
  const database = pgDatabase(pool);
  try {
    const applied = await migrate(database);
    if (applied.length > 0) console.log(`[db] applied migrations ${applied.join(', ')}`);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  return database;
}

function pgDatabase(pool: PgPool): Database {
  return {
    query: (text, values) => pool.query(text, values),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    session: () => pool.connect(),
    close: () => pool.end(),
  };
}

/**
 * Applies every migration in `migrations` not yet recorded in
 * `schema_migrations`, in order, each in its own transaction with its record.
 * A migration that fails rolls back whole and stops the rest, so the schema
 * is always some prefix of the list. Returns the ids it applied.
 *
 * Migrations are append-only: one that has shipped is never edited, since a
 * database that already ran it would never see the change. A schema change is
 * a new migration.
 */
export async function migrate(database: Database, migrations: readonly Migration[] = MIGRATIONS): Promise<string[]> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const { rows } = await database.query('SELECT id FROM schema_migrations');
  const done = new Set(rows.map((row) => row.id as string));
  const applied: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.id)) continue;
    await database.transaction(async (tx) => {
      // Two processes starting against one database take turns; the second
      // finds the migration recorded and applies nothing twice.
      await tx.query('SELECT pg_advisory_xact_lock(7428)');
      const { rows: again } = await tx.query('SELECT 1 FROM schema_migrations WHERE id = $1', [migration.id]);
      if (again.length > 0) return;
      for (const statement of migration.statements) await tx.query(statement);
      await tx.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
      applied.push(migration.id);
    });
  }
  return applied;
}
