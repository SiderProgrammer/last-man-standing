import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import type { ServerMessage } from '@lms/api';
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
function harness(options: { fail?: () => boolean; fillAfterMs?: number } = {}) {
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
    expect(opened[0]?.seats).toBe(8);
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

describe('matchmaking tiers', () => {
  it('reads the tiers from JSON, and drops what is not one', () => {
    expect(parseTiers('[{"stake":"1000","seats":4},{"stake":"0","seats":4},{"stake":"5","seats":1},"x"]')).toEqual([
      { stake: '1000', seats: 4 },
    ]);
    expect(parseTiers('')).toEqual([]);
    expect(parseTiers('not json')).toEqual([]);
  });
});
