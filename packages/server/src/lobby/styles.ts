import { addStyles, addressKey, emptyStyle, errorMessage, type PlayStyle } from '@lms/protocol';

/**
 * Play styles by wallet, accumulated from every settled staked match.
 *
 * Practice matches do not count: the opponents are house bots, and a human's
 * record against bots says little about how they play people.
 */
export interface StyleBook {
  record(deltas: ReadonlyMap<string, PlayStyle>): Promise<void>;
  /** Styles for the given wallets, keyed by lowercased address. Strangers are absent. */
  lookup(addresses: readonly `0x${string}`[]): Promise<Map<string, PlayStyle>>;
}

export class MemoryStyleBook implements StyleBook {
  private readonly styles = new Map<string, PlayStyle>();

  async record(deltas: ReadonlyMap<string, PlayStyle>): Promise<void> {
    for (const [key, delta] of deltas) {
      this.styles.set(key, addStyles(this.styles.get(key) ?? emptyStyle(), delta));
    }
  }

  async lookup(addresses: readonly `0x${string}`[]): Promise<Map<string, PlayStyle>> {
    const found = new Map<string, PlayStyle>();
    for (const address of addresses) {
      const style = this.styles.get(addressKey(address));
      if (style) found.set(addressKey(address), { ...style });
    }
    return found;
  }
}

interface PgPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** Postgres-backed style book; `pg` stays optional, as for the archive. */
export class PostgresStyleBook implements StyleBook {
  private constructor(private readonly pool: PgPool) {}

  static async connect(connectionString: string): Promise<PostgresStyleBook> {
    const specifier = 'pg';
    const pg = (await import(specifier)) as {
      default?: { Pool: new (config: { connectionString: string }) => PgPool };
      Pool?: new (config: { connectionString: string }) => PgPool;
    };
    const Pool = pg.Pool ?? pg.default?.Pool;
    if (!Pool) throw new Error('pg is installed but does not export Pool');
    const pool = new Pool({ connectionString });
    // Idle connections dropped by the host would otherwise crash the process; see the archive.
    pool.on('error', (error) => console.warn('[styles] idle database connection lost:', errorMessage(error)));
    // The action set changed from Attack / Defend / Hide to Strike / Guard /
    // Charge, so records from the old game are a different game's habits and
    // stay in the old `play_styles` table.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS play_styles_v2 (
        address  TEXT PRIMARY KEY,
        matches  INTEGER NOT NULL DEFAULT 0,
        wins     INTEGER NOT NULL DEFAULT 0,
        strikes  INTEGER NOT NULL DEFAULT 0,
        guards   INTEGER NOT NULL DEFAULT 0,
        charges  INTEGER NOT NULL DEFAULT 0,
        no_shows INTEGER NOT NULL DEFAULT 0
      )
    `);
    return new PostgresStyleBook(pool);
  }

  async record(deltas: ReadonlyMap<string, PlayStyle>): Promise<void> {
    for (const [key, d] of deltas) {
      await this.pool.query(
        `INSERT INTO play_styles_v2 (address, matches, wins, strikes, guards, charges, no_shows)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (address) DO UPDATE SET
           matches = play_styles_v2.matches + EXCLUDED.matches,
           wins = play_styles_v2.wins + EXCLUDED.wins,
           strikes = play_styles_v2.strikes + EXCLUDED.strikes,
           guards = play_styles_v2.guards + EXCLUDED.guards,
           charges = play_styles_v2.charges + EXCLUDED.charges,
           no_shows = play_styles_v2.no_shows + EXCLUDED.no_shows`,
        [key, d.matches, d.wins, d.strikes, d.guards, d.charges, d.noShows],
      );
    }
  }

  async lookup(addresses: readonly `0x${string}`[]): Promise<Map<string, PlayStyle>> {
    const keys = addresses.map(addressKey);
    const { rows } = await this.pool.query('SELECT * FROM play_styles_v2 WHERE address = ANY($1)', [keys]);
    return new Map(
      rows.map((row) => [
        row.address as string,
        {
          matches: Number(row.matches),
          wins: Number(row.wins),
          strikes: Number(row.strikes),
          guards: Number(row.guards),
          charges: Number(row.charges),
          noShows: Number(row.no_shows),
        },
      ]),
    );
  }
}

export async function createStyleBook(databaseUrl: string): Promise<StyleBook> {
  if (!databaseUrl) return new MemoryStyleBook();
  try {
    return await PostgresStyleBook.connect(databaseUrl);
  } catch (error) {
    console.warn('[styles] falling back to in-memory style book:', errorMessage(error));
    return new MemoryStyleBook();
  }
}
