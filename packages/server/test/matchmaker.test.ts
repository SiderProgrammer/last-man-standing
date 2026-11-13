import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import type { LobbyInfo, ServerMessage } from '@lms/api';
import { Matchmaker, parseTiers, type MatchmakerPort } from '@lms/server';

const STAKE = '1000000000000000';
const TIERS = [
  { stake: STAKE, seats: 4 },
  { stake: STAKE, seats: 8 },
];

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
    tiers: TIERS,
    minSeats: 4,
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
  it('opens a lobby once a tier has a full table, with exactly those players on its roster', async () => {
    const { matchmaker, opened, matched } = harness();
    for (let i = 0; i < 5; i += 1) matchmaker.join(wallet(i), STAKE, 4);
    await matchmaker.tick();

    expect(opened).toEqual([{ stake: BigInt(STAKE), seats: 4, roster: [wallet(0), wallet(1), wallet(2), wallet(3)] }]);
    expect(matched().map(({ player }) => player)).toEqual([wallet(0), wallet(1), wallet(2), wallet(3)]);
    expect(matched()[0]?.message).toEqual({ type: 'matched', matchId: `0x${'1'.padStart(64, '0')}`, stake: STAKE, seats: 4 });
    // The fifth waits for the next table.
    expect(matchmaker.waiting(STAKE, 4)).toBe(1);
  });

  it('opens a short table once the first in line has waited long enough, and not before', async () => {
    const { matchmaker, opened, advance } = harness();
    for (let i = 0; i < 5; i += 1) matchmaker.join(wallet(i), STAKE, 8);
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
    for (let i = 0; i < 3; i += 1) matchmaker.join(wallet(i), STAKE, 8);
    advance(10 * 60_000);
    await matchmaker.tick();
    expect(opened).toHaveLength(0);
  });

  it('tells everyone in a queue how many are waiting, as it changes', () => {
    const { matchmaker, told } = harness();
    matchmaker.join(wallet(0), STAKE, 4);
    matchmaker.join(wallet(1), STAKE, 4);
    matchmaker.leave(wallet(0));
    const last = told.filter(({ player }) => player === wallet(1)).at(-1)?.message;
    expect(last).toEqual({ type: 'queued', stake: STAKE, seats: 4, waiting: 1 });
  });

  it('keeps a wallet in one queue at a time, and refuses a tier it does not run', () => {
    const { matchmaker } = harness();
    matchmaker.join(wallet(0), STAKE, 4);
    matchmaker.join(wallet(0), STAKE, 8);
    expect(matchmaker.waiting(STAKE, 4)).toBe(0);
    expect(matchmaker.waiting(STAKE, 8)).toBe(1);
    expect(() => matchmaker.join(wallet(0), '5', 4)).toThrow(/no queue for that stake/);
  });

  it('puts a table back at the front when its lobby could not be opened, less whoever left meanwhile', async () => {
    let failing = true;
    const { matchmaker, opened } = harness({ fail: () => failing });
    for (let i = 0; i < 4; i += 1) matchmaker.join(wallet(i), STAKE, 4);
    const tick = matchmaker.tick();
    matchmaker.leave(wallet(2));
    await tick;
    expect(opened).toHaveLength(0);
    expect(matchmaker.waiting(STAKE, 4)).toBe(3);

    failing = false;
    matchmaker.join(wallet(9), STAKE, 4);
    await matchmaker.tick();
    expect(opened[0]?.roster).toEqual([wallet(0), wallet(1), wallet(3), wallet(9)]);
  });
});

/** An open lobby a player opened, at the 4-seat tier, with `seated` in it. */
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
  it('sends a queued player to an open lobby of its tier instead of waiting', async () => {
    const lobby = playerLobby([wallet(9)]);
    const { matchmaker, opened, matched } = harness({ lobbies: () => [lobby] });
    matchmaker.join(wallet(0), STAKE, 4);
    await matchmaker.tick();

    expect(opened).toHaveLength(0);
    expect(matched()).toEqual([{ player: wallet(0), message: { type: 'matched', matchId: lobby.matchId, stake: STAKE, seats: 4 } }]);
    expect(matchmaker.spotOf(wallet(0))).toBeNull();
    expect(matchmaker.tablesOf(wallet(0))).toEqual([{ matchId: lobby.matchId, stake: STAKE, seats: 4 }]);
  });

  it('sends no more than the seats free, holding those seats for whoever was sent', async () => {
    const lobby = playerLobby([wallet(9), wallet(8)]);
    const { matchmaker, matched, advance } = harness({ lobbies: () => [lobby] });
    for (let i = 0; i < 3; i += 1) matchmaker.join(wallet(i), STAKE, 4);
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

  it('leaves alone a matchmade lobby, another tier, a full lobby, one closing, and one the player sits in', async () => {
    const lobbies = [
      playerLobby([], { matchmade: true }),
      playerLobby([], { maxSeats: 8 }),
      playerLobby([], { stake: '2000000000000000' }),
      playerLobby([wallet(5), wallet(6), wallet(7), wallet(8)]),
      playerLobby([], { joinDeadline: 30 }),
      playerLobby([wallet(0)]),
    ];
    const { matchmaker, matched } = harness({ lobbies: () => lobbies });
    matchmaker.join(wallet(0), STAKE, 4);
    await matchmaker.tick();
    expect(matched()).toHaveLength(0);
    expect(matchmaker.waiting(STAKE, 4)).toBe(1);
  });

  it('still opens a matchmade table for a full queue, which earns play-mining', async () => {
    const lobby = playerLobby([wallet(9)]);
    const { matchmaker, opened, matched } = harness({ lobbies: () => [lobby] });
    for (let i = 0; i < 4; i += 1) matchmaker.join(wallet(i), STAKE, 4);
    await matchmaker.tick();
    expect(opened).toHaveLength(1);
    expect(matched().every(({ message }) => message.type === 'matched' && message.matchId !== lobby.matchId)).toBe(true);
  });
});

describe('matchmaking tiers', () => {
  it('reads the tiers from JSON, and drops what is not one', () => {
    expect(parseTiers('[{"stake":"1000","seats":4},{"stake":"0","seats":4},{"stake":"5","seats":1},"x"]')).toEqual([
      { stake: '1000', seats: 4 },
    ]);
    expect(parseTiers('')).toEqual([]);
    expect(parseTiers('not json')).toEqual([]);
  });
});

describe('matchmaker memory', () => {
  it('says where a wallet is queued, and which tables it was put at', async () => {
    const { matchmaker, advance } = harness();
    matchmaker.join(wallet(9), STAKE, 8);
    expect(matchmaker.spotOf(wallet(9))).toEqual({ stake: STAKE, seats: 8, waiting: 1 });
    expect(matchmaker.spotOf(wallet(8))).toBeNull();

    for (let i = 0; i < 4; i += 1) matchmaker.join(wallet(i), STAKE, 4);
    await matchmaker.tick();
    expect(matchmaker.tablesOf(wallet(0))).toEqual([{ matchId: `0x${'1'.padStart(64, '0')}`, stake: STAKE, seats: 4 }]);
    expect(matchmaker.tablesOf(wallet(9))).toEqual([]);
    // Forgotten long after any join window.
    advance(3 * 3_600_000);
    expect(matchmaker.tablesOf(wallet(0))).toEqual([]);
  });
});
