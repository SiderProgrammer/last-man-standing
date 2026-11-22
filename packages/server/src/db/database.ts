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
  session(): Promise<Session>;
  close(): Promise<void>;
}

/** A connection held out of the pool. */
export interface Session extends Queryable {
  /** Gives it back to the pool; with an error, destroys it instead, so a broken connection is never handed out again. */
  release(error?: Error): void;
  /**
   * Told when the connection fails while held and idle: the database closing
   * it, a dropped network. With no listener, `pg` throws that error and the
   * process dies.
   */
  on(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
}

/** Another server is already running against this database. */
export class InstanceLockHeld extends Error {
  override name = 'InstanceLockHeld';
}

/** The advisory lock key one server instance holds for its whole life. */
const INSTANCE_LOCK = 7429;

/** Held, per transaction, by whichever process is applying a migration. */
const MIGRATION_LOCK = 7428;

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
 * The database can close that connection under a running server: a
 * serverless host scaling to zero, a restart, an admin. The lock goes with
 * it, so the server takes it again on a new connection, retrying with
 * backoff while the database is unreachable. Should another server have
 * taken the lock in between, `onLost` is told once and nothing is retried:
 * two servers must not both run, and this one is the one to stop.
 *
 * @returns Releases the lock and its connection, and stops any retry.
 */
export async function claimInstance(database: Database, options: InstanceClaimOptions = {}): Promise<() => Promise<void>> {
  const retryDelay = options.retryDelayMs ?? ((attempt: number) => Math.min(LOCK_RETRY_MAX_MS, LOCK_RETRY_FIRST_MS * 2 ** attempt));
  let session: Session | null = null;
  let released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const failed = (held: Session, error: Error): void => {
    // Only the connection holding the lock now: an earlier one is already gone.
    if (held !== session) return;
    session = null;
    held.release(error);
    if (released) return;
    console.warn(`[db] lost the connection holding the instance lock (${errorMessage(error)}); taking the lock again`);
    retake(0);
  };

  const retake = (attempt: number): void => {
    timer = setTimeout(() => {
      timer = undefined;
      if (released) return;
      takeInstanceLock(database, failed).then(
        (held) => {
          if (released) return void unlockInstance(held);
          session = held;
          console.log('[db] took the instance lock again');
        },
        (error: unknown) => {
          if (released) return;
          if (error instanceof InstanceLockHeld) {
            console.error('[db] another server took the instance lock while this one was disconnected');
            options.onLost?.(error);
            return;
          }
          console.warn(`[db] could not take the instance lock again (${errorMessage(error)}); retrying`);
          retake(attempt + 1);
        },
      );
    }, retryDelay(attempt));
    // A retry pending must not by itself keep a stopping process alive.
    timer.unref?.();
  };

  session = await takeInstanceLock(database, failed);
  return async () => {
    released = true;
    if (timer) clearTimeout(timer);
    const held = session;
    session = null;
    if (held) await unlockInstance(held);
  };
}

export interface InstanceClaimOptions {
  /** Told once if another server took the lock while this one's connection was down: this server must stop. */
  onLost?: (error: InstanceLockHeld) => void;
  /** How long to wait before retry `attempt` (0 first) to take the lock again. */
  retryDelayMs?: (attempt: number) => number;
}

/** The first wait before taking the instance lock again, doubled on each failure up to the cap. */
const LOCK_RETRY_FIRST_MS = 1_000;
const LOCK_RETRY_MAX_MS = 30_000;

/**
 * Takes the instance lock on a connection of its own, or throws
 * `InstanceLockHeld`. The connection's errors go to `failed` from the moment
 * it is out of the pool, so not one of them can crash the process.
 */
async function takeInstanceLock(database: Database, failed: (held: Session, error: Error) => void): Promise<Session> {
  const held = await database.session();
  held.on('error', (error) => failed(held, error));
  let rows: Array<Record<string, unknown>>;
  try {
    ({ rows } = await held.query('SELECT pg_try_advisory_lock($1) AS held', [INSTANCE_LOCK]));
  } catch (error) {
    held.release(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  if (rows[0]?.held !== true) {
    held.release();
    throw new InstanceLockHeld('another server instance is already running against this database; run one');
  }
  return held;
}

async function unlockInstance(held: Session): Promise<void> {
  await held.query('SELECT pg_advisory_unlock($1)', [INSTANCE_LOCK]).catch(() => undefined);
  held.release();
}

/** The parts of `pg.Pool` used here. */
interface PgPool extends Queryable {
  connect(): Promise<Session>;
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
      // Dropped between two of the transaction's queries, the connection
      // reports it here rather than to a query; the next query then fails,
      // and the connection is destroyed rather than handed out again.
      let lost: Error | undefined;
      const onError = (error: Error): void => {
        lost = error;
        console.warn('[db] connection lost mid-transaction:', errorMessage(error));
      };
      client.on('error', onError);
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        // The pool reuses this connection: one listener per transaction would pile up on it.
        client.removeListener('error', onError);
        client.release(lost);
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
      await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
      const { rows: again } = await tx.query('SELECT 1 FROM schema_migrations WHERE id = $1', [migration.id]);
      if (again.length > 0) return;
      for (const statement of migration.statements) await tx.query(statement);
      await tx.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
      applied.push(migration.id);
    });
  }
  return applied;
}
