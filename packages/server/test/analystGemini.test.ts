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
  turnCost,
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
  it('runs the whole tool loop and returns a verified analysis', async () => {
    const { analyst, gemini } = await harness([
      {
        body: reply(
          [
            { functionCall: { id: 'call_a', name: 'get_round', args: { round: 1 } }, thoughtSignature: 'sig-1' },
            { functionCall: { name: 'get_reads', args: { seat: 2 } } },
          ],
          'STOP',
          { promptTokenCount: 2_000, candidatesTokenCount: 50 },
        ),
      },
      jsonAnswer(ANALYSIS),
    ]);
    const { analysis, usage } = await analyst.analyze({ matchId, requester: player });

    expect(analysis.summary).toBe(ANALYSIS.summary);
    expect(analysis.keyMoments).toHaveLength(1);
    expect(analysis.model).toBe('gemini-3.8-flash');

    expect(gemini.urls[0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(gemini.headers[0]?.['x-goog-api-key']).toBe('test-key');

    const [first, second] = gemini.bodies;
    expect(first?.systemInstruction).toEqual({ parts: [{ text: SYSTEM_PROMPT }] });
    expect(first?.tools[0].functionDeclarations.map((tool: { name: string }) => tool.name)).toEqual([
      'get_match',
      'get_player_history',
      'get_reads',
      'get_round',
    ]);
    expect(first?.tools[0].functionDeclarations[3].parametersJsonSchema.required).toEqual(['round']);
    expect(first?.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    expect(first?.generationConfig).toMatchObject({
      maxOutputTokens: 16_000,
      thinkingConfig: { thinkingLevel: 'medium' },
      responseMimeType: 'application/json',
    });
    expect(first?.generationConfig.responseJsonSchema.properties.keyMoments).toBeDefined();
    expect(first?.contents).toHaveLength(1);

    // The calls go back as the model sent them, signature included, then every result in one user turn.
    expect(second?.contents[1]).toEqual({
      role: 'model',
      parts: [
        { functionCall: { id: 'call_a', name: 'get_round', args: { round: 1 } }, thoughtSignature: 'sig-1' },
        { functionCall: { id: 'gemini_call_2', name: 'get_reads', args: { seat: 2 } } },
      ],
    });
    const results = second?.contents[2];
    expect(results.role).toBe('user');
    expect(results.parts.map((part: any) => [part.functionResponse.id, part.functionResponse.name])).toEqual([
      ['call_a', 'get_round'],
      ['gemini_call_2', 'get_reads'],
    ]);
    expect(results.parts[0].functionResponse.response.output).toContain('Round 1');

    // Cached tokens are cache reads; thinking is output.
    expect(usage).toMatchObject({ inputTokens: 2_000 + 2_000, cacheReadTokens: 1_000, outputTokens: 50 + 1_000 });
    expect(usage?.costUsd).toBeGreaterThan(0);
  });

  it('switches tools off on the last allowed turn and maps effort to a thinking level', () => {
    const request: ModelRequest = {
      model: 'gemini-3.8-flash',
      max_tokens: 100,
      effort: 'max',
      system: 'Frozen prompt.',
      tools: [{ name: 'get_match', description: 'x', input_schema: { type: 'object', properties: {} } }],
      tool_choice: 'none',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const body = toGeminiRequest(request);
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } });
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'high' });
    expect(body.generationConfig.responseMimeType).toBeUndefined();
  });

  it('joins split text and keeps signatures ahead of their parts', () => {
    const turn = fromGeminiResponse(
      'gemini-3.8-flash',
      reply([{ text: '{"a":' }, { text: '1}' }, { thought: true, text: 'hmm', thoughtSignature: 's' }], 'STOP'),
    );
    expect(turn.content).toEqual([
      { type: 'text', text: '{"a":1}' },
      { type: 'signature', signature: 's' },
    ]);
    expect(turn.stop_reason).toBe('end_turn');
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
    const request: ModelRequest = {
      model: 'gemini-3.8-flash',
      max_tokens: 100,
      effort: 'low',
      system: 's',
      tools: [],
      messages: [{ role: 'user', content: 'hi' }],
    };
    await expect(model.generate(request, new AbortController().signal)).rejects.toMatchObject({ kind: 'timeout' });
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

  it('prices Gemini turns', () => {
    const cost = turnCost('gemini-3.8-flash', { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0 });
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

  it('defaults to one call per analysis and the free-tier rate limits, and can lift them', () => {
    expect(loadConfig({}).analyst).toMatchObject({ maxTurns: 1, requestsPerMinute: 5, requestsPerDay: 20, maxConcurrent: 1 });
    expect(loadConfig({ ANALYST_MAX_TURNS: '4' }).analyst.maxTurns).toBe(4);
    const paid = loadConfig({ ANALYST_RPM: '1000', ANALYST_RPD: 'none' }).analyst;
    expect(paid.requestsPerMinute).toBe(1_000);
    expect(paid.requestsPerDay).toBe(Infinity);
    expect(() => loadConfig({ ANALYST_RPM: '0' })).toThrow(/positive integer/);
  });
});
