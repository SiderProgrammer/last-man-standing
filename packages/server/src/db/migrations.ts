/** One step of the schema, applied once, in order. See `migrate`. */
export interface Migration {
  /** Sorts in the order the migrations apply. Never renamed once shipped. */
  id: string;
  statements: readonly string[];
}

/**
 * The schema, as every change made to it. Append only.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_matches',
    statements: [
      `CREATE TABLE IF NOT EXISTS matches (
        -- Lower-cased, as every lookup is.
        match_id     TEXT PRIMARY KEY,
        rounds       INTEGER NOT NULL,
        history_root TEXT NOT NULL,
        ranking      JSONB NOT NULL,
        history      JSONB NOT NULL,
        settled_tx   TEXT,
        seats        JSONB NOT NULL,
        rules        JSONB NOT NULL,
        staked       BOOLEAN NOT NULL,
        seed         TEXT NOT NULL,
        -- Lower-cased seat addresses, so one wallet's history is an index lookup.
        players      TEXT[] NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL,
        transcript   JSONB NOT NULL,
        -- Lower-cased, as the transcript route looks it up.
        transcript_hash TEXT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS matches_players ON matches USING GIN (players)',
      'CREATE UNIQUE INDEX IF NOT EXISTS matches_transcript_hash ON matches (transcript_hash)',
      'CREATE INDEX IF NOT EXISTS matches_created_at ON matches (created_at DESC)',
      `CREATE TABLE IF NOT EXISTS match_analyses (
        match_id   TEXT NOT NULL,
        seat       INTEGER NOT NULL,
        version    TEXT NOT NULL,
        analysis   JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (match_id, seat, version)
      )`,
    ],
  },
  {
    id: '0002_play_styles',
    statements: [
      // `_v2`: the action set changed from Attack / Defend / Hide to Strike /
      // Guard / Charge, so records from the old game stay in `play_styles`.
      `CREATE TABLE IF NOT EXISTS play_styles_v2 (
        address  TEXT PRIMARY KEY,
        matches  INTEGER NOT NULL DEFAULT 0,
        wins     INTEGER NOT NULL DEFAULT 0,
        strikes  INTEGER NOT NULL DEFAULT 0,
        guards   INTEGER NOT NULL DEFAULT 0,
        charges  INTEGER NOT NULL DEFAULT 0,
        no_shows INTEGER NOT NULL DEFAULT 0
      )`,
    ],
  },
  {
    // Ids written before every save lower-cased them.
    id: '0003_lowercase_match_ids',
    statements: [
      'UPDATE matches SET match_id = lower(match_id) WHERE match_id <> lower(match_id)',
      'UPDATE match_analyses SET match_id = lower(match_id) WHERE match_id <> lower(match_id)',
    ],
  },
  {
    // Everything that moves a staked room on, so a restart resumes it.
    id: '0004_room_journal',
    statements: [
      `CREATE TABLE room_journal (
        match_id TEXT NOT NULL,
        seq      INTEGER NOT NULL,
        entry    JSONB NOT NULL,
        PRIMARY KEY (match_id, seq)
      )`,
    ],
  },
];
