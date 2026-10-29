import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  AUTH_PREFIX,
  DEFAULT_RULES,
  type ClientMessage,
  type LobbyInfo,
  type ServerMessage,
  type SpokeInfo,
  type StakingInfo,
  type ZapInfo,
} from '@lms/protocol';
import { AnalystError, Gateway, HISTORY_PAGE, Lobby, MemoryArchive, nullRelayer } from '@lms/server';
import type {
  AnalyzeRequest,
  ArchivedMatch,
  AnalyzeResult,
  MatchAnalyst,
  SignatureVerifier,
  Socket,
} from '@lms/server';
import { lastOfType } from './helpers.js';

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);

/** In-process stand-in for a `ws` socket. */
class FakeSocket implements Socket {
  readyState = 1;
  readonly sent: ServerMessage[] = [];
  private listeners: { message?: (data: unknown) => void; close?: () => void } = {};

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }

  onMessage(listener: (data: unknown) => void): void {
    this.listeners.message = listener;
  }

  onClose(listener: () => void): void {
    this.listeners.close = listener;
  }

  async deliver(message: ClientMessage): Promise<void> {
    this.listeners.message?.(JSON.stringify(message));
    // The gateway verifies signatures asynchronously; let the microtasks drain.
    await new Promise((resolve) => setImmediate(resolve));
  }

  close(): void {
    this.listeners.close?.();
  }

  /** Delivers a raw frame that does not type-check as a `ClientMessage`. */
  deliverRaw(frame: unknown): void {
    this.listeners.message?.(JSON.stringify(frame));
  }

  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return lastOfType(this.sent, type);
  }
}

const ESCROW = `0x${'ab'.repeat(20)}` as const;

function openLobby(): LobbyInfo {
  return {
    matchId: `0x${'cd'.repeat(32)}`,
    stake: '1000000000000000',
    seatCount: 2,
    maxSeats: 4,
    minSeats: 2,
    joinDeadline: 1_800_000_000,
    status: 'open',
    players: [{ address: account.address, chainId: 11155111 }],
  };
}

interface Extras {
  escrow: `0x${string}` | null;
  directory: () => { open: LobbyInfo[]; live: LobbyInfo[] };
  verify: SignatureVerifier;
  sessionDelegate: `0x${string}` | null;
  zap: ZapInfo | null;
  staking: StakingInfo | null;
  analyst: MatchAnalyst;
  archive: MemoryArchive;
  spokes: SpokeInfo[];
}

function harness(extras: Partial<Extras> = {}) {
  const lobby = new Lobby({
    archive: new MemoryArchive(),
    relayer: nullRelayer,
    commitMs: 10_000,
    revealMs: 5_000,
  });
  const gateway = new Gateway({
    lobby,
    chainId: 11155111,
    now: () => 0,
    escrow: extras.escrow ?? null,
    directory: extras.directory ?? (() => ({ open: [], live: [] })),
    ...(extras.verify ? { verify: extras.verify } : {}),
    sessionDelegate: extras.sessionDelegate ?? null,
    zap: extras.zap ?? null,
    staking: extras.staking ?? null,
    ...(extras.spokes ? { spokes: extras.spokes } : {}),
    ...(extras.analyst ? { analyst: extras.analyst } : {}),
    ...(extras.archive ? { archive: extras.archive } : {}),
  });
  const socket = new FakeSocket();
  gateway.accept(socket);
  return { lobby, gateway, socket };
}

async function login(socket: FakeSocket): Promise<void> {
  const hello = socket.last('hello');
  const signature = await account.signMessage({ message: `${AUTH_PREFIX}${hello?.nonce}` });
  await socket.deliver({ type: 'auth', address: account.address, signature });
}

