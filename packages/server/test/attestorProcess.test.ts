import { createServer, type Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { recoverTypedDataAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  MATCH_RESULT_TYPES,
  hashRules,
  hashTranscript,
  matchResultDomain,
  matchResultMessage,
  type Transcript,
} from '@lms/consensus';
import {
  AnalystError,
  AnalystWorker,
  AttestationRefused,
  AttestorProcess,
  AttestorService,
  Lobby,
  MemoryArchive,
  keySigner,
  playReferenceMatch,
  type ArchivedMatch,
  type Relayer,
} from '@lms/server';
import { botSeats, setupWithBots } from './helpers.js';

const CHAIN_ID = 84532;
const ESCROW = '0x00000000000000000000000000000000000000e5' as const;

/** Plays a staked all-bot match to the end and returns the transcript it would settle on. */
async function playedTranscript(label: string): Promise<Transcript> {
  let transcript: Transcript | null = null;
  const relayer: Relayer = {
    settle: async (_result, played) => {
      transcript = played;
      return null;
    },
    abort: async () => null,
  };
  const lobby = new Lobby({ archive: new MemoryArchive(), relayer, commitMs: 10, revealMs: 10, chainId: CHAIN_ID });
  const room = lobby.adopt(setupWithBots(4, label), botSeats(4), 0);
  for (let now = 0; !room.finished; now += 11) lobby.tick(now);
  await lobby.drain();
  if (!transcript) throw new Error('the match did not settle');
  return transcript;
}

async function signerOf(transcript: Transcript, signature: `0x${string}`): Promise<`0x${string}`> {
  return recoverTypedDataAddress({
    domain: matchResultDomain(CHAIN_ID, ESCROW),
    types: MATCH_RESULT_TYPES,
    primaryType: 'MatchResult',
    message: matchResultMessage({ ...transcript.result, transcriptHash: hashTranscript(transcript) }),
    signature,
  });
}

describe('attestor service', () => {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;

  it('signs the result of a transcript that replays to it', async () => {
    const transcript = await playedTranscript('attest-ok');
    const service = new AttestorService({ signer: keySigner(key), chainId: CHAIN_ID, escrow: ESCROW });
    expect(await signerOf(transcript, await service.attest(transcript))).toBe(address);
  });

  it('refuses a result the rounds do not produce', async () => {
    const transcript = await playedTranscript('attest-ranking');
    const ranking = [...transcript.result.ranking].reverse();
    const forged = { ...transcript, result: { ...transcript.result, ranking } };
    const service = new AttestorService({ signer: keySigner(key), chainId: CHAIN_ID, escrow: ESCROW });
    await expect(service.attest(forged)).rejects.toThrow(/ranking is not what the rounds produce/);
  });

  it('refuses a transcript for another chain', async () => {
    const transcript = await playedTranscript('attest-chain');
    const service = new AttestorService({ signer: keySigner(key), chainId: 1, escrow: ESCROW });
    await expect(service.attest(transcript)).rejects.toBeInstanceOf(AttestationRefused);
  });

  it('refuses a transcript whose seats or seed are not the ones the escrow holds', async () => {
    const transcript = await playedTranscript('attest-escrow');
    const staked = {
      seed: transcript.seed,
      rulesHash: hashRules(transcript.rules),
      seats: transcript.seats.map((seat) => seat.address),
    };
    const honest = new AttestorService({ signer: keySigner(key), chainId: CHAIN_ID, escrow: ESCROW, chain: async () => staked });
    await expect(honest.attest(transcript)).resolves.toMatch(/^0x/);

    const reseated = new AttestorService({
      signer: keySigner(key),
      chainId: CHAIN_ID,
      escrow: ESCROW,
      chain: async () => ({ ...staked, seats: [...staked.seats].reverse() }),
    });
    await expect(reseated.attest(transcript)).rejects.toThrow(/seats are not the ones that staked/);
    const reseeded = new AttestorService({
      signer: keySigner(key),
      chainId: CHAIN_ID,
      escrow: ESCROW,
      chain: async () => ({ ...staked, seed: `0x${'99'.repeat(32)}` }),
    });
    await expect(reseeded.attest(transcript)).rejects.toThrow(/seed is not the one the oracle delivered/);
  });
});

describe('attestor process', () => {
  const key = generatePrivateKey();
  let attestor: AttestorProcess | null = null;
  afterAll(() => attestor?.stop());

  it('signs from its own process, refuses as the service does, and comes back after it dies', async () => {
    attestor = await AttestorProcess.start({ privateKey: key, chainId: CHAIN_ID, escrow: ESCROW });
    expect(attestor.address).toBe(privateKeyToAccount(key).address);

    const transcript = await playedTranscript('process');
    expect(await signerOf(transcript, await attestor.attest(transcript))).toBe(attestor.address);
    const forged = { ...transcript, result: { ...transcript.result, rounds: transcript.result.rounds + 1 } };
    await expect(attestor.attest(forged)).rejects.toBeInstanceOf(AttestationRefused);

    // Killed from outside, even with no time to notice: the next call starts it again.
    (attestor as unknown as { child: { kill(): void } }).child.kill();
    expect(await signerOf(transcript, await attestor.attest(transcript))).toBe(attestor.address);
  }, 60_000);
});

describe('analyst worker', () => {
  const match = playReferenceMatch({ label: 'worker', strategies: ['reader', 'striker', 'guarder', 'charger'] });
  const player = match.seats[0]?.address as `0x${string}`;
  let gemini: Server | null = null;
  let worker: AnalystWorker | null = null;
  afterAll(async () => {
    await worker?.close();
    gemini?.close();
  });

  /** A Gemini endpoint that answers every request with the same analysis. */
  async function fakeGemini(): Promise<string> {
    const answer = {
      summary: 'The guarder outlasted the brawlers.',
      decisiveRound: 1,
      keyMoments: [],
      advice: ['Focus the guarder.'],
    };
    gemini = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => gemini?.listen(0, '127.0.0.1', resolve));
    const address = gemini.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    return `http://127.0.0.1:${address.port}`;
  }

  it('writes an analysis in its thread, reading the match from the server, and reports its usage', async () => {
    const archive = new MemoryArchive();
    await archive.save(match as ArchivedMatch);
    const unlimited = { perWalletPerHour: 100, maxConcurrent: 4, dailyBudgetUsd: Infinity, requestsPerMinute: Infinity, requestsPerDay: Infinity };
    worker = new AnalystWorker({
      archive,
      config: {
        model: { apiKey: 'test', baseUrl: await fakeGemini(), timeoutMs: 10_000, maxRetries: 0 },
        analyst: { modelId: 'gemini-3.8-flash', effort: 'low', maxTokens: 1_000 },
        limits: unlimited,
      },
    });

    const steps: string[] = [];
    const result = await worker.analyze({ matchId: match.result.matchId, requester: player, onStep: (step) => steps.push(step) });
    expect(result.cached).toBe(false);
    expect(result.analysis.summary).toBe('The guarder outlasted the brawlers.');
    expect(steps.length).toBeGreaterThan(0);
    // Cached through the server's archive, so the second answer is free.
    expect((await worker.analyze({ matchId: match.result.matchId, requester: player })).cached).toBe(true);

    const missing = await worker.analyze({ matchId: `0x${'00'.repeat(32)}`, requester: player }).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(AnalystError);
    expect((missing as AnalystError).code).toBe('not_found');

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(worker.requests).toBe(1);
  }, 60_000);
});
