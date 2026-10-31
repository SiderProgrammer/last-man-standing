import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, type MatchResult } from '@lms/protocol';
import {
  Lobby,
  MemoryArchive,
  createArchive,
  createStyleBook,
  nullRelayer,
  transcriptResponse,
  type ArchivedMatch,
} from '@lms/server';
import { bytes32, setupWithBots, transcriptOf } from './helpers.js';

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

describe('memory archive', () => {
  it('round-trips a saved match', async () => {
    const archive = new MemoryArchive();
    const saved = entry(bytes32('one'), 5, '0xdeadbeef');
    await archive.save(saved);

    expect(await archive.load(saved.result.matchId)).toEqual(saved);
  });

  it('returns null for a match it never saw', async () => {
    expect(await new MemoryArchive().load(bytes32('missing'))).toBeNull();
  });

  it('looks up a match id case-insensitively', async () => {
    // Characterisation: `MemoryArchive` lower-cases the key on both save and
    // load, while `PostgresArchive` stores and queries the id verbatim. One
    // port, two behaviours — fixed in `docs/FIX_PLAN.md` step 7.2.
    const archive = new MemoryArchive();
    const id = bytes32('case');
    await archive.save(entry(id));

    const upper = id.toUpperCase().replace('0X', '0x') as `0x${string}`;
    expect(await archive.load(upper)).not.toBeNull();
  });

  it('overwrites a match saved twice without listing it twice', async () => {
    const archive = new MemoryArchive();
    const id = bytes32('resave');
    await archive.save(entry(id, 3));
    await archive.save(entry(id, 9));

    expect((await archive.load(id))?.result.rounds).toBe(9);
    expect(await archive.recent(10)).toHaveLength(1);
  });

  it("finds a wallet's matches, newest first, before a cursor", async () => {
    const archive = new MemoryArchive();
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
    const archive = new MemoryArchive();
    for (const label of ['a', 'b', 'c']) await archive.save(entry(bytes32(label)));

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
    expect(await createArchive('')).toBeInstanceOf(MemoryArchive);
  });

  it('refuses to start on a database it cannot reach, rather than falling back to memory', async () => {
    await expect(createArchive('postgres://127.0.0.1:1/unreachable')).rejects.toThrow();
    await expect(createStyleBook('postgres://127.0.0.1:1/unreachable')).rejects.toThrow();
  });
});
