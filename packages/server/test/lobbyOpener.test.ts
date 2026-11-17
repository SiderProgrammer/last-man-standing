import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { LobbyInfo } from '@lms/api';
import { DailyQuota, LobbyOpener, OPEN_HOLD_MS, RequestError, type LobbyOpenerPort } from '@lms/server';

const PLAYER = `0x${'a1'.repeat(20)}` as const;
const OTHER = `0x${'b2'.repeat(20)}` as const;
const STAKE = '1000000000000000';

class FakePort implements LobbyOpenerPort {
  readonly opened: Array<{ stake: bigint; seats: number; key: string }> = [];
  revert: string | null = null;
  /** Holds every open until released, to race two of them. */
  gate: Promise<void> | null = null;

  async open(stake: bigint, seats: number, key: string): Promise<{ tx: Hex; matchId: Hex }> {
    if (this.gate) await this.gate;
    if (this.revert) throw new Error(`execution reverted: ${this.revert}`);
    this.opened.push({ stake, seats, key });
    const n = this.opened.length;
    return { tx: `0x${String(n).padStart(64, '0')}`, matchId: `0x${String(n).padStart(64, 'f')}` };
  }
}

function lobby(matchId: Hex, overrides: Partial<LobbyInfo> = {}): LobbyInfo {
  return {
    matchId,
    stake: STAKE,
    seatCount: 0,
    maxSeats: 4,
    minSeats: 4,
    joinDeadline: 1_800_000_000,
    status: 'open',
    players: [],
    cancellableAt: 1_800_000_000,
    matchmade: false,
    ...overrides,
  };
}

function setup(perDay = 5) {
  const port = new FakePort();
  const quota = new DailyQuota(perDay);
  let lobbies: LobbyInfo[] = [];
  let now = 1_000_000;
  const opener = new LobbyOpener({ port, quota, lobbies: () => lobbies, now: () => now });
  return {
    port,
    quota,
    opener,
    list: (next: LobbyInfo[]) => (lobbies = next),
    advance: (ms: number) => (now += ms),
  };
}

async function refusal(promise: Promise<unknown>): Promise<RequestError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(RequestError);
  return error as RequestError;
}

describe('LobbyOpener', () => {
  it('opens a lobby at the stake and size asked for, and spends one of the day', async () => {
    const { port, opener } = setup(3);
    const opened = await opener.open(PLAYER, STAKE, 4);
    expect(opened.matchId).toMatch(/^0x[0-9f]{64}$/);
    expect(opened.left).toBe(2);
    expect(port.opened).toEqual([{ stake: 10n ** 15n, seats: 4, key: expect.stringContaining(PLAYER.toLowerCase()) }]);
  });

  it('refuses another while the last one opened waits for its stake', async () => {
    const { opener, list } = setup();
    const { matchId } = await opener.open(PLAYER, STAKE, 4);

    // Not listed yet, then listed without the wallet in it: still waiting.
    expect((await refusal(opener.open(PLAYER, STAKE, 4))).code).toBe('RELAY_REFUSED');
    list([lobby(matchId)]);
    expect((await refusal(opener.open(PLAYER, STAKE, 4))).message).toMatch(/still waiting for your stake/);

    // Another wallet is not held up by it.
    await expect(opener.open(OTHER, STAKE, 4)).resolves.toMatchObject({ left: 4 });
  });

  it('opens another once the wallet is seated in the last one, or it left the open list', async () => {
    const { opener, list } = setup();
    const first = await opener.open(PLAYER, STAKE, 4);
    list([lobby(first.matchId, { seatCount: 1, players: [{ address: PLAYER, chainId: 11155420 }] })]);
    const second = await opener.open(PLAYER, STAKE, 4);

    list([lobby(second.matchId, { status: 'live' })]);
    await expect(opener.open(PLAYER, STAKE, 4)).resolves.toBeDefined();
  });

  it('opens another once the hold runs out, staked into or not', async () => {
    const { opener, advance } = setup();
    await opener.open(PLAYER, STAKE, 4);
    advance(OPEN_HOLD_MS - 1);
    await refusal(opener.open(PLAYER, STAKE, 4));
    advance(1);
    await expect(opener.open(PLAYER, STAKE, 4)).resolves.toBeDefined();
  });

  it('opens one at a time for a wallet when two requests race', async () => {
    const { port, opener } = setup();
    let release = () => {};
    port.gate = new Promise((resolve) => (release = resolve));
    const first = opener.open(PLAYER, STAKE, 4);
    const second = await refusal(opener.open(PLAYER, STAKE, 4));
    expect(second.message).toMatch(/already being opened/);
    release();
    await expect(first).resolves.toBeDefined();
    expect(port.opened).toHaveLength(1);
  });

  it('turns a revert into RELAY_REFUSED, hands the call back, and holds nothing', async () => {
    const { port, quota, opener } = setup(2);
    port.revert = 'StakeOutOfRange';
    const error = await refusal(opener.open(PLAYER, STAKE, 4));
    expect(error.code).toBe('RELAY_REFUSED');
    expect(error.message).toMatch(/StakeOutOfRange/);
    expect(quota.left(PLAYER)).toBe(2);

    port.revert = null;
    await expect(opener.open(PLAYER, STAKE, 4)).resolves.toBeDefined();
  });

  it('stops at the daily quota, which it shares with relayed calls', async () => {
    const { quota, opener } = setup(1);
    quota.take(PLAYER);
    expect((await refusal(opener.open(PLAYER, STAKE, 4))).code).toBe('RELAY_QUOTA');
    // A refusal holds nothing either.
    quota.giveBack(PLAYER);
    await expect(opener.open(PLAYER, STAKE, 4)).resolves.toBeDefined();
  });

  it('refuses a zero stake without sending anything', async () => {
    const { port, opener } = setup();
    expect((await refusal(opener.open(PLAYER, '0', 4))).code).toBe('RELAY_REFUSED');
    expect(port.opened).toEqual([]);
  });
});
