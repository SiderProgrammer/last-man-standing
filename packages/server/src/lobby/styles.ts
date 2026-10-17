import { addStyles, addressKey, emptyStyle, errorMessage, type PlayStyle } from '@lms/protocol';
import { log } from '../observability/log.js';

const logger = log.child({ component: 'styles' });

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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS play_styles (
        address  TEXT PRIMARY KEY,
        matches  INTEGER NOT NULL DEFAULT 0,
        wins     INTEGER NOT NULL DEFAULT 0,
        attacks  INTEGER NOT NULL DEFAULT 0,
        defends  INTEGER NOT NULL DEFAULT 0,
        hides    INTEGER NOT NULL DEFAULT 0,
        no_shows INTEGER NOT NULL DEFAULT 0
      )
    `);
    return new PostgresStyleBook(pool);
  }

  async record(deltas: ReadonlyMap<string, PlayStyle>): Promise<void> {
    for (const [key, d] of deltas) {
      await this.pool.query(
        `INSERT INTO play_styles (address, matches, wins, attacks, defends, hides, no_shows)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (address) DO UPDATE SET
           matches = play_styles.matches + EXCLUDED.matches,
           wins = play_styles.wins + EXCLUDED.wins,
           attacks = play_styles.attacks + EXCLUDED.attacks,
           defends = play_styles.defends + EXCLUDED.defends,
           hides = play_styles.hides + EXCLUDED.hides,
           no_shows = play_styles.no_shows + EXCLUDED.no_shows`,
        [key, d.matches, d.wins, d.attacks, d.defends, d.hides, d.noShows],
      );
    }
  }

  async lookup(addresses: readonly `0x${string}`[]): Promise<Map<string, PlayStyle>> {
    const keys = addresses.map(addressKey);
    const { rows } = await this.pool.query('SELECT * FROM play_styles WHERE address = ANY($1)', [keys]);
    return new Map(
      rows.map((row) => [
        row.address as string,
        {
          matches: Number(row.matches),
          wins: Number(row.wins),
          attacks: Number(row.attacks),
          defends: Number(row.defends),
          hides: Number(row.hides),
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
    logger.warn('falling back to in-memory style book', { error: errorMessage(error) });
    return new MemoryStyleBook();
  }
}
