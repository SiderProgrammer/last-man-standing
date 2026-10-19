import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  AUTH_PREFIX,
  type ClientMessage,
  type LobbyInfo,
  type ServerMessage,
  type StakingInfo,
  type ZapInfo,
} from '@lms/protocol';
import { AnalystError, Gateway, Lobby, MemoryArchive, nullRelayer } from '@lms/server';
import type {
  AnalyzeRequest,
  AnalyzeResult,
  AskRequest,
  AskResult,
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
    ...(extras.analyst ? { analyst: extras.analyst } : {}),
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
    expect(socket.last('error')?.message).toMatch(/does not match the nonce/);
  });

  it('refuses to act before authentication', async () => {
    const { socket } = harness();
    await socket.deliver({ type: 'practice', bots: 3 });
    expect(socket.last('error')?.message).toMatch(/authenticate/);
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
    expect(socket.last('error')?.code).toBe('REJECTED');
  });

  it('advertises the escrow so the client knows where to stake', () => {
    const { socket } = harness({ escrow: ESCROW });
    expect(socket.last('hello')?.escrow).toBe(ESCROW);
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

  it('advertises the session delegate so the client can offer one-click play', () => {
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
    expect(socket.last('error')?.code).toBe('REJECTED');
  });
});

/** An analyst the test drives by hand: each request waits until `finish` or `fail` is called. */
class ManualAnalyst implements MatchAnalyst {
  readonly requests: AnalyzeRequest[] = [];
  private pending: Array<{ resolve: (result: AnalyzeResult) => void; reject: (error: unknown) => void }> = [];

  readonly questions: AskRequest[] = [];

  analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
    this.requests.push(request);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  /** Answers at once, streaming the answer in two pieces. */
  async ask(request: AskRequest): Promise<AskResult> {
    this.questions.push(request);
    request.onDelta?.('Round 3, ');
    request.onDelta?.('mostly.');
    return {
      question: request.question.trim(),
      answer: 'Round 3, mostly.',
      model: 'gemini-3.8-flash',
      usage: {
        model: 'gemini-3.8-flash',
        turns: 1,
        toolCalls: 0,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        costUsd: 0,
        latencyMs: 1,
      },
    };
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
    expect(socket.last('error')?.message).toMatch(/authenticate/);
  });

  it('refuses a malformed match id at the boundary', async () => {
    const analyst = new ManualAnalyst();
    const { socket } = harness({ analyst });
    await login(socket);
    socket.deliverRaw({ type: 'analyze', matchId: 'nope' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(socket.last('error')?.message).toMatch(/matchId/);
    expect(analyst.requests).toHaveLength(0);
  });

  it('says so when this server has no analyst', async () => {
    const { socket } = harness();
    await login(socket);
    await socket.deliver({ type: 'analyze', matchId: MATCH });
    expect(socket.last('analysis.error')).toMatchObject({ matchId: MATCH, code: 'unavailable' });
  });

  it('streams deltas and then the finished analysis to the asker', async () => {
    const analyst = new ManualAnalyst();
    const { socket } = harness({ analyst });
    await login(socket);
    await socket.deliver({ type: 'analyze', matchId: MATCH });

    expect(analyst.requests[0]).toMatchObject({ matchId: MATCH, requester: account.address });
    analyst.requests[0]?.onDelta?.('first ');
    analyst.requests[0]?.onDelta?.('second');
    await analyst.finish(MATCH);

    const frames = socket.sent.filter((m) => m.type.startsWith('analysis.'));
    expect(frames.map((m) => m.type)).toEqual(['analysis.delta', 'analysis.delta', 'analysis.done']);
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

describe('gateway follow-up frames', () => {
  it('streams the answer to a question, then the whole of it', async () => {
    const analyst = new ManualAnalyst();
    const { socket } = harness({ analyst });
    await login(socket);
    await socket.deliver({ type: 'analysis.ask', matchId: MATCH, question: '  Which round decided it?  ' });

    expect(analyst.questions[0]).toMatchObject({ matchId: MATCH, requester: account.address });
    const frames = socket.sent.filter((m) => m.type.startsWith('analysis.'));
    expect(frames.map((m) => m.type)).toEqual(['analysis.reply.delta', 'analysis.reply.delta', 'analysis.reply']);
    expect(socket.last('analysis.reply')).toMatchObject({ question: 'Which round decided it?', answer: 'Round 3, mostly.' });
  });

  it('refuses an empty or oversized question at the boundary', async () => {
    const analyst = new ManualAnalyst();
    const { socket } = harness({ analyst });
    await login(socket);
    await socket.deliver({ type: 'analysis.ask', matchId: MATCH, question: '   ' });
    expect(socket.last('error')?.message).toMatch(/must not be empty/);
    await socket.deliver({ type: 'analysis.ask', matchId: MATCH, question: 'x'.repeat(501) });
    expect(socket.last('error')?.message).toMatch(/at most 500/);
    expect(analyst.questions).toHaveLength(0);
  });

  it('marks a failed question as such, so the client keeps the analysis on screen', async () => {
    const { socket } = harness();
    await login(socket);
    await socket.deliver({ type: 'analysis.ask', matchId: MATCH, question: 'why?' });
    expect(socket.last('analysis.error')).toMatchObject({ code: 'unavailable', stage: 'ask' });
  });

  it('will not take a question while an analysis is still being written', async () => {
    const analyst = new ManualAnalyst();
    const { socket } = harness({ analyst });
    await login(socket);
    await socket.deliver({ type: 'analyze', matchId: MATCH });
    await socket.deliver({ type: 'analysis.ask', matchId: MATCH, question: 'why?' });
    expect(socket.last('analysis.error')).toMatchObject({ code: 'busy', stage: 'ask' });
    expect(analyst.questions).toHaveLength(0);
  });
});
