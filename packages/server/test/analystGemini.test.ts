import { describe, expect, it } from 'vitest';
import {
  Analyst,
  AnalystError,
  FOLLOW_UP_INSTRUCTION,
  MemoryArchive,
  ProviderError,
  SYSTEM_PROMPT,
  classify,
  geminiModel,
  loadConfig,
  playReferenceMatch,
  toGeminiRequest,
  turnCost,
  type ModelRequest,
} from '@lms/server';

const match = playReferenceMatch({ label: 'gemini', strategies: ['reader', 'aggressor', 'turtle', 'hider'] });
const player = match.seats?.[0]?.address as `0x${string}`;
const matchId = match.result.matchId;

const ANALYSIS = {
  summary: 'The turtle outlasted the brawlers.',
  decisiveRound: 2,
  keyMoments: [{ round: 1, seat: 2, kind: 'defend', target: null, claim: 'Dug in early.' }],
  advice: ['Focus the turtle.'],
};

type Event = Record<string, unknown>;
/** One scripted HTTP answer: a stream of events, a status with an error body, or a dropped connection. */
type Exchange = { events: Event[]; splitAt?: number } | { status: number; message?: string } | { drop: true; after?: Event[] };

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
    if ('status' in next) {
      return new Response(JSON.stringify({ error: { message: next.message ?? 'nope' } }), { status: next.status });
    }
    if ('drop' in next) {
      const text = sse(next.after ?? []);
      let sent = false;
      // Fails on the read after the first, so the first chunk is delivered before the drop.
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (sent || !text) return controller.error(new TypeError('terminated'));
            sent = true;
            controller.enqueue(new TextEncoder().encode(text));
          },
        }),
      );
    }
    const text = sse(next.events);
    // Split inside an event, as a network would, to exercise the parser's buffering.
    const at = next.splitAt ?? Math.floor(text.length / 2);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text.slice(0, at)));
          controller.enqueue(new TextEncoder().encode(text.slice(at)));
          controller.close();
        },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, bodies, urls, headers };
}

function sse(events: Event[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
}

function parts(parts: Event[], finishReason?: string, usageMetadata?: Event): Event {
  return {
    candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }],
    ...(usageMetadata ? { usageMetadata } : {}),
  };
}

