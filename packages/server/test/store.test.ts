import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, type MatchAnalysis, type MatchResult } from '@lms/protocol';
import {
  Lobby,
  MemoryArchive,
  MemoryStyleBook,
  MIGRATIONS,
  PostgresArchive,
  PostgresStyleBook,
  migrate,
  openStorage,
  claimInstance,
  InstanceLockHeld,
  type MatchArchive,
  type StyleBook,
  nullRelayer,
  transcriptResponse,
  type ArchivedMatch,
} from '@lms/server';
import { bytes32, setupWithBots, transcriptOf } from './helpers.js';
import { pglite } from './pglite.js';

function entry(matchId: `0x${string}`, rounds = 3, settledTx: string | null = null): ArchivedMatch {
  const result: MatchResult = {
    matchId,
    rounds,
    historyRoot: bytes32(`root:${matchId}:${rounds}`),
    ranking: ['0x00000000000000000000000000000000000000a1'],
  };
  const fields = {
    result,
    history: [],
    seats: [{ index: 0, address: '0x00000000000000000000000000000000000000a1' as const, chainId: 0 }],
    rules: DEFAULT_RULES,
    seed: bytes32(`seed:${matchId}`),
  };
  return { ...fields, ...transcriptOf(fields), settledTx, staked: false, finishedAt: 1_000 };
}

describe.each([
  ['memory', async (): Promise<MatchArchive> => new MemoryArchive()],
  ['postgres', async (): Promise<MatchArchive> => new PostgresArchive(await pglite())],
])('%s archive', (_name, open) => {
  it('round-trips a saved match', async () => {
    const archive = await open();
    const saved = entry(bytes32('one'), 5, '0xdeadbeef');
    await archive.save(saved);

    expect(await archive.load(saved.result.matchId)).toEqual(saved);
  });

  it('returns null for a match it never saw', async () => {
    expect(await (await open()).load(bytes32('missing'))).toBeNull();
  });

  it('looks up a match id case-insensitively', async () => {
    const archive = await open();
    const id = bytes32('case');
    await archive.save(entry(id));

    const upper = id.toUpperCase().replace('0X', '0x') as `0x${string}`;
    expect(await archive.load(upper)).not.toBeNull();
    await archive.recordSettlement(upper, '0x5e771ed');
    expect((await archive.load(id))?.settledTx).toBe('0x5e771ed');
  });

  it('stores a match saved under a mixed-case id under its lower-cased one', async () => {
    const archive = await open();
    const id = bytes32('mixed');
    const upper = id.toUpperCase().replace('0X', '0x') as `0x${string}`;
    const saved = entry(upper);
    await archive.save(saved);
    expect((await archive.load(id))?.result.matchId.toLowerCase()).toBe(id);
    expect((await archive.loadByTranscript(saved.transcriptHash))?.transcript).toEqual(saved.transcript);
  });

  it('keeps an analysis per match, seat and version, whatever the case of the id', async () => {
    const archive = await open();
    const id = bytes32('analysed');
    const upper = id.toUpperCase().replace('0X', '0x') as `0x${string}`;
    const analysis: MatchAnalysis = {
      matchId: upper,
      seat: 2,
      summary: 's',
      decisiveRound: null,
      keyMoments: [],
      advice: [],
      dropped: 0,
      model: 'm',
    };
    await archive.saveAnalysis({ analysis, version: 'v1' });
    expect(await archive.loadAnalysis(id, 2, 'v1')).toEqual(analysis);
    expect(await archive.loadAnalysis(id, null, 'v1')).toBeNull();
    expect(await archive.loadAnalysis(id, 2, 'v2')).toBeNull();
  });

  it('overwrites a match saved twice without listing it twice', async () => {
    const archive = await open();
    const id = bytes32('resave');
    await archive.save(entry(id, 3));
    await archive.save(entry(id, 9));

    expect((await archive.load(id))?.result.rounds).toBe(9);
    expect(await archive.recent(10)).toHaveLength(1);
  });

  it("finds a wallet's matches, newest first, before a cursor", async () => {
    const archive = await open();
    // Upper-cased: looked up case-insensitively, like every other address.
    const you = '0x00000000000000000000000000000000000000A1' as const;
    const other = '0x00000000000000000000000000000000000000b2' as const;
    const theirs = entry(bytes32('b'));
    await archive.save({ ...entry(bytes32('a')), finishedAt: 1 });
    await archive.save({
      ...theirs,
      result: { ...theirs.result, ranking: [other] },
      seats: [{ index: 0, address: other, chainId: 0 }],
      finishedAt: 2,
    });
    await archive.save({ ...entry(bytes32('c')), finishedAt: 3 });

    expect((await archive.forPlayer(you, 10)).map((item) => item.finishedAt)).toEqual([3, 1]);
    expect((await archive.forPlayer(you, 1)).map((item) => item.finishedAt)).toEqual([3]);
    expect((await archive.forPlayer(you, 10, 3)).map((item) => item.finishedAt)).toEqual([1]);
    expect(await archive.forPlayer(other, 10, 2)).toEqual([]);
  });

  it('lists the most recent matches first, capped at the limit', async () => {
    const archive = await open();
    for (const [i, label] of ['a', 'b', 'c'].entries()) await archive.save({ ...entry(bytes32(label)), finishedAt: i });

    const recent = await archive.recent(2);
    expect(recent.map((item) => item.result.matchId)).toEqual([bytes32('c'), bytes32('b')]);
  });
});

