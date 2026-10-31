import { PGlite } from '@electric-sql/pglite';
import { migrate, type Database, type Migration } from '@lms/server';

/**
 * A real Postgres, in process, through the same `Database` port the server's
 * `pg` pool fills: what the migrations and repositories are tested against.
 * Each call is a fresh, empty database.
 */
export async function pglite(migrations?: readonly Migration[]): Promise<Database> {
  const db = new PGlite();
  const database: Database = {
    query: async (text, values) => ({ rows: (await db.query<Record<string, unknown>>(text, values)).rows }),
    transaction: (work) =>
      db.transaction((tx) => work({ query: async (text, values) => ({ rows: (await tx.query<Record<string, unknown>>(text, values)).rows }) })),
    // PGlite is one connection: every session is that one.
    session: async () => ({ query: database.query, release: () => undefined }),
    close: () => db.close(),
  };
  await migrate(database, migrations);
  return database;
}