/** A JSON answer split over several events, as Gemini streams it. */
function jsonAnswer(document: unknown): Event[] {
  const text = JSON.stringify(document);
  const third = Math.ceil(text.length / 3);
  return [
    parts([{ text: text.slice(0, third) }]),
    parts([{ text: text.slice(third, 2 * third) }]),
    parts([{ text: text.slice(2 * third), thoughtSignature: 'sig-final' }], 'STOP', {
      promptTokenCount: 3_000,
      cachedContentTokenCount: 1_000,
      candidatesTokenCount: 400,
      thoughtsTokenCount: 600,
    }),
  ];
}

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
        events: [
          parts([
            { functionCall: { id: 'call_a', name: 'get_round', args: { round: 1 } }, thoughtSignature: 'sig-1' },
            { functionCall: { name: 'get_reads', args: { seat: 2 } } },
          ]),
          parts([], 'STOP', { promptTokenCount: 2_000, candidatesTokenCount: 50 }),
        ],
      },
      { events: jsonAnswer(ANALYSIS) },
    ]);
    const steps: string[] = [];
    let streamed = '';
    const { analysis, usage } = await analyst.analyze({
      matchId,
      requester: player,
      onStep: (step) => steps.push(step),
      onDelta: (text) => (streamed += text),
    });

    expect(analysis.summary).toBe(ANALYSIS.summary);
    expect(streamed).toBe(ANALYSIS.summary);
    expect(analysis.keyMoments).toHaveLength(1);
    expect(analysis.model).toBe('gemini-3.8-flash');
    expect(steps).toEqual(['Reading round 1', 'Studying seat #2']);

    expect(gemini.urls[0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
    );
    expect(gemini.headers[0]?.['x-goog-api-key']).toBe('test-key');

    const [first, second] = gemini.bodies;
    expect(first?.systemInstruction.parts[0].text).toBe(SYSTEM_PROMPT);
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

  it('switches tools off on the last allowed turn', () => {
    const request: ModelRequest = {
      model: 'gemini-3.8-flash',
      max_tokens: 100,
      effort: 'low',
      system: 'Frozen prompt.',
      tools: [{ name: 'get_match', description: 'x', input_schema: { type: 'object', properties: {} } }],
      tool_choice: 'none',
      messages: [{ role: 'user', content: 'hi' }],
    };
    expect(toGeminiRequest(request).toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } });
  });

  it('lifts mid-conversation system messages into the system instruction, once each', () => {
    const request: ModelRequest = {
      model: 'gemini-3.8-flash',
      max_tokens: 100,
      effort: 'max',
      system: 'Frozen prompt.',
      tools: [],
      messages: [
        { role: 'user', content: 'The match.' },
        { role: 'assistant', content: 'The analysis.' },
        { role: 'user', content: '<player_question>One?</player_question>' },
        { role: 'system', content: FOLLOW_UP_INSTRUCTION },
        { role: 'assistant', content: 'Answer one.' },
        { role: 'user', content: '<player_question>Two?</player_question>' },
        { role: 'system', content: FOLLOW_UP_INSTRUCTION },
      ],
    };
    const body = toGeminiRequest(request);
    expect(body.systemInstruction?.parts.map((part) => part.text)).toEqual(['Frozen prompt.', FOLLOW_UP_INSTRUCTION]);
    expect(body.contents.map((content) => content.role)).toEqual(['user', 'model', 'user', 'model', 'user']);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'high' });
    expect(body.generationConfig.responseMimeType).toBeUndefined();
  });

  it('answers a follow-up question in prose', async () => {
    const { analyst, gemini } = await harness([
      { events: jsonAnswer(ANALYSIS) },
      { events: [parts([{ text: 'It was close until ' }]), parts([{ text: 'round 2.' }], 'STOP')] },
    ]);
    await analyst.analyze({ matchId, requester: player });
    let streamed = '';
    const reply = await analyst.ask({ matchId, requester: player, question: 'Was it close?', onDelta: (d) => (streamed += d) });
    expect(reply.answer).toBe('It was close until round 2.');
    expect(streamed).toBe(reply.answer);
    const body = gemini.bodies[1];
    expect(body?.generationConfig.responseJsonSchema).toBeUndefined();
    expect(body?.systemInstruction.parts.map((part: { text: string }) => part.text)).toContain(FOLLOW_UP_INSTRUCTION);
    expect(JSON.stringify(body?.contents.at(-1))).toContain('Was it close?');
  });

  it('retries a busy provider before anything has streamed', async () => {
    const { analyst, gemini, sleeps } = await harness([{ status: 429 }, { status: 503 }, { events: jsonAnswer(ANALYSIS) }]);
    const { analysis } = await analyst.analyze({ matchId, requester: player });
    expect(analysis.summary).toBe(ANALYSIS.summary);
    expect(gemini.bodies).toHaveLength(3);
    expect(sleeps).toEqual([500, 1_000]);
  });

  it('gives up as busy once the retries run out', async () => {
    const { analyst } = await harness([{ status: 429 }, { status: 429 }], { maxRetries: 1 });
    expect((await failure(analyst.analyze({ matchId, requester: player }))).code).toBe('busy');
  });

  it('never retries a stream that already reached the player', async () => {
    const { analyst, gemini } = await harness([{ drop: true, after: [parts([{ text: '{"summary":"The tur' }])] }]);
    expect((await failure(analyst.analyze({ matchId, requester: player }))).code).toBe('busy');
    expect(gemini.bodies).toHaveLength(1);
  });

  it('reports rejected credentials as unavailable', async () => {
    const { analyst, gemini } = await harness([{ status: 403, message: 'API key not valid' }]);
    expect((await failure(analyst.analyze({ matchId, requester: player }))).code).toBe('unavailable');
    expect(gemini.bodies).toHaveLength(1);
  });

  it('maps safety stops and blocked prompts to refusals', async () => {
    const safety = await harness([{ events: [parts([{ text: '{' }], 'SAFETY')] }]);
    expect((await failure(safety.analyst.analyze({ matchId, requester: player }))).code).toBe('refused');
    const blocked = await harness([{ events: [{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }] }]);
    expect((await failure(blocked.analyst.analyze({ matchId, requester: player }))).code).toBe('refused');
  });

  it('maps the output limit to a failure', async () => {
    const { analyst } = await harness([{ events: [parts([{ text: '{"summary":' }], 'MAX_TOKENS')] }]);
    expect((await failure(analyst.analyze({ matchId, requester: player }))).code).toBe('failed');
  });

  it('classifies provider errors by kind', () => {
    expect(classify(new ProviderError('aborted', 'x')).code).toBe('failed');
    expect(classify(new ProviderError('timeout', 'x')).code).toBe('timeout');
    expect(classify(new ProviderError('unreachable', 'x')).code).toBe('busy');
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

  it('runs the demo without a key', () => {
    expect(loadConfig({ ANALYST_DEMO: 'true' }).analyst).toMatchObject({ enabled: true, demo: true });
  });
});
