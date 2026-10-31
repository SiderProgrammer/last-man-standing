import { MemoryArchive, PostgresArchive, type MatchArchive } from '../lobby/store.js';
import { MemoryStyleBook, PostgresStyleBook, type StyleBook } from '../lobby/styles.js';
import { MemoryJournal, PostgresJournal, type RoomJournal } from '../match/journal.js';
import { connectDatabase, type Database } from './database.js';

/** Every repository the server keeps, over one database or none. */
export interface Storage {
  archive: MatchArchive;
  styles: StyleBook;
  journal: RoomJournal;
  /** The pool behind them, or null when everything is in memory. */
  database: Database | null;
  close(): Promise<void>;
}

/**
 * The storage a configuration names: Postgres for a database URL, memory for
 * none. A database that is named but cannot be reached is an error, never a
 * quiet fall back to memory: a staked match is settled only once its
 * transcript is archived, and a transcript in memory dies with the process,
 * taking the evidence for a result still inside its challenge window with it.
 * `loadConfig` turns `ARCHIVE=memory` into no URL, and refuses a production
 * server with neither.
 */
export async function openStorage(databaseUrl: string): Promise<Storage> {
  if (!databaseUrl) {
    return {
      archive: new MemoryArchive(),
      styles: new MemoryStyleBook(),
      journal: new MemoryJournal(),
      database: null,
      close: async () => undefined,
    };
  }
  return storageOn(await connectDatabase(databaseUrl));
}

/** The Postgres repositories over a database that is already migrated. */
export function storageOn(database: Database): Storage {
  return {
    archive: new PostgresArchive(database),
    styles: new PostgresStyleBook(database),
    journal: new PostgresJournal(database),
    database,
    close: () => database.close(),
  };
}
