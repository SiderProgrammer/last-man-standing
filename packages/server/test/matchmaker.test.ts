import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import type { LobbyInfo, QueueRange, ServerMessage } from '@lms/api';
import { Matchmaker, type MatchmakerPort } from '@lms/server';

const STAKE = '1000000000000000';
const HIGHER = '5000000000000000';
const TOP = '10000000000000000';

/** A range: exactly `STAKE` at exactly `seats` seats, unless told otherwise. */
function range(seats: number, overrides: Partial<QueueRange> = {}): QueueRange {
  return { minStake: STAKE, maxStake: STAKE, minSeats: seats, maxSeats: seats, ...overrides };
}

function wallet(n: number): Address {
  return `0x${(n + 0x100).toString(16).padStart(40, '0')}` as Address;
}

/** A matchmaker over a fake escrow, recording every lobby opened and every notice sent. */
function harness(options: { fail?: () => boolean; fillAfterMs?: number; lobbies?: () => LobbyInfo[] } = {}) {
  const opened: Array<{ stake: bigint; seats: number; roster: readonly Address[] }> = [];
  const told: Array<{ player: Address; message: ServerMessage }> = [];
  const port: MatchmakerPort = {
    async create(stake, seats, roster) {
      if (options.fail?.()) throw new Error('rpc down');
      opened.push({ stake, seats, roster });
      return `0x${opened.length.toString(16).padStart(64, '0')}`;
    },
  };
  let now = 0;
  const matchmaker = new Matchmaker({
    port,
    minSeats: 4,
    maxSeats: 8,
    fillAfterMs: options.fillAfterMs ?? 30_000,
    notify: (player, message) => told.push({ player, message }),
    ...(options.lobbies ? { lobbies: options.lobbies, chainTime: () => Math.floor(now / 1000) } : {}),
    now: () => now,
  });
  return {
    matchmaker,
    opened,
    told,
    advance: (ms: number) => {
      now += ms;
    },
    matched: () => told.filter(({ message }) => message.type === 'matched'),
  };
}

describe('matchmaker', () => {
  it('opens a lobby once a table is full, with exactly those players on its roster', async () => {
    const { matchmaker, opened, matched } = harness();
    for (let i = 0; i < 5; i += 1) matchmaker.join(wallet(i), range(4));
    await matchmaker.tick();

    expect(opened).toEqual([{ stake: BigInt(STAKE), seats: 4, roster: [wallet(0), wallet(1), wallet(2), wallet(3)] }]);
    expect(matched().map(({ player }) => player)).toEqual([wallet(0), wallet(1), wallet(2), wallet(3)]);
    expect(matched()[0]?.message).toEqual({ type: 'matched', matchId: `0x${'1'.padStart(64, '0')}`, stake: STAKE, seats: 4 });
    // The fifth waits for the next table.
    expect(matchmaker.size).toBe(1);
  });

  it('opens a short table once the first in line has waited long enough, and not before', async () => {
    const { matchmaker, opened, advance } = harness();
    for (let i = 0; i < 5; i += 1) matchmaker.join(wallet(i), range(4, { maxSeats: 8 }));
    await matchmaker.tick();
    expect(opened).toHaveLength(0);

    advance(30_000);
    await matchmaker.tick();
    expect(opened[0]?.roster).toHaveLength(5);
    // As many seats as players, so it locks the moment the last one stakes.
    expect(opened[0]?.seats).toBe(5);
  });

  it('never opens a table short of the fewest seats a match starts with', async () => {
    const { matchmaker, opened, advance } = harness();
    for (let i = 0; i < 3; i += 1) matchmaker.join(wallet(i), range(4, { maxSeats: 8 }));
    advance(10 * 60_000);
    await matchmaker.tick();
    expect(opened).toHaveLength(0);
  });

  it('tells everyone queued how many share their range, as it changes', () => {
    const { matchmaker, told } = harness();
    matchmaker.join(wallet(0), range(4));
    matchmaker.join(wallet(1), range(4));
    matchmaker.leave(wallet(0));
    const last = told.filter(({ player }) => player === wallet(1)).at(-1)?.message;
    expect(last).toEqual({ type: 'queued', ...range(4), waiting: 1 });
  });

  it('counts only the players whose ranges overlap', () => {
    const { matchmaker } = harness();
    matchmaker.join(wallet(0), range(4, { maxStake: HIGHER }));
    matchmaker.join(wallet(1), range(4, { minStake: HIGHER, maxStake: TOP }));
    matchmaker.join(wallet(2), range(8, { minStake: TOP, maxStake: TOP }));
    expect(matchmaker.spotOf(wallet(0))?.waiting).toBe(2);
    expect(matchmaker.spotOf(wallet(1))?.waiting).toBe(2);
    // Its stake overlaps wallet 1's, but no table size does.
    expect(matchmaker.spotOf(wallet(2))?.waiting).toBe(1);
  });

  it('keeps one place per wallet, and refuses an empty range', () => {
    const { matchmaker } = harness();
    matchmaker.join(wallet(0), range(4));
    matchmaker.join(wallet(0), range(8));
    expect(matchmaker.size).toBe(1);
    expect(matchmaker.spotOf(wallet(0))).toMatchObject({ minSeats: 8, maxSeats: 8 });
    expect(() => matchmaker.join(wallet(1), range(4, { minStake: TOP }))).toThrow(/stake range is empty/);
    expect(() => matchmaker.join(wallet(1), range(4, { minStake: '0' }))).toThrow(/stake range is empty/);
    expect(() => matchmaker.join(wallet(1), range(2))).toThrow(/4 to 8 seats/);
    expect(() => matchmaker.join(wallet(1), range(9))).toThrow(/4 to 8 seats/);
  });

  it('narrows a seat range to the table sizes a match can have', () => {
    const { matchmaker } = harness();
    matchmaker.join(wallet(0), range(4, { minSeats: 2, maxSeats: 12 }));
    expect(matchmaker.spotOf(wallet(0))).toMatchObject({ minSeats: 4, maxSeats: 8 });
  });

  it('puts a table back in the queue when its lobby could not be opened, less whoever left meanwhile', async () => {
    let failing = true;
    const { matchmaker, opened } = harness({ fail: () => failing });
    for (let i = 0; i < 4; i += 1) matchmaker.join(wallet(i), range(4));
    const tick = matchmaker.tick();
    matchmaker.leave(wallet(2));
    await tick;
    expect(opened).toHaveLength(0);
    expect(matchmaker.size).toBe(3);

    failing = false;
    matchmaker.join(wallet(9), range(4));
    await matchmaker.tick();
    expect(opened[0]?.roster).toEqual([wallet(0), wallet(1), wallet(3), wallet(9)]);
  });
});

