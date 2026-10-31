import { describe, expect, it } from 'vitest';
import {
  Analyst,
  AnalystError,
  MemoryArchive,
  ProviderError,
  SYSTEM_PROMPT,
  classify,
  fromGeminiResponse,
  geminiModel,
  loadConfig,
  playReferenceMatch,
  toGeminiRequest,
  callCost,
  type ModelRequest,
} from '@lms/server';

const match = playReferenceMatch({ label: 'gemini', strategies: ['reader', 'striker', 'guarder', 'charger'] });
const player = match.seats?.[0]?.address as `0x${string}`;
const matchId = match.result.matchId;

const ANALYSIS = {
  summary: 'The guarder outlasted the brawlers.',
  decisiveRound: 2,
  keyMoments: [{ round: 1, seat: 2, kind: 'guard', target: null, claim: 'Dug in early.' }],
  advice: ['Focus the guarder.'],
};

type Body = Record<string, unknown>;
/** One scripted HTTP answer: a response body, a status with an error body, or a dropped connection. */
type Exchange = { body: Body } | { status: number; message?: string } | { drop: true };

/** A Gemini endpoint that plays back a script and records every request body. */
function fakeGemini(script: Exchange[]) {
  const bodies: Array<Record<string, any>> = [];
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    urls.push(url);
    headers.push(init.headers as Record<string, string>);
    bodies.push(JSON.parse(String(init.body)));
    const next = script.shift();
    if (!next) throw new Error('the fake Gemini ran out of script');
    if ('drop' in next) throw new TypeError('fetch failed');
    if ('status' in next) {
      return new Response(JSON.stringify({ error: { message: next.message ?? 'nope' } }), { status: next.status });
    }
    return new Response(JSON.stringify(next.body));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, bodies, urls, headers };
}

function reply(parts: Body[], finishReason?: string, usageMetadata?: Body): Body {
  return {
    candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }],
    ...(usageMetadata ? { usageMetadata } : {}),
  };
}

const jsonAnswer = (document: unknown): Exchange => ({
  body: reply([{ text: JSON.stringify(document), thoughtSignature: 'sig-final' }], 'STOP', {
    promptTokenCount: 3_000,
    cachedContentTokenCount: 1_000,
    candidatesTokenCount: 400,
    thoughtsTokenCount: 600,
  }),
});

const REQUEST: ModelRequest = {
  model: 'gemini-3.8-flash',
  max_tokens: 100,
  effort: 'low',
  system: 's',
  output_schema: { type: 'object' },
  prompt: 'hi',
};

async function harness(script: Exchange[], options: { maxRetries?: number } = {}) {
  const archive = new MemoryArchive();
  await archive.save(match);
  const gemini = fakeGemini(script);
  const sleeps: number[] = [];
  const analyst = new Analyst({
    archive,
    model: geminiModel({
      apiKey: 'test-key',
      timeoutMs: 5_000,
      maxRetries: options.maxRetries ?? 2,
      fetch: gemini.fetch,
      sleep: async (ms) => void sleeps.push(ms),
    }),
    modelId: 'gemini-3.8-flash',
    effort: 'medium',
    maxTokens: 16_000,
  });
  return { analyst, gemini, sleeps };
}

async function failure(promise: Promise<unknown>): Promise<AnalystError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AnalystError);
    return error as AnalystError;
  }
  throw new Error('expected the analysis to fail');
}

