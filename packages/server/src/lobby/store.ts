import type { Queryable } from '../db/database.js';
import {
  type MatchAnalysis,
  type MatchResult,
  type RoundRecord,
  type Rules,
  type Seat,
  type Transcript,
} from '@lms/protocol';

export interface ArchivedMatch {
  result: MatchResult;
  history: readonly RoundRecord[];
  settledTx: string | null;
  /** Who sat where. `result.ranking` names the wallets but not their seats. */
  seats: readonly Seat[];
  /** The rule set the match was played under. */
  rules: Rules;
  /**
   * True for a match played for escrowed stakes, which anyone may watch and
   * so anyone may have analysed; false for a practice match, which is the
   * practising player's own.
   */
  staked: boolean;
  /** The oracle seed, without which the browser cannot replay the match. */
  seed: `0x${string}`;
  /** Unix milliseconds the match was archived. */
  finishedAt: number;
  /** Everything needed to check the match without trusting the server: setup, rounds, signatures, grants. */
  transcript: Transcript;
  /** `hashTranscript(transcript)`: what `settle` carried, and what anyone can fetch the transcript by. */
  transcriptHash: `0x${string}`;
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
  /** Records the transaction that proposed an archived match's result. */
  recordSettlement(matchId: `0x${string}`, settledTx: string): Promise<void>;
  load(matchId: `0x${string}`): Promise<ArchivedMatch | null>;
  /** The match whose transcript hashes to `transcriptHash`. */
  loadByTranscript(transcriptHash: `0x${string}`): Promise<ArchivedMatch | null>;
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

  async recordSettlement(matchId: `0x${string}`, settledTx: string): Promise<void> {
    const entry = this.entries.get(matchId.toLowerCase());
    if (entry) this.entries.set(matchId.toLowerCase(), { ...entry, settledTx });
  }

  async load(matchId: `0x${string}`): Promise<ArchivedMatch | null> {
    return this.entries.get(matchId.toLowerCase()) ?? null;
  }

  async loadByTranscript(transcriptHash: `0x${string}`): Promise<ArchivedMatch | null> {
    const key = transcriptHash.toLowerCase();
    for (const entry of this.entries.values()) if (entry.transcriptHash.toLowerCase() === key) return entry;
    return null;
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
      if (before !== undefined && !(entry.finishedAt < before)) continue;
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

/**
 * Postgres-backed archive: the repository over the `matches` and
 * `match_analyses` tables, which `db/migrations.ts` creates. It takes the
 * server's one pool, and holds no SQL that is not about matches.
 *
 * Every match id is lower-cased on the way in and on the way out, as the
 * memory archive keys them, so a lookup never depends on the case an id was
 * first written in.
 */
export class PostgresArchive implements MatchArchive {
  constructor(private readonly pool: Queryable) {}

  async save(entry: ArchivedMatch): Promise<void> {
    await this.pool.query(
      `INSERT INTO matches
         (match_id, rounds, history_root, ranking, history, settled_tx, seats, rules, staked, seed, players, created_at,
          transcript, transcript_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12::double precision / 1000), $13, $14)
       -- Saved again, the match is replaced whole, as the memory archive replaces it.
       ON CONFLICT (match_id) DO UPDATE SET
         rounds = EXCLUDED.rounds, history_root = EXCLUDED.history_root, ranking = EXCLUDED.ranking,
         history = EXCLUDED.history, settled_tx = EXCLUDED.settled_tx, seats = EXCLUDED.seats,
         rules = EXCLUDED.rules, staked = EXCLUDED.staked, seed = EXCLUDED.seed, players = EXCLUDED.players,
         created_at = EXCLUDED.created_at, transcript = EXCLUDED.transcript,
         transcript_hash = EXCLUDED.transcript_hash`,
      [
        entry.result.matchId.toLowerCase(),
        entry.result.rounds,
        entry.result.historyRoot,
        JSON.stringify(entry.result.ranking),
        JSON.stringify(entry.history),
        entry.settledTx,
        JSON.stringify(entry.seats),
        JSON.stringify(entry.rules),
        entry.staked,
        entry.seed,
        playersOf(entry),
        // Stored at millisecond precision, so `finishedAt` read back is exactly
        // the cursor a later `forPlayer` page compares against.
        entry.finishedAt,
        JSON.stringify(entry.transcript),
        entry.transcriptHash.toLowerCase(),
      ],
    );
  }

  async recordSettlement(matchId: `0x${string}`, settledTx: string): Promise<void> {
    await this.pool.query('UPDATE matches SET settled_tx = $2 WHERE match_id = $1', [matchId.toLowerCase(), settledTx]);
  }

  async loadByTranscript(transcriptHash: `0x${string}`): Promise<ArchivedMatch | null> {
    const { rows } = await this.pool.query('SELECT * FROM matches WHERE transcript_hash = $1', [
      transcriptHash.toLowerCase(),
    ]);
    const row = rows[0];
    return row ? rowToEntry(row) : null;
  }

  async load(matchId: `0x${string}`): Promise<ArchivedMatch | null> {
    const { rows } = await this.pool.query('SELECT * FROM matches WHERE match_id = $1', [matchId.toLowerCase()]);
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
  return {
    result: {
      matchId: row.match_id as `0x${string}`,
      rounds: Number(row.rounds),
      historyRoot: row.history_root as `0x${string}`,
      ranking: row.ranking as `0x${string}`[],
    },
    history: row.history as RoundRecord[],
    settledTx: (row.settled_tx as string | null) ?? null,
    seats: row.seats as Seat[],
    rules: row.rules as Rules,
    staked: row.staked as boolean,
    seed: row.seed as `0x${string}`,
    finishedAt: (row.created_at as Date).getTime(),
    transcript: row.transcript as Transcript,
    transcriptHash: row.transcript_hash as `0x${string}`,
  };
}

/** Every wallet that sat in the match, lower-cased. */
function playersOf(entry: ArchivedMatch): string[] {
  return entry.seats.map((seat) => seat.address.toLowerCase());
}
