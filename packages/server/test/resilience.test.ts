import { describe, expect, it } from 'vitest';
import { hashTranscript, type AttestedResult } from '@lms/consensus';
import { MAX_CLIENT_FRAME_BYTES, type ClientMessage, type ServerMessage } from '@lms/api';
import {
  Gateway,
  Lobby,
  MemoryArchive,
  nullRelayer,
  type ArchivedMatch,
  type Relayer,
  type Socket,
} from '@lms/server';
import { FakeClient, HUMAN, botSeats, lastOfType, setupWithBots } from './helpers.js';

const COMMIT_MS = 10_000;
const REVEAL_MS = 5_000;

function lobbyWith(extra: { maxPracticeRooms?: number } = {}): Lobby {
  return new Lobby({
    archive: new MemoryArchive(),
    relayer: nullRelayer,
    commitMs: COMMIT_MS,
    revealMs: REVEAL_MS,
    ...extra,
  });
}

describe('settlement announcement', () => {
  it('tells watchers how a staked match settled', async () => {
    const lobby = lobbyWith();
    const room = lobby.adopt(setupWithBots(4, 'settle'), botSeats(4), 0);
    const watcher = new FakeClient(null);
    room.attach(watcher);

    let now = 1;
    while (!room.finished) {
      now += COMMIT_MS + 1;
      room.tick(now);
    }
    // `finalise` is asynchronous: settle, archive, then announce.
    await new Promise((resolve) => setImmediate(resolve));

    expect(watcher.last('settled')).toEqual({ type: 'settled', matchId: room.matchId, tx: null });
  });
});

describe('archive first', () => {
  /** Plays a staked all-bot match to the end and lets `finalise` run. */
  async function playStaked(lobby: Lobby, label: string): Promise<`0x${string}`> {
    const room = lobby.adopt(setupWithBots(4, label), botSeats(4), 0);
    let now = 1;
    while (!room.finished) {
      now += COMMIT_MS + 1;
      room.tick(now);
    }
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    return room.matchId;
  }

  it('archives the transcript before settling, and settles with its hash', async () => {
    const archive = new MemoryArchive();
    const settled: Array<{ result: AttestedResult; archived: ArchivedMatch | null }> = [];
    const relayer: Relayer = {
      async settle(result) {
        settled.push({ result, archived: await archive.load(result.matchId) });
        return '0x5e771ed';
      },
      abort: async () => null,
    };
    const lobby = new Lobby({ archive, relayer, commitMs: COMMIT_MS, revealMs: REVEAL_MS, chainId: 84532 });
    const matchId = await playStaked(lobby, 'archive-first');

    expect(settled).toHaveLength(1);
    const [{ result, archived }] = settled as [(typeof settled)[0]];
    // Already archived when `settle` was called, and settled over that transcript.
    expect(archived?.transcriptHash).toBe(result.transcriptHash);
    expect(hashTranscript(archived?.transcript as ArchivedMatch['transcript'])).toBe(result.transcriptHash);
    expect(archived?.transcript.chainId).toBe(84532);
    expect(archived?.transcript.rounds).toHaveLength(result.rounds);
    // The transaction is recorded once it exists.
    expect((await archive.load(matchId))?.settledTx).toBe('0x5e771ed');
    expect((await archive.loadByTranscript(result.transcriptHash))?.result.matchId).toBe(matchId);
  });

  it('never settles a match it could not archive, and aborts it instead', async () => {
    const calls: string[] = [];
    const archive = new MemoryArchive();
    archive.save = async () => {
      calls.push('save');
      throw new Error('database is down');
    };
    const relayer: Relayer = {
      settle: async () => {
        calls.push('settle');
        return null;
      },
      abort: async () => {
        calls.push('abort');
        return null;
      },
    };
    const lobby = new Lobby({
      archive,
      relayer,
      commitMs: COMMIT_MS,
      revealMs: REVEAL_MS,
      settleBackoffMs: [1, 1],
      sleep: async () => undefined,
    });
    await playStaked(lobby, 'archive-down');
    expect(calls).toEqual(['save', 'save', 'save', 'abort']);
  });
});

describe('practice and the chain', () => {
  it('archives a practice match, and never hands it to the relayer', async () => {
    const calls: string[] = [];
    const archive = new MemoryArchive();
    const lobby = new Lobby({
      archive,
      relayer: {
        settle: async () => {
          calls.push('settle');
          return null;
        },
        abort: async () => {
          calls.push('abort');
          return null;
        },
      },
      commitMs: COMMIT_MS,
      revealMs: REVEAL_MS,
      receiptSigner: '0x00000000000000000000000000000000000000a7',
      practiceReceiptSigner: '0x00000000000000000000000000000000000000b7',
    });
    const room = lobby.createPractice(HUMAN, 3, 0);
    expect(room.staked).toBe(false);
    for (let now = 0; !room.finished && now < 10_000_000; now += COMMIT_MS + 1) lobby.tick(now);
    await lobby.drain();

    expect(calls).toEqual([]);
    const archived = await archive.load(room.matchId);
    expect(archived?.staked).toBe(false);
    // Its receipts were signed by the practice key, which the transcript names.
    expect(archived?.transcript.receiptSigner).toBe('0x00000000000000000000000000000000000000b7');
  });
});