describe('gateway', () => {
  it('greets a new connection with a login nonce', () => {
    const { socket } = harness();
    expect(socket.last('hello')?.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(socket.last('hello')?.chainId).toBe(11155111);
  });

  it('accepts a wallet signature over the issued nonce', async () => {
    const { socket } = harness();
    await login(socket);
    expect(socket.last('authed')?.address).toBe(account.address);
  });

  it('rejects a signature over a different nonce', async () => {
    const { socket } = harness();
    const signature = await account.signMessage({ message: `${AUTH_PREFIX}not-the-nonce` });
    await socket.deliver({ type: 'auth', address: account.address, signature });

    expect(socket.last('authed')).toBeUndefined();
    expect(socket.last('error')?.code).toBe('BAD_SIGNATURE');
  });

  it('refuses to act before authentication', async () => {
    const { socket } = harness();
    await socket.deliver({ type: 'practice', bots: 3 });
    expect(socket.last('error')?.code).toBe('NOT_AUTHENTICATED');
  });

  it('seats the caller in a practice lobby', async () => {
    const { socket, lobby } = harness();
    await login(socket);
    await socket.deliver({ type: 'practice', bots: 3 });

    expect(lobby.size).toBe(1);
    expect(socket.last('state')?.you).toBe(0);
    expect(socket.last('state')?.state.players).toHaveLength(4);
  });

  it('reports a malformed frame instead of dropping the socket', async () => {
    const { socket } = harness();
    await login(socket);
    socket.deliver({} as ClientMessage);
    await new Promise((resolve) => setImmediate(resolve));
    expect(socket.last('error')?.code).toBe('MALFORMED_FRAME');
  });

  it('advertises the escrow so the client knows where to stake', () => {
    const { socket } = harness({ escrow: ESCROW });
    expect(socket.last('hello')?.escrow).toBe(ESCROW);
  });

  it('advertises the spokes a player may stake from, and none by default', () => {
    const spokes = [{ chainId: 31338, escrow: ESCROW }];
    expect(harness({ spokes }).socket.last('hello')?.spokes).toEqual(spokes);
    expect(harness().socket.last('hello')?.spokes).toEqual([]);
  });

  it('sends a wallet its own cross-chain news, and nobody else', async () => {
    const { gateway, socket } = harness();
    await login(socket);
    const stranger = new FakeSocket();
    gateway.accept(stranger);

    const event = { kind: 'seated', matchId: `0x${'cd'.repeat(32)}`, chainId: 31338 } as const;
    gateway.notify(account.address, { type: 'crossChain', event });
    gateway.notify(`0x${'99'.repeat(20)}`, { type: 'crossChain', event });

    expect(socket.sent.filter((m) => m.type === 'crossChain')).toEqual([{ type: 'crossChain', event }]);
    expect(stranger.last('crossChain')).toBeUndefined();
  });

  it('reports practice-only mode when no escrow is configured', () => {
    const { socket } = harness();
    expect(socket.last('hello')?.escrow).toBeNull();
  });

  it('serves the chain lobby directory', async () => {
    const info = openLobby();
    const { socket } = harness({ escrow: ESCROW, directory: () => ({ open: [info], live: [] }) });
    await login(socket);
    await socket.deliver({ type: 'lobbies' });

    expect(socket.last('lobbies')?.open).toEqual([info]);
    expect(socket.last('lobbies')?.live).toEqual([]);
  });

  it('serves an empty directory when the server runs without a chain', async () => {
    const { socket } = harness();
    await login(socket);
    await socket.deliver({ type: 'lobbies' });
    expect(socket.last('lobbies')).toEqual({ type: 'lobbies', open: [], live: [] });
  });

  it('detaches a closed socket from its room', async () => {
    const { socket, lobby, gateway } = harness();
    await login(socket);
    await socket.deliver({ type: 'practice', bots: 3 });
    const before = socket.sent.length;

    socket.close();
    expect(gateway.connections).toBe(0);

    lobby.tick(60_000);
    // No further frames can reach a detached client.
    expect(socket.sent.length).toBe(before);
  });

  it('advertises the session delegate so the client can offer prompt-free logins', () => {
    const delegate = `0x${'99'.repeat(20)}` as const;
    const { socket } = harness({ sessionDelegate: delegate });
    expect(socket.last('hello')?.sessionDelegate).toBe(delegate);
  });

  it('advertises token payment so the client can offer it', () => {
    const usdc = `0x${'0c'.repeat(20)}` as const;
    const zap: ZapInfo = {
      address: `0x${'2a'.repeat(20)}`,
      quoter: `0x${'3b'.repeat(20)}`,
      tokens: [
        {
          symbol: 'USDC',
          address: usdc,
          decimals: 6,
          path: [
            {
              intermediateCurrency: usdc,
              fee: 500,
              tickSpacing: 10,
              hooks: `0x${'00'.repeat(20)}`,
              hookData: '0x',
            },
          ],
        },
      ],
    };
    const { socket } = harness({ escrow: ESCROW, zap });
    expect(socket.last('hello')?.zap).toEqual(zap);
  });

  it('advertises the staking vault and governor so the client can show the panel', () => {
    const staking: StakingInfo = {
      vault: `0x${'5a'.repeat(20)}`,
      governor: `0x${'60'.repeat(20)}`,
      feeRouter: `0x${'fe'.repeat(20)}`,
    };
    const { socket } = harness({ staking });
    expect(socket.last('hello')?.staking).toEqual(staking);
  });

  it('hides staking when none is configured', () => {
    expect(harness().socket.last('hello')?.staking).toBeNull();
  });

  it('offers only ETH when no zap is configured', () => {
    const { socket } = harness({ escrow: ESCROW });
    expect(socket.last('hello')?.zap).toBeNull();
  });

  it('advertises no delegate when the server cannot verify one', () => {
    const { socket } = harness();
    expect(socket.last('hello')?.sessionDelegate).toBeNull();
  });

  /**
   * A 7702-delegated account logs in with a session key, so the signature does
   * not recover to the account address and only an ERC-1271 call can settle it.
   * The gateway must ask the injected verifier rather than assume `ecrecover`.
   */
  it('accepts a login the injected verifier approves but ecrecover would not', async () => {
    const asked: Array<{ address: string; message: string }> = [];
    const stranger = privateKeyToAccount(`0x${'22'.repeat(32)}`);
    const { socket } = harness({
      verify: async (args) => {
        asked.push({ address: args.address, message: args.message });
        return true;
      },
    });

    const nonce = socket.last('hello')?.nonce ?? '';
    // Signed by a different key entirely: stands in for a session key.
    const signature = await stranger.signMessage({ message: `${AUTH_PREFIX}${nonce}` });
    await socket.deliver({ type: 'auth', address: account.address, signature });

    expect(socket.last('authed')?.address).toBe(account.address);
    expect(asked).toEqual([{ address: account.address, message: `${AUTH_PREFIX}${nonce}` }]);
  });

  it('rejects a login the verifier refuses', async () => {
    const { socket } = harness({ verify: async () => false });

    const nonce = socket.last('hello')?.nonce ?? '';
    const signature = await account.signMessage({ message: `${AUTH_PREFIX}${nonce}` });
    await socket.deliver({ type: 'auth', address: account.address, signature });

    expect(socket.last('authed')).toBeUndefined();
    expect(socket.last('error')?.code).toBe('BAD_SIGNATURE');
  });
});

/** An analyst the test drives by hand: each request waits until `finish` or `fail` is called. */
class ManualAnalyst implements MatchAnalyst {
  readonly requests: AnalyzeRequest[] = [];
  private pending: Array<{ resolve: (result: AnalyzeResult) => void; reject: (error: unknown) => void }> = [];

  analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
    this.requests.push(request);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  async finish(matchId: `0x${string}`): Promise<void> {
    this.pending.shift()?.resolve({
      analysis: {
        matchId,
        seat: 0,
        summary: 'all of it',
        decisiveRound: 1,
        keyMoments: [],
        advice: [],
        dropped: 0,
        model: 'gemini-3.8-flash',
      },
      cached: false,
    });
    await new Promise((resolve) => setImmediate(resolve));
  }

  async fail(error: unknown): Promise<void> {
    this.pending.shift()?.reject(error);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const MATCH = `0x${'ef'.repeat(32)}` as const;

describe('gateway analysis frames', () => {
  it('advertises whether analysis is available', () => {
    expect(harness().socket.last('hello')?.analyst).toBe(false);
    expect(harness({ analyst: new ManualAnalyst() }).socket.last('hello')?.analyst).toBe(true);
  });

  it('requires a login', async () => {
    const { socket } = harness({ analyst: new ManualAnalyst() });
    await socket.deliver({ type: 'analyze', matchId: MATCH });
    expect(socket.last('error')?.code).toBe('NOT_AUTHENTICATED');
  });

  it('refuses a malformed match id at the boundary', async () => {
    const analyst = new ManualAnalyst();
    const { socket } = harness({ analyst });
    await login(socket);
    socket.deliverRaw({ type: 'analyze', matchId: 'nope' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(socket.last('error')).toMatchObject({ code: 'MALFORMED_FRAME', message: expect.stringMatching(/matchId/) });
    expect(analyst.requests).toHaveLength(0);
  });

  it('says so when this server has no analyst', async () => {
    const { socket } = harness();
    await login(socket);
    await socket.deliver({ type: 'analyze', matchId: MATCH });
    expect(socket.last('analysis.error')).toMatchObject({ matchId: MATCH, code: 'unavailable' });
  });

  it('sends progress, then the finished analysis, to the asker', async () => {
    const analyst = new ManualAnalyst();
    const { socket } = harness({ analyst });
    await login(socket);
    await socket.deliver({ type: 'analyze', matchId: MATCH });

    expect(analyst.requests[0]).toMatchObject({ matchId: MATCH, requester: account.address });
    analyst.requests[0]?.onStep?.('Reading round 4');
    await analyst.finish(MATCH);

    const frames = socket.sent.filter((m) => m.type.startsWith('analysis.'));
    expect(frames.map((m) => m.type)).toEqual(['analysis.step', 'analysis.done']);
    expect(socket.last('analysis.step')).toMatchObject({ matchId: MATCH, step: 'Reading round 4' });
    expect(socket.last('analysis.done')?.analysis.summary).toBe('all of it');
  });

  it('forwards the failure code', async () => {
    const analyst = new ManualAnalyst();
    const { socket } = harness({ analyst });
    await login(socket);
    await socket.deliver({ type: 'analyze', matchId: MATCH });
    await analyst.fail(new AnalystError('not_found', 'no finished match with that id'));
    expect(socket.last('analysis.error')).toMatchObject({ code: 'not_found', message: 'no finished match with that id' });
    // A failed analysis is not misbehaviour and is not answered as a generic error.
    expect(socket.last('error')).toBeUndefined();
  });

  it('writes one analysis at a time per socket', async () => {
    const analyst = new ManualAnalyst();
    const { socket } = harness({ analyst });
    await login(socket);
    await socket.deliver({ type: 'analyze', matchId: MATCH });
    await socket.deliver({ type: 'analyze', matchId: MATCH });
    expect(analyst.requests).toHaveLength(1);
    expect(socket.last('analysis.error')?.code).toBe('busy');

    await analyst.finish(MATCH);
    await socket.deliver({ type: 'analyze', matchId: MATCH });
    expect(analyst.requests).toHaveLength(2);
  });

  it('cancels the model call when the asker disconnects', async () => {
    const analyst = new ManualAnalyst();
    const { socket } = harness({ analyst });
    await login(socket);
    await socket.deliver({ type: 'analyze', matchId: MATCH });
    const signal = analyst.requests[0]?.signal;
    expect(signal?.aborted).toBe(false);
    socket.close();
    expect(signal?.aborted).toBe(true);
  });
});

describe('gateway match history', () => {
  const STRANGER = `0x${'0e'.repeat(20)}` as const;
  const BOT = `0x${'0b'.repeat(20)}` as const;

  /** A finished match, archived at `finishedAt`, that `account` sat in at seat 1 unless `seats` says otherwise. */
  function played(
    label: number,
    finishedAt: number,
    options: { staked?: boolean; won?: boolean; seats?: ArchivedMatch['seats'] } = {},
  ): ArchivedMatch {
    const seats = options.seats ?? [
      { index: 0, address: BOT, chainId: 11155111 },
      { index: 1, address: account.address, chainId: 11155111 },
    ];
    const addresses = seats.map((seat) => seat.address);
    return {
      result: {
        matchId: `0x${label.toString(16).padStart(64, '0')}`,
        rounds: 4,
        historyRoot: `0x${'77'.repeat(32)}`,
        ranking: options.won ? [...addresses].reverse() : addresses,
      },
      history: [],
      settledTx: null,
      seats,
      rules: DEFAULT_RULES,
      staked: options.staked ?? false,
      seed: `0x${'5e'.repeat(32)}`,
      finishedAt,
    };
  }

  const strangers = [{ index: 0, address: STRANGER, chainId: 11155111 }];

  it('requires a login', async () => {
    const { socket } = harness({ archive: new MemoryArchive() });
    await socket.deliver({ type: 'history' });
    expect(socket.last('history')).toBeUndefined();
    expect(socket.last('error')?.code).toBe('NOT_AUTHENTICATED');
  });

  it("lists only the caller's own matches, newest first, from their seat", async () => {
    const archive = new MemoryArchive();
    await archive.save(played(1, 1_000));
    await archive.save(played(2, 2_000, { seats: strangers }));
    await archive.save(played(3, 3_000, { won: true, staked: true }));
    const { socket } = harness({ archive });
    await login(socket);

    await socket.deliver({ type: 'history' });

    const page = socket.last('history');
    expect(page?.matches.map((match) => match.finishedAt)).toEqual([3_000, 1_000]);
    expect(page?.matches[0]).toMatchObject({ place: 1, players: 2, seat: 1, staked: true });
    expect(page?.matches[1]).toMatchObject({ place: 2, staked: false });
    expect(page?.before).toBeNull();
    expect(page?.more).toBe(false);
  });

  it('pages older matches by the last one shown', async () => {
    const archive = new MemoryArchive();
    for (let i = 1; i <= HISTORY_PAGE + 3; i += 1) await archive.save(played(i, i * 1_000));
    const { socket } = harness({ archive });
    await login(socket);

    await socket.deliver({ type: 'history' });
    const first = socket.last('history');
    expect(first?.matches).toHaveLength(HISTORY_PAGE);
    expect(first?.more).toBe(true);

    const oldest = first?.matches.at(-1)?.finishedAt ?? 0;
    await socket.deliver({ type: 'history', before: oldest });
    const second = socket.last('history');
    expect(second?.before).toBe(oldest);
    expect(second?.matches.map((match) => match.finishedAt)).toEqual([3_000, 2_000, 1_000]);
    expect(second?.more).toBe(false);
  });

  it('reopens a match the caller played', async () => {
    const archive = new MemoryArchive();
    const match = played(1, 1_000);
    await archive.save(match);
    const { socket } = harness({ archive });
    await login(socket);

    await socket.deliver({ type: 'review', matchId: match.result.matchId });
    expect(socket.last('review')?.match).toMatchObject({
      result: match.result,
      seats: match.seats,
      seed: match.seed,
      staked: false,
      finishedAt: 1_000,
    });
  });

  it("keeps someone else's practice match private, but not a staked one", async () => {
    const archive = new MemoryArchive();
    const practice = played(1, 1_000, { seats: strangers });
    const staked = played(2, 2_000, { seats: strangers, staked: true });
    await archive.save(practice);
    await archive.save(staked);
    const { socket } = harness({ archive });
    await login(socket);

    await socket.deliver({ type: 'review', matchId: practice.result.matchId });
    expect(socket.last('review')).toBeUndefined();
    expect(socket.last('error')?.code).toBe('FORBIDDEN');

    await socket.deliver({ type: 'review', matchId: staked.result.matchId });
    expect(socket.last('review')?.match.result.matchId).toBe(staked.result.matchId);
  });

  it('says so when the server keeps no archive', async () => {
    const { socket } = harness();
    await login(socket);
    await socket.deliver({ type: 'history' });
    expect(socket.last('error')?.code).toBe('UNAVAILABLE');
  });
});
