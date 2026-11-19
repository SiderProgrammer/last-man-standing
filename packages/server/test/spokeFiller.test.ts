import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, getAddress, type Address, type Hex } from 'viem';
import {
  DEFAULT_SPOKE_FILLER_POLICY,
  RevertedError,
  SpokeFiller,
  decodeJoin,
  spokeRpcs,
  toBytes32,
  type FillerHubPort,
  type FillerLobby,
  type SpokeDeposit,
  type SpokeDepositSource,
  type SpokeFillerPolicy,
} from '@lms/server';

const RECEIVER = `0x${'0e'.repeat(20)}` as Address;
const FILLER = `0x${'f1'.repeat(20)}` as Address;
const PLAYER = `0x${'a1'.repeat(20)}` as Address;
const OTHER = `0x${'b2'.repeat(20)}` as Address;
const MATCH = `0x${'77'.repeat(32)}` as Hex;
const STAKE = 1_000_000_000_000_000n;
const NOW_S = 1_800_000_000;
const ZERO32 = `0x${'0'.repeat(64)}` as Hex;
const WETH32 = toBytes32(`0x${'42'.repeat(20)}`);

const joinMessage = (matchId: Hex = MATCH, player: Address = PLAYER) =>
  encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'uint32' }], [matchId, player, 11155420]);

let nextId = 1n;
function deposit(overrides: Partial<SpokeDeposit> = {}): SpokeDeposit {
  return {
    originChainId: 11155420,
    depositId: nextId++,
    depositor: toBytes32(PLAYER),
    recipient: toBytes32(RECEIVER),
    exclusiveRelayer: ZERO32,
    inputToken: WETH32,
    outputToken: WETH32,
    inputAmount: STAKE + 4_000_000_000_000n,
    outputAmount: STAKE,
    fillDeadline: NOW_S + 7_200,
    exclusivityDeadline: 0,
    message: joinMessage(),
    ...overrides,
  };
}

class FakeSource implements SpokeDepositSource {
  readonly chainId = 11155420;
  blocks = new Map<bigint, SpokeDeposit[]>();
  headBlock = 10_000n;
  reads: Array<[bigint, bigint]> = [];

  at(block: bigint, ...deposits: SpokeDeposit[]): void {
    this.blocks.set(block, [...(this.blocks.get(block) ?? []), ...deposits]);
  }

  async head(): Promise<bigint> {
    return this.headBlock;
  }

  async deposits(from: bigint, to: bigint): Promise<SpokeDeposit[]> {
    this.reads.push([from, to]);
    return [...this.blocks].filter(([block]) => block >= from && block <= to).flatMap(([, list]) => list);
  }
}

class FakeHub implements FillerHubPort {
  readonly address = FILLER;
  balance = 1_000_000_000_000_000_000n;
  lobbyState: FillerLobby = { status: 1, seatCount: 0, maxSeats: 4, joinDeadline: NOW_S + 600, stake: STAKE };
  filled: SpokeDeposit[] = [];
  failWith: Error | null = null;

  async time(): Promise<number> {
    return NOW_S;
  }

  async funds(): Promise<bigint> {
    return this.balance;
  }

  async lobby(): Promise<FillerLobby> {
    return this.lobbyState;
  }

  async fill(d: SpokeDeposit): Promise<Hex> {
    if (this.failWith) throw this.failWith;
    this.filled.push(d);
    this.balance -= d.outputAmount;
    return `0x${String(this.filled.length).padStart(64, '0')}`;
  }
}

function setup(policy: Partial<SpokeFillerPolicy> = {}) {
  const source = new FakeSource();
  const hub = new FakeHub();
  let now = 1_000_000;
  const filler = new SpokeFiller({
    hub,
    sources: [source],
    receiver: RECEIVER,
    policy: { ...DEFAULT_SPOKE_FILLER_POLICY, ...policy },
    now: () => now,
  });
  return { source, hub, filler, advance: (ms: number) => (now += ms) };
}