describe('archiving a finished match', () => {
  it('records who sat where, the rules and whether it was staked, which the analyst needs', async () => {
    const archive = new MemoryArchive();
    const lobby = new Lobby({ archive, relayer: nullRelayer, commitMs: 10, revealMs: 10 });
    const setup = setupWithBots(4, 'archive-seats');
    lobby.adopt(setup, [0, 1, 2, 3], 0);

    let saved: ArchivedMatch | null = null;
    for (let now = 20; saved === null && now < 20 * 200; now += 20) {
      lobby.tick(now);
      await new Promise((resolve) => setImmediate(resolve));
      saved = await archive.load(setup.matchId);
    }

    expect(saved?.seats).toEqual(setup.seats);
    expect(saved?.rules).toEqual(setup.rules);
    // Adopted from the chain, so staked: public to spectators' analyses.
    expect(saved?.staked).toBe(true);
    // Without the seed nothing could replay it later, so the history could not reopen it.
    expect(saved?.seed).toBe(setup.seed);
    expect(saved?.finishedAt).toEqual(expect.any(Number));
  });
});

describe('transcript route', () => {
  it('serves a staked match\'s transcript by its hash, and nothing else', async () => {
    const archive = new MemoryArchive();
    const staked = { ...entry(bytes32('staked')), staked: true };
    const practice = entry(bytes32('practice'));
    await archive.save(staked);
    await archive.save(practice);

    const found = await transcriptResponse(archive, `/transcripts/${staked.transcriptHash}`);
    expect(found?.status).toBe(200);
    expect(JSON.parse(found?.body ?? '')).toEqual(staked.transcript);
    // Practice matches are their player's own.
    expect((await transcriptResponse(archive, `/transcripts/${practice.transcriptHash}`))?.status).toBe(404);
    expect((await transcriptResponse(archive, `/transcripts/${bytes32('unknown')}`))?.status).toBe(404);
    expect((await transcriptResponse(archive, '/transcripts/nope'))?.status).toBe(400);
    expect(await transcriptResponse(archive, '/health')).toBeNull();
  });
});

describe('choosing an archive', () => {
  it('keeps the archive in memory when no database is named', async () => {
    expect((await openStorage('')).archive).toBeInstanceOf(MemoryArchive);
  });

  it('refuses to start on a database it cannot reach, rather than falling back to memory', async () => {
    await expect(openStorage('postgres://127.0.0.1:1/unreachable')).rejects.toThrow();
  });
});