describe('practice limits', () => {
  it('keeps one practice room per wallet, replacing the old one', () => {
    const lobby = lobbyWith();
    const first = lobby.createPractice(HUMAN, 3, 0);
    const second = lobby.createPractice(HUMAN, 3, 0);

    expect(lobby.size).toBe(1);
    expect(lobby.get(first.matchId)).toBeNull();
    expect(lobby.get(second.matchId)).toBe(second);
  });

  it('refuses new practice rooms past the global ceiling', () => {
    const lobby = lobbyWith({ maxPracticeRooms: 2 });
    lobby.createPractice('0x00000000000000000000000000000000000000b1', 3, 0);
    lobby.createPractice('0x00000000000000000000000000000000000000b2', 3, 0);
    expect(() => lobby.createPractice('0x00000000000000000000000000000000000000b3', 3, 0)).toThrow(
      /practice-room limit/,
    );
    // A wallet that already holds one may still swap it for a new one.
    expect(() => lobby.createPractice('0x00000000000000000000000000000000000000b1', 3, 0)).not.toThrow();
  });
});

class FakeSocket implements Socket {
  readyState = 1;
  readonly sent: ServerMessage[] = [];
  private listener?: (data: unknown) => void;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }

  onMessage(listener: (data: unknown) => void): void {
    this.listener = listener;
  }

  onClose(): void {}

  async raw(data: string): Promise<void> {
    this.listener?.(data);
    await new Promise((resolve) => setImmediate(resolve));
  }

  deliver(message: ClientMessage): Promise<void> {
    return this.raw(JSON.stringify(message));
  }
}

function gatewayHarness(clock = { now: 0 }) {
  const lobby = lobbyWith();
  const gateway = new Gateway({
    lobby,
    chainId: 11155111,
    now: () => clock.now,
    directory: () => ({ open: [], live: [] }),
  });
  const socket = new FakeSocket();
  gateway.accept(socket);
  return { socket, clock };
}

describe('gateway limits', () => {
  it('refuses an oversized frame without parsing it', async () => {
    const { socket } = gatewayHarness();
    await socket.raw('x'.repeat(MAX_CLIENT_FRAME_BYTES + 1));
    expect(lastOfType(socket.sent, 'error')?.message).toMatch(/too large/);
  });

  it('rate-limits a socket that floods the server, and lets it recover', async () => {
    const { socket, clock } = gatewayHarness();
    for (let i = 0; i < 40; i += 1) await socket.deliver({ type: 'lobbies' });
    expect(lastOfType(socket.sent, 'error')?.message).toMatch(/slow down/);

    clock.now += 5_000;
    const errors = socket.sent.filter((message) => message.type === 'error').length;
    await socket.deliver({ type: 'lobbies' });
    expect(socket.sent.filter((message) => message.type === 'error').length).toBe(errors + 1);
    // ...that one failed only because the socket never logged in, not the limit.
    expect(lastOfType(socket.sent, 'error')?.message).toMatch(/authenticate/);
  });
});

describe('settlement retry', () => {
  async function settleWith(outcomes: boolean[], settleRetryForMs = 2) {
    const attempts: boolean[] = [];
    const archive = new MemoryArchive();
    const lobby = new Lobby({
      archive,
      relayer: {
        settle: async () => {
          const ok = outcomes[attempts.length] ?? false;
          attempts.push(ok);
          if (!ok) throw new Error('rpc timeout');
          return `0x${'7a'.repeat(32)}`;
        },
        abort: async () => null,
      },
      commitMs: COMMIT_MS,
      revealMs: REVEAL_MS,
      settleBackoffMs: [1, 1],
      settleRetryForMs,
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
    });
    const setup = setupWithBots(4, `retry-${outcomes.join()}`);
    const room = lobby.adopt(setup, botSeats(4), 0);
    for (let now = 0; !room.finished && now < 10_000_000; now += 5_000) lobby.tick(now);
    expect(lobby.pendingSettlements).toBe(1);
    await lobby.drain();
    expect(lobby.pendingSettlements).toBe(0);
    return { attempts, archived: await archive.load(setup.matchId) };
  }

  it('resubmits a failed settlement until one lands', async () => {
    const { attempts, archived } = await settleWith([false, false, true]);
    expect(attempts).toEqual([false, false, true]);
    expect(archived?.settledTx).toBe(`0x${'7a'.repeat(32)}`);
  });

  it('gives up once it has retried for settleRetryForMs and leaves the refund to the escrow', async () => {
    const { attempts, archived } = await settleWith([false, false, false, true]);
    expect(attempts).toEqual([false, false, false]);
    expect(archived?.settledTx).toBeNull();
  });

  it('keeps retrying at the last wait while there is time left', async () => {
    const { attempts, archived } = await settleWith([false, false, false, false, false, true], 10);
    expect(attempts).toEqual([false, false, false, false, false, true]);
    expect(archived?.settledTx).toBe(`0x${'7a'.repeat(32)}`);
  });

  it('contains a failure anywhere in finalising, rather than leaving it unhandled', async () => {
    const archive = new MemoryArchive();
    // Throws synchronously inside `finalise`, past every guarded step.
    archive.recordSettlement = undefined as unknown as MemoryArchive['recordSettlement'];
    const lobby = new Lobby({
      archive,
      relayer: { settle: async () => `0x${'7a'.repeat(32)}`, abort: async () => null },
      commitMs: COMMIT_MS,
      revealMs: REVEAL_MS,
    });
    const room = lobby.adopt(setupWithBots(4, 'finalise-throws'), botSeats(4), 0);
    for (let now = 0; !room.finished && now < 10_000_000; now += 5_000) lobby.tick(now);
    await lobby.drain();
    expect(lobby.pendingSettlements).toBe(0);
    expect(await archive.load(room.matchId)).not.toBeNull();
  });
});