describe('matchmaker ranges', () => {
  it('seats players whose ranges overlap at the lowest stake all of them accept', async () => {
    const { matchmaker, opened } = harness();
    matchmaker.join(wallet(0), range(4, { maxStake: TOP }));
    matchmaker.join(wallet(1), range(4, { minStake: HIGHER, maxStake: TOP }));
    matchmaker.join(wallet(2), range(4, { maxStake: HIGHER }));
    matchmaker.join(wallet(3), range(4, { maxStake: TOP }));
    await matchmaker.tick();
    expect(opened).toEqual([{ stake: BigInt(HIGHER), seats: 4, roster: [wallet(0), wallet(1), wallet(2), wallet(3)] }]);
  });

  it('keeps apart players whose stakes do not overlap', async () => {
    const { matchmaker, opened, advance } = harness();
    for (let i = 0; i < 2; i += 1) matchmaker.join(wallet(i), range(4));
    for (let i = 2; i < 4; i += 1) matchmaker.join(wallet(i), range(4, { minStake: TOP, maxStake: TOP }));
    advance(60_000);
    await matchmaker.tick();
    expect(opened).toHaveLength(0);
  });

  it('fills a table to the most seats everyone at it accepts', async () => {
    const { matchmaker, opened } = harness();
    matchmaker.join(wallet(0), range(4, { maxSeats: 8 }));
    for (let i = 1; i < 6; i += 1) matchmaker.join(wallet(i), range(4, { maxSeats: 6 }));
    await matchmaker.tick();
    expect(opened).toHaveLength(1);
    expect(opened[0]?.seats).toBe(6);
    expect(opened[0]?.roster).toEqual([wallet(0), wallet(1), wallet(2), wallet(3), wallet(4), wallet(5)]);
  });

  it('never seats a player at fewer seats than it asked for', async () => {
    const { matchmaker, opened, advance } = harness();
    for (let i = 0; i < 5; i += 1) matchmaker.join(wallet(i), range(8));
    advance(10 * 60_000);
    await matchmaker.tick();
    expect(opened).toHaveLength(0);
  });

  it('waits for a wider table until the first in line has waited, then opens what it has', async () => {
    const { matchmaker, opened, advance } = harness();
    for (let i = 0; i < 4; i += 1) matchmaker.join(wallet(i), range(4, { maxSeats: 8 }));
    await matchmaker.tick();
    expect(opened).toHaveLength(0);
    advance(30_000);
    await matchmaker.tick();
    expect(opened[0]).toMatchObject({ seats: 4 });
  });

  it('skips a player whose table sizes do not fit, and seats the next who does', async () => {
    const { matchmaker, opened } = harness();
    matchmaker.join(wallet(0), range(4));
    matchmaker.join(wallet(1), range(8));
    for (let i = 2; i < 5; i += 1) matchmaker.join(wallet(i), range(4, { maxSeats: 8 }));
    await matchmaker.tick();
    expect(opened[0]?.roster).toEqual([wallet(0), wallet(2), wallet(3), wallet(4)]);
    expect(matchmaker.spotOf(wallet(1))).not.toBeNull();
  });
});