describe.each([
  ['memory', async (): Promise<StyleBook> => new MemoryStyleBook()],
  ['postgres', async (): Promise<StyleBook> => new PostgresStyleBook(await pglite())],
])('%s style book', (_name, open) => {
  it("adds every settled match to a wallet's record, and knows nobody else", async () => {
    const book = await open();
    const you = '0x00000000000000000000000000000000000000a1';
    const delta = { matches: 1, wins: 1, strikes: 3, guards: 1, charges: 0, noShows: 0 };
    await book.record(new Map([[you, delta]]));
    await book.record(new Map([[you, { ...delta, wins: 0 }]]));

    const found = await book.lookup(['0x00000000000000000000000000000000000000A1', '0x00000000000000000000000000000000000000b2']);
    expect([...found.keys()]).toEqual([you]);
    expect(found.get(you)).toEqual({ matches: 2, wins: 1, strikes: 6, guards: 2, charges: 0, noShows: 0 });
  });
});

describe('migrations', () => {
  it('applies each migration once, in order, and records it', async () => {
    const database = await pglite([]);
    expect(await migrate(database)).toEqual(MIGRATIONS.map((migration) => migration.id));
    expect(await migrate(database)).toEqual([]);
    const { rows } = await database.query('SELECT id FROM schema_migrations ORDER BY id');
    expect(rows.map((row) => row.id)).toEqual(MIGRATIONS.map((migration) => migration.id));
  });

  it('rolls a failing migration back whole, and applies nothing after it', async () => {
    const database = await pglite([]);
    const broken = [
      { id: '0001_good', statements: ['CREATE TABLE good (id INTEGER)'] },
      { id: '0002_bad', statements: ['CREATE TABLE half (id INTEGER)', 'SELECT * FROM missing'] },
      { id: '0003_after', statements: ['CREATE TABLE after (id INTEGER)'] },
    ];
    await expect(migrate(database, broken)).rejects.toThrow(/missing/);
    const { rows } = await database.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('good', 'half', 'after')",
    );
    expect(rows.map((row) => row.table_name)).toEqual(['good']);
    expect((await database.query('SELECT id FROM schema_migrations')).rows.map((row) => row.id)).toEqual(['0001_good']);
  });

  it('lower-cases the ids of matches archived before every save did', async () => {
    const database = await pglite(MIGRATIONS.slice(0, 2));
    const id = bytes32('legacy');
    const upper = id.toUpperCase().replace('0X', '0x') as `0x${string}`;
    // Written as the archive used to write it: the id verbatim.
    await new PostgresArchive(database).save(entry(id));
    await database.query('UPDATE matches SET match_id = $1', [upper]);

    await migrate(database);
    expect((await new PostgresArchive(database).load(id))?.result.matchId).toBe(id);
  });
});

describe('one server per database', () => {
  it('claims the database with a lock held for as long as the server runs', async () => {
    const database = await pglite();
    const release = await claimInstance(database);
    const { rows } = await database.query("SELECT count(*)::int AS locks FROM pg_locks WHERE locktype = 'advisory'");
    expect(rows[0]?.locks).toBe(1);
    await release();
    const after = await database.query("SELECT count(*)::int AS locks FROM pg_locks WHERE locktype = 'advisory'");
    expect(after.rows[0]?.locks).toBe(0);
  });

  it('refuses to start a second server while another holds the lock, and gives its connection back', async () => {
    let released = 0;
    const database = {
      query: async () => ({ rows: [] }),
      transaction: async () => undefined as never,
      close: async () => undefined,
      session: async () => ({
        query: async () => ({ rows: [{ held: false }] }),
        release: () => {
          released += 1;
        },
      }),
    };
    await expect(claimInstance(database)).rejects.toBeInstanceOf(InstanceLockHeld);
    expect(released).toBe(1);
  });
});
