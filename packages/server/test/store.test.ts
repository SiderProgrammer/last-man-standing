import { describe, expect, it } from 'vitest';
import type { MatchResult } from '@lms/protocol';
import { Lobby, MemoryArchive, nullRelayer, type ArchivedMatch } from '@lms/server';
import { bytes32, setupWithBots } from './helpers.js';

function entry(matchId: `0x${string}`, rounds = 3, settledTx: string | null = null): ArchivedMatch {
  const result: MatchResult = {
    matchId,
    rounds,
    historyRoot: bytes32(`root:${matchId}:${rounds}`),
    ranking: ['0x00000000000000000000000000000000000000a1'],
  };
  return { result, history: [], settledTx };
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
    // port, two behaviours — see `docs/TODO.md` §3.4.
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
  });
});