/** An open lobby a player opened, 4 seats at `STAKE`, with `seated` in it. */
function playerLobby(seated: Address[], overrides: Partial<LobbyInfo> = {}): LobbyInfo {
  return {
    matchId: `0x${'ab'.repeat(32)}`,
    stake: STAKE,
    seatCount: seated.length,
    maxSeats: 4,
    minSeats: 4,
    joinDeadline: 3_600,
    status: 'open',
    players: seated.map((address) => ({ address, chainId: 1 })),
    cancellableAt: 3_600,
    matchmade: false,
    ...overrides,
  };
}

describe('matchmaker and open lobbies', () => {
  it('sends a queued player to an open lobby in its ranges instead of waiting', async () => {
    const lobby = playerLobby([wallet(9)]);
    const { matchmaker, opened, matched } = harness({ lobbies: () => [lobby] });
    matchmaker.join(wallet(0), range(4));
    await matchmaker.tick();

    expect(opened).toHaveLength(0);
    expect(matched()).toEqual([{ player: wallet(0), message: { type: 'matched', matchId: lobby.matchId, stake: STAKE, seats: 4 } }]);
    expect(matchmaker.spotOf(wallet(0))).toBeNull();
    expect(matchmaker.tablesOf(wallet(0))).toEqual([{ matchId: lobby.matchId, stake: STAKE, seats: 4 }]);
  });

  it('finds a lobby at any stake and size inside the ranges', async () => {
    const lobby = playerLobby([wallet(9)], { stake: '3333333333333333', maxSeats: 6 });
    const { matchmaker, matched } = harness({ lobbies: () => [lobby] });
    matchmaker.join(wallet(0), range(4, { maxStake: HIGHER, maxSeats: 8 }));
    await matchmaker.tick();
    expect(matched()).toEqual([
      { player: wallet(0), message: { type: 'matched', matchId: lobby.matchId, stake: lobby.stake, seats: 6 } },
    ]);
  });

  it('sends no more than the seats free, holding those seats for whoever was sent', async () => {
    const lobby = playerLobby([wallet(9), wallet(8)]);
    const { matchmaker, matched, advance } = harness({ lobbies: () => [lobby] });
    for (let i = 0; i < 3; i += 1) matchmaker.join(wallet(i), range(4));
    await matchmaker.tick();
    expect(matched().map(({ player }) => player)).toEqual([wallet(0), wallet(1)]);

    // The two sent have not staked yet: their seats stay theirs.
    advance(1_000);
    await matchmaker.tick();
    expect(matched()).toHaveLength(2);

    // Nor after the hold: then the seat goes to the next in line.
    advance(90_000);
    await matchmaker.tick();
    expect(matched().map(({ player }) => player)).toEqual([wallet(0), wallet(1), wallet(2)]);
  });

  it('leaves alone a matchmade lobby, one out of range, a full lobby, one closing, and one the player sits in', async () => {
    const lobbies = [
      playerLobby([], { matchmade: true }),
      playerLobby([], { maxSeats: 8 }),
      playerLobby([], { stake: '2000000000000000' }),
      playerLobby([wallet(5), wallet(6), wallet(7), wallet(8)]),
      playerLobby([], { joinDeadline: 30 }),
      playerLobby([wallet(0)]),
    ];
    const { matchmaker, matched } = harness({ lobbies: () => lobbies });
    matchmaker.join(wallet(0), range(4));
    await matchmaker.tick();
    expect(matched()).toHaveLength(0);
    expect(matchmaker.size).toBe(1);
  });

  it('still opens a matchmade table for a full one, which earns play-mining', async () => {
    const lobby = playerLobby([wallet(9)]);
    const { matchmaker, opened, matched } = harness({ lobbies: () => [lobby] });
    for (let i = 0; i < 4; i += 1) matchmaker.join(wallet(i), range(4));
    await matchmaker.tick();
    expect(opened).toHaveLength(1);
    expect(matched().every(({ message }) => message.type === 'matched' && message.matchId !== lobby.matchId)).toBe(true);
  });
});

describe('matchmaker memory', () => {
  it('says where a wallet is queued, and which tables it was put at', async () => {
    const { matchmaker, advance } = harness();
    matchmaker.join(wallet(9), range(8));
    expect(matchmaker.spotOf(wallet(9))).toEqual({ ...range(8), waiting: 1 });
    expect(matchmaker.spotOf(wallet(8))).toBeNull();

    for (let i = 0; i < 4; i += 1) matchmaker.join(wallet(i), range(4));
    await matchmaker.tick();
    expect(matchmaker.tablesOf(wallet(0))).toEqual([{ matchId: `0x${'1'.padStart(64, '0')}`, stake: STAKE, seats: 4 }]);
    expect(matchmaker.tablesOf(wallet(9))).toEqual([]);
    // Forgotten long after any join window.
    advance(3 * 3_600_000);
    expect(matchmaker.tablesOf(wallet(0))).toEqual([]);
  });
});
