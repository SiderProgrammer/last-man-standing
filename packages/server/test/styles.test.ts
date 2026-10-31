import { describe, expect, it } from 'vitest';
import { Action, ZERO_SALT, type RoundRecord } from '@lms/consensus';
import { Lobby, MemoryArchive, MemoryStyleBook, nullRelayer, tallyStyles } from '@lms/server';
import { FakeClient, HUMAN, botSeats, bytes32, setupWithBots } from './helpers.js';

const A = '0x00000000000000000000000000000000000000a1' as const;
const B = '0x00000000000000000000000000000000000000b2' as const;

function record(moves: RoundRecord['moves']): RoundRecord {
  return { round: 1, moves, strikes: [], stallDamage: 0, eliminated: [], hpAfter: [], hash: bytes32('r') };
}

describe('play styles', () => {
  it('tallies one match per seat, by wallet', () => {
    const history = [
      record([
        { index: 0, action: Action.Strike, target: 1, revealed: true, salt: ZERO_SALT, commitment: ZERO_SALT },
        { index: 1, action: Action.Guard, target: 0, revealed: true, salt: ZERO_SALT, commitment: ZERO_SALT },
      ]),
      record([
        { index: 0, action: Action.Charge, target: 0, revealed: true, salt: ZERO_SALT, commitment: ZERO_SALT },
        { index: 1, action: Action.None, target: 0, revealed: false, salt: ZERO_SALT, commitment: ZERO_SALT },
      ]),
    ];
    const styles = tallyStyles(
      { matchId: bytes32('m'), rounds: 2, historyRoot: bytes32('h'), ranking: [B, A] },
      history,
      [A, B],
    );
    expect(styles.get(A.toLowerCase())).toEqual({ matches: 1, wins: 0, strikes: 1, guards: 0, charges: 1, noShows: 0 });
    expect(styles.get(B.toLowerCase())).toEqual({ matches: 1, wins: 1, strikes: 0, guards: 1, charges: 0, noShows: 1 });
  });

  it('records a finished staked match and briefs the next table with it', async () => {
    const styles = new MemoryStyleBook();
    const lobby = new Lobby({
      archive: new MemoryArchive(),
      relayer: nullRelayer,
      commitMs: 1_000,
      revealMs: 1_000,
      styles,
    });

    const first = lobby.adopt(setupWithBots(4, 'styles-1'), botSeats(4), 0);
    let now = 0;
    while (!first.finished) {
      now += 1_001;
      first.tick(now);
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect((await styles.lookup([HUMAN])).get(HUMAN)?.matches).toBe(1);

    // The same wallet sits down again: the table hears about it.
    const second = lobby.adopt(setupWithBots(4, 'styles-2'), botSeats(4), now);
    await new Promise((resolve) => setImmediate(resolve));
    const watcher = new FakeClient(null);
    second.attach(watcher);
    const dossier = watcher.last('dossier');
    expect(dossier?.entries.find((entry) => entry.address === HUMAN)?.style.matches).toBe(1);
  });

  it('does not count practice against house bots', async () => {
    const styles = new MemoryStyleBook();
    const lobby = new Lobby({ archive: new MemoryArchive(), relayer: nullRelayer, commitMs: 1, revealMs: 1, styles });
    const room = lobby.createPractice(HUMAN, 3, 0);
    let now = 0;
    while (!room.finished) {
      now += 2;
      room.tick(now);
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect((await styles.lookup([HUMAN])).size).toBe(0);
  });
});
