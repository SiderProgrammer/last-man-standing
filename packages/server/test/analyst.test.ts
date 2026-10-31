import { describe, expect, it } from 'vitest';
import {
  Analyst,
  AnalystError,
  MemoryArchive,
  ProviderError,
  SYSTEM_PROMPT,
  classify,
  outputSchema,
  playReferenceMatch,
} from '@lms/server';
import { FakeModel, answer, usage, type Turn } from './analystFakes.js';

// Staked, so a wallet that did not play may still ask for the spectator's view.
const match = { ...playReferenceMatch({ label: 'analyst', strategies: ['reader', 'striker', 'guarder', 'charger'] }), staked: true };
const human = (match.seats ?? [])[0]?.address as `0x${string}`;
const stranger = `0x${'99'.repeat(20)}` as const;

/** A claim the history supports: seat 2 is the guarder, so it guarded in round 1. */
const TRUE_MOMENT = { round: 1, seat: 2, kind: 'guard', target: null, claim: 'The guarder dug in.' } as const;
/** One it does not: the guarder never charges. */
const FALSE_MOMENT = { round: 1, seat: 2, kind: 'charge', target: null, claim: 'The guarder loaded up.' } as const;

function output(overrides: Record<string, unknown> = {}) {
  return {
    summary: 'Seat #1 swung every round and paid for it.\nThe guarder outlasted everyone.',
    decisiveRound: 2,
    keyMoments: [TRUE_MOMENT, FALSE_MOMENT],
    advice: ['Guard when #1 has you in its sights.'],
    ...overrides,
  };
}

async function harness(script: Turn[]) {
  const archive = new MemoryArchive();
  await archive.save(match);
  const model = new FakeModel(script);
  const analyst = new Analyst({ archive, model, modelId: 'gemini-3.8-flash', effort: 'medium', maxTokens: 16_000 });
  return { analyst, model };
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

describe('analyst', () => {
  it('returns a verified analysis', async () => {
    const { analyst } = await harness([answer(output())]);
    const { analysis, cached } = await analyst.analyze({ matchId: match.result.matchId, requester: human });

    expect(cached).toBe(false);
    expect(analysis.summary).toBe(output().summary);
    expect(analysis.seat).toBe(0);
    expect(analysis.decisiveRound).toBe(2);
    expect(analysis.keyMoments).toEqual([TRUE_MOMENT]);
    expect(analysis.dropped).toBe(1);
    expect(analysis.advice).toEqual(output().advice);
    expect(analysis.model).toBe('gemini-3.8-flash');
  });

  it('writes for a spectator when the asker did not play', async () => {
    const { analyst, model } = await harness([answer(output())]);
    const { analysis } = await analyst.analyze({ matchId: match.result.matchId, requester: stranger });
    expect(analysis.seat).toBeNull();
    expect(model.requests[0]?.prompt).toMatch(/spectator/);
  });

  it('sends a frozen system prompt and keeps the match after it', async () => {
    const { analyst, model } = await harness([answer(output())]);
    await analyst.analyze({ matchId: match.result.matchId, requester: human });
    const request = model.requests[0];

    expect(request?.system).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).not.toContain(match.result.matchId);
    const user = String(request?.prompt);
    expect(user).toContain(match.result.matchId);
    expect(user).toContain('seat #0');
  });

  it('pins effort and structured output', async () => {
    const { analyst, model } = await harness([answer(output())]);
    await analyst.analyze({ matchId: match.result.matchId, requester: human });
    const request = model.requests[0];

    expect(request?.model).toBe('gemini-3.8-flash');
    expect(request?.effort).toBe('medium');
    expect(request?.output_schema).toEqual(outputSchema());
  });

  it('constrains the answer with a schema a provider accepts', () => {
    const schema = JSON.stringify(outputSchema());
    expect(schema).not.toContain('$schema');
    expect(schema).not.toContain('minLength');
    expect(schema).not.toContain(String(Number.MAX_SAFE_INTEGER));
    expect(schema).toContain('keyMoments');
  });

  it('opens with an overview line for every round', async () => {
    const { analyst, model } = await harness([answer(output())]);
    await analyst.analyze({ matchId: match.result.matchId, requester: human });
    const user = String(model.requests[0]?.prompt);
    for (const record of match.history) expect(user).toContain(`Round ${record.round}:`);
    expect(user).toContain('#0 '); // the table
    expect(user).toContain('(you)');
  });

  it('puts the whole match in the prompt, so one call can answer', async () => {
    const { analyst, model } = await harness([answer(output())]);
    await analyst.analyze({ matchId: match.result.matchId, requester: human });
    const user = String(model.requests[0]?.prompt);
    expect(user).toContain('Every round in full:');
    expect(user.match(/ {2}moves: /g)).toHaveLength(match.history.length);
    expect(user).toContain('What each seat did over the whole match:');
    for (const seat of match.seats ?? []) expect(user).toContain(`Seat #${seat.index} over the whole match`);
  });

  it('answers in a single call, and says what it is doing', async () => {
    const { analyst, model } = await harness([answer(output())]);
    const steps: string[] = [];
    const { analysis } = await analyst.analyze({
      matchId: match.result.matchId,
      requester: human,
      onStep: (step) => steps.push(step),
    });
    expect(analysis.keyMoments).toEqual([TRUE_MOMENT]);
    expect(model.requests).toHaveLength(1);
    expect(steps).toEqual([
      'Gemini is reading the whole match and writing the analysis',
      'Checking the key moments against the rounds',
    ]);
  });

  it('drops a decisive round the match never reached', async () => {
    const { analyst } = await harness([answer(output({ decisiveRound: 99 }))]);
    const { analysis } = await analyst.analyze({ matchId: match.result.matchId, requester: human });
    expect(analysis.decisiveRound).toBeNull();
  });

  it('refuses an unknown match without calling the model', async () => {
    const { analyst, model } = await harness([]);
    const error = await failure(analyst.analyze({ matchId: `0x${'00'.repeat(32)}`, requester: human }));
    expect(error.code).toBe('not_found');
    expect(model.requests).toHaveLength(0);
  });

  it('reports a refusal', async () => {
    const { analyst } = await harness([{ reply: { stop_reason: 'refusal', text: '' } }]);
    expect((await failure(analyst.analyze({ matchId: match.result.matchId, requester: human }))).code).toBe('refused');
  });

  it('reports a truncated answer', async () => {
    const { analyst } = await harness([{ reply: { stop_reason: 'max_tokens', text: '{"summary":' } }]);
    expect((await failure(analyst.analyze({ matchId: match.result.matchId, requester: human }))).code).toBe('failed');
  });

  it('rejects an answer that is not JSON, or not the schema', async () => {
    const prose: Turn = { reply: { stop_reason: 'end_turn', text: 'Here is my analysis!' } };
    const { analyst } = await harness([prose, answer({ summary: 'no moments, no advice' })]);
    const notJson = await failure(analyst.analyze({ matchId: match.result.matchId, requester: human }));
    expect(notJson.code).toBe('failed');
    expect(notJson.message).toMatch(/not JSON/);
    const wrongShape = await failure(analyst.analyze({ matchId: match.result.matchId, requester: human }));
    expect(wrongShape.message).toMatch(/schema/);
  });

  it('maps provider errors by kind', async () => {
    const cases: Array<[unknown, string]> = [
      [new ProviderError('auth', 'bad key', 401), 'unavailable'],
      [new ProviderError('auth', 'no', 403), 'unavailable'],
      [new ProviderError('busy', 'slow down', 429), 'busy'],
      [new ProviderError('busy', 'overloaded', 503), 'busy'],
      [new ProviderError('timeout', 'slow'), 'timeout'],
      [new ProviderError('unreachable', 'reset'), 'busy'],
      [new ProviderError('failed', 'bad', 400), 'failed'],
      [new ProviderError('aborted', 'cancelled'), 'failed'],
      [new Error('something else'), 'failed'],
    ];
    for (const [error, code] of cases) expect(classify(error).code, String(error)).toBe(code);

    const { analyst } = await harness([{ error: new ProviderError('busy', 'slow down', 429) }]);
    expect((await failure(analyst.analyze({ matchId: match.result.matchId, requester: human }))).code).toBe('busy');
  });
});