describe('gemini analyst model', () => {
  it('makes one structured-output call and returns a verified analysis', async () => {
    const { analyst, gemini } = await harness([jsonAnswer(ANALYSIS)]);
    const { analysis, usage } = await analyst.analyze({ matchId, requester: player });

    expect(analysis.summary).toBe(ANALYSIS.summary);
    expect(analysis.keyMoments).toHaveLength(1);
    expect(analysis.model).toBe('gemini-3.8-flash');

    expect(gemini.urls).toEqual(['https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent']);
    expect(gemini.headers[0]?.['x-goog-api-key']).toBe('test-key');

    const [body] = gemini.bodies;
    expect(body?.systemInstruction).toEqual({ parts: [{ text: SYSTEM_PROMPT }] });
    expect(body?.tools).toBeUndefined();
    expect(body?.contents).toHaveLength(1);
    expect(body?.contents[0].role).toBe('user');
    expect(body?.contents[0].parts[0].text).toContain('Every round in full:');
    expect(body?.generationConfig).toMatchObject({
      maxOutputTokens: 16_000,
      thinkingConfig: { thinkingLevel: 'medium' },
      responseMimeType: 'application/json',
    });
    expect(body?.generationConfig.responseJsonSchema.properties.keyMoments).toBeDefined();

    // Cached tokens are cache reads; thinking is output.
    expect(usage).toMatchObject({ inputTokens: 2_000, cacheReadTokens: 1_000, outputTokens: 400 + 600 });
    expect(usage?.costUsd).toBeGreaterThan(0);
  });

  it('maps effort to a thinking level', () => {
    const body = toGeminiRequest({ ...REQUEST, effort: 'max' });
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'high' });
    expect(toGeminiRequest({ ...REQUEST, effort: 'low' }).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
  });

  it('joins split text and leaves thoughts out', () => {
    const answer = fromGeminiResponse(
      'gemini-3.8-flash',
      reply([{ text: '{"a":' }, { thought: true, text: 'hmm', thoughtSignature: 's' }, { text: '1}' }], 'STOP'),
    );
    expect(answer.text).toBe('{"a":1}');
    expect(answer.stop_reason).toBe('end_turn');
  });

  it('retries a server error, but never a rate limit', async () => {
    const busy = await harness([{ status: 503 }, { drop: true }, jsonAnswer(ANALYSIS)]);
    const { analysis } = await busy.analyst.analyze({ matchId, requester: player });
    expect(analysis.summary).toBe(ANALYSIS.summary);
    expect(busy.gemini.bodies).toHaveLength(3);
    expect(busy.sleeps).toEqual([500, 1_000]);

    const limited = await harness([{ status: 429, message: 'Resource has been exhausted' }]);
    expect((await failure(limited.analyst.analyze({ matchId, requester: player }))).code).toBe('busy');
    expect(limited.gemini.bodies).toHaveLength(1);
  });

  it('never retries a timed-out call, which Gemini has already counted', async () => {
    const slow = (async (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) =>
        init.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError'))),
      )) as unknown as typeof fetch;
    let calls = 0;
    const model = geminiModel({
      apiKey: 'k',
      timeoutMs: 20,
      maxRetries: 2,
      fetch: ((...args: Parameters<typeof fetch>) => {
        calls++;
        return slow(...args);
      }) as typeof fetch,
      sleep: async () => undefined,
    });
    await expect(model.generate(REQUEST, new AbortController().signal)).rejects.toMatchObject({ kind: 'timeout' });
    expect(calls).toBe(1);
  });

  it('gives up as busy once the retries run out', async () => {
    const { analyst } = await harness([{ status: 500 }, { status: 500 }], { maxRetries: 1 });
    expect((await failure(analyst.analyze({ matchId, requester: player }))).code).toBe('busy');
  });

  it('reports rejected credentials as unavailable', async () => {
    const { analyst, gemini } = await harness([{ status: 403, message: 'API key not valid' }]);
    expect((await failure(analyst.analyze({ matchId, requester: player }))).code).toBe('unavailable');
    expect(gemini.bodies).toHaveLength(1);
  });

  it('maps safety stops and blocked prompts to refusals', async () => {
    const safety = await harness([{ body: reply([{ text: '{' }], 'SAFETY') }]);
    expect((await failure(safety.analyst.analyze({ matchId, requester: player }))).code).toBe('refused');
    const blocked = await harness([{ body: { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } }]);
    expect((await failure(blocked.analyst.analyze({ matchId, requester: player }))).code).toBe('refused');
  });

  it('maps the output limit to a failure', async () => {
    const { analyst } = await harness([{ body: reply([{ text: '{"summary":' }], 'MAX_TOKENS') }]);
    expect((await failure(analyst.analyze({ matchId, requester: player }))).code).toBe('failed');
  });

  it('classifies provider errors by kind', () => {
    expect(classify(new ProviderError('aborted', 'x')).code).toBe('failed');
    expect(classify(new ProviderError('timeout', 'x')).code).toBe('timeout');
    expect(classify(new ProviderError('unreachable', 'x')).code).toBe('busy');
    expect(classify(new ProviderError('limited', 'x', 429)).code).toBe('busy');
    expect(new ProviderError('limited', 'x', 429).retryable).toBe(false);
    expect(new ProviderError('auth', 'x', 401).retryable).toBe(false);
  });

  it('prices a Gemini call', () => {
    const cost = callCost('gemini-3.8-flash', { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0 });
    expect(cost).toBeCloseTo(0.75 + 3.75);
  });
});

describe('analyst config', () => {
  it('is on exactly when GEMINI_API_KEY is set', () => {
    expect(loadConfig({}).analyst.enabled).toBe(false);
    const config = loadConfig({ GEMINI_API_KEY: 'g' });
    expect(config.analyst).toMatchObject({ model: 'gemini-3.8-flash', enabled: true, geminiApiKey: 'g' });
    expect(loadConfig({ GEMINI_API_KEY: 'g', ANALYST_ENABLED: 'false' }).analyst.enabled).toBe(false);
    expect(loadConfig({ GEMINI_API_KEY: 'g', ANALYST_MODEL: 'gemini-4-argon' }).analyst.model).toBe('gemini-4-argon');
  });

  it('defaults to the free-tier rate limits, and can lift them', () => {
    expect(loadConfig({}).analyst).toMatchObject({ requestsPerMinute: 5, requestsPerDay: 20, maxConcurrent: 1 });
    const paid = loadConfig({ ANALYST_RPM: '1000', ANALYST_RPD: 'none' }).analyst;
    expect(paid.requestsPerMinute).toBe(1_000);
    expect(paid.requestsPerDay).toBe(Infinity);
    expect(() => loadConfig({ ANALYST_RPM: '0' })).toThrow(/positive integer/);
  });
});
