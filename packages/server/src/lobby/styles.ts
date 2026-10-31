import { addStyles, addressKey, emptyStyle, type PlayStyle } from '@lms/protocol';
import type { Queryable } from '../db/database.js';

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

/** Postgres-backed style book, the repository over `play_styles_v2`, on the server's one pool. */
export class PostgresStyleBook implements StyleBook {
  constructor(private readonly pool: Queryable) {}

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