describe('analyst prompt and usage', () => {
  it('keeps the system prompt byte-identical across matches, so the prefix caches', async () => {
    const other = {
      ...playReferenceMatch({ label: 'analyst-other', strategies: ['random', 'random', 'reader', 'charger', 'guarder'] }),
      staked: true,
    };
    const archive = new MemoryArchive();
    await archive.save(match);
    await archive.save(other);
    const model = new FakeModel([answer(output()), answer(output())]);
    const analyst = new Analyst({ archive, model, modelId: 'gemini-3.8-flash', effort: 'medium', maxTokens: 16_000 });
    await analyst.analyze({ matchId: match.result.matchId, requester: human });
    await analyst.analyze({ matchId: other.result.matchId, requester: stranger });

    const prefix = (request: (typeof model.requests)[number] | undefined) =>
      JSON.stringify({ model: request?.model, system: request?.system, schema: request?.output_schema });
    expect(model.requests).toHaveLength(2);
    expect(prefix(model.requests[1])).toBe(prefix(model.requests[0]));
    expect(model.requests[1]?.prompt).not.toBe(model.requests[0]?.prompt);
  });

  it('reports the call\'s tokens', async () => {
    const reply = answer(output());
    if ('reply' in reply) reply.reply.usage = usage({ input_tokens: 150, cache_read_input_tokens: 3_200, output_tokens: 540 });
    const { analyst } = await harness([reply]);
    const result = await analyst.analyze({ matchId: match.result.matchId, requester: human });
    expect(result.usage).toMatchObject({ inputTokens: 150, cacheReadTokens: 3_200, outputTokens: 540 });
  });
});