describe('SpokeFiller', () => {
  it("fills any wallet's join to the receiver, once", async () => {
    const { source, hub, filler } = setup();
    const d = deposit({ depositor: toBytes32(OTHER), message: joinMessage(MATCH, OTHER) });
    source.at(9_990n, d);

    await filler.tick();
    await filler.tick();

    expect(hub.filled).toEqual([d]);
    expect(filler.waiting).toBe(0);
  });

  it('ignores deposits to anything but the receiver', async () => {
    const { source, hub, filler } = setup();
    source.at(9_990n, deposit({ recipient: toBytes32(OTHER) }));

    await filler.tick();

    expect(hub.filled).toEqual([]);
    expect(filler.waiting).toBe(0);
  });

  it('starts a lookback behind the head, then reads on from where it stopped', async () => {
    const { source, filler } = setup();
    await filler.tick();
    source.headBlock = 10_500n;
    await filler.tick();

    expect(source.reads[0]?.[0]).toBe(8_000n);
    expect(source.reads.at(-1)).toEqual([10_001n, 10_500n]);
  });

  it('skips a stake over the cap, and a message that is not a join', async () => {
    const { source, hub, filler } = setup({ maxStake: STAKE });
    source.at(9_990n, deposit({ outputAmount: STAKE + 1n }), deposit({ message: '0x1234' }));

    await filler.tick();

    expect(hub.filled).toEqual([]);
    expect(filler.waiting).toBe(0);
  });

  it.each([
    ['closed', { status: 2 }],
    ['past its join window', { joinDeadline: NOW_S }],
    ['full', { seatCount: 4 }],
    ['on a larger stake', { stake: STAKE * 2n }],
  ])('skips a lobby that is %s, which would only credit the stake', async (_, lobby) => {
    const { source, hub, filler } = setup();
    hub.lobbyState = { ...hub.lobbyState, ...lobby };
    source.at(9_990n, deposit());

    await filler.tick();

    expect(hub.filled).toEqual([]);
    expect(filler.waiting).toBe(0);
  });

  it('skips a deposit past its fill deadline', async () => {
    const { source, hub, filler } = setup();
    source.at(9_990n, deposit({ fillDeadline: NOW_S }));

    await filler.tick();

    expect(hub.filled).toEqual([]);
  });

  it("caps each depositor's fills per day", async () => {
    const { source, hub, filler } = setup({ perDay: 2 });
    source.at(9_990n, deposit(), deposit(), deposit(), deposit({ depositor: toBytes32(OTHER) }));

    await filler.tick();

    expect(hub.filled.map((d) => d.depositor)).toEqual([toBytes32(PLAYER), toBytes32(PLAYER), toBytes32(OTHER)]);
  });

  it('waits, warning once, while it cannot afford a fill and its reserve', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { source, hub, filler } = setup({ reserve: 10n });
    hub.balance = STAKE + 9n;
    source.at(9_990n, deposit());

    await filler.tick();
    await filler.tick();
    expect(hub.filled).toEqual([]);
    expect(filler.waiting).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);

    hub.balance = STAKE + 10n;
    await filler.tick();
    expect(hub.filled).toHaveLength(1);
    warn.mockRestore();
  });

  it('leaves a deposit to Across for the delay first', async () => {
    const { source, hub, filler, advance } = setup({ delayMs: 60_000 });
    source.at(9_990n, deposit());

    await filler.tick();
    expect(hub.filled).toEqual([]);

    advance(60_000);
    await filler.tick();
    expect(hub.filled).toHaveLength(1);
  });

  it("waits out another relayer's exclusivity", async () => {
    const { source, hub, filler } = setup();
    source.at(9_990n, deposit({ exclusiveRelayer: toBytes32(OTHER), exclusivityDeadline: NOW_S + 5 }));

    await filler.tick();

    expect(hub.filled).toEqual([]);
    expect(filler.waiting).toBe(1);
  });

  it('gives up on a revert at once, and hands back the quota', async () => {
    const { source, hub, filler } = setup({ perDay: 1 });
    hub.failWith = new RevertedError('RelayFilled', 'RelayFilled');
    source.at(9_990n, deposit());
    await filler.tick();
    expect(filler.waiting).toBe(0);

    hub.failWith = null;
    source.at(10_005n, deposit());
    source.headBlock = 10_010n;
    await filler.tick();
    expect(hub.filled).toHaveLength(1);
  });

  it('retries a fill that failed without a revert, then gives up', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { source, hub, filler } = setup();
    hub.failWith = new Error('fetch failed');
    source.at(9_990n, deposit());

    await filler.tick();
    await filler.tick();
    expect(filler.waiting).toBe(1);
    await filler.tick();
    expect(filler.waiting).toBe(0);
    error.mockRestore();
  });
});

describe('decodeJoin', () => {
  it('reads what SpokeRouter.joinMessage writes', () => {
    expect(decodeJoin(joinMessage())).toEqual({ matchId: MATCH, player: getAddress(PLAYER), originChainId: 11155420 });
  });

  it('refuses a zero player and garbage', () => {
    expect(decodeJoin(joinMessage(MATCH, `0x${'0'.repeat(40)}`))).toBeNull();
    expect(decodeJoin('0xdead')).toBeNull();
  });
});

describe('spokeRpcs', () => {
  const router = `0x${'c3'.repeat(20)}` as Address;

  it('pairs each kept spoke with its rpcUrl, leaving out spokes without one', () => {
    const raw = JSON.stringify([
      { chainId: 10, router, rpcUrl: 'https://op.example' },
      { chainId: 42161, router },
    ]);
    const spokes = [
      { chainId: 10, router },
      { chainId: 42161, router },
    ];
    expect(spokeRpcs(raw, spokes)).toEqual([{ chainId: 10, router, rpcUrl: 'https://op.example' }]);
  });

  it('is empty for blank or invalid SPOKES', () => {
    expect(spokeRpcs('', [])).toEqual([]);
    expect(spokeRpcs('{', [{ chainId: 10, router }])).toEqual([]);
  });
});
