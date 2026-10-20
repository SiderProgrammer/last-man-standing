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
import { FakeModel, answer, toolTurn, usage, type Turn } from './analystFakes.js';

// Staked, so a wallet that did not play may still ask for the spectator's view.
const match = { ...playReferenceMatch({ label: 'analyst', strategies: ['reader', 'aggressor', 'turtle', 'hider'] }), staked: true };
const human = (match.seats ?? [])[0]?.address as `0x${string}`;
const stranger = `0x${'99'.repeat(20)}` as const;

/** A claim the history supports: seat 2 is the turtle, so it defended in round 1. */
const TRUE_MOMENT = { round: 1, seat: 2, kind: 'defend', target: null, claim: 'The turtle dug in.' } as const;
/** One it does not: the turtle never attacks. */
const FALSE_MOMENT = { round: 1, seat: 2, kind: 'attack', target: 0, claim: 'The turtle lashed out.' } as const;

function output(overrides: Record<string, unknown> = {}) {
  return {
    summary: 'Seat #1 swung every round and paid for it.\nThe turtle outlasted everyone.',
    decisiveRound: 2,
    keyMoments: [TRUE_MOMENT, FALSE_MOMENT],
    advice: ['Defend when #1 has you in its sights.'],
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
    expect(JSON.stringify(model.requests[0]?.messages)).toMatch(/spectator/);
  });

  it('sends a frozen system prompt and keeps the match after it', async () => {
    const { analyst, model } = await harness([answer(output())]);
    await analyst.analyze({ matchId: match.result.matchId, requester: human });
    const request = model.requests[0];

    expect(request?.system).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).not.toContain(match.result.matchId);
    const user = JSON.stringify(request?.messages);
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
    const user = String(model.requests[0]?.messages[0]?.content);
    for (const record of match.history) expect(user).toContain(`Round ${record.round}:`);
    expect(user).toContain('#0 '); // the table
    expect(user).toContain('(you)');
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
    const { analyst } = await harness([
      {
        reply: {
          stop_reason: 'refusal',
          content: [],
        },
      },
    ]);
    expect((await failure(analyst.analyze({ matchId: match.result.matchId, requester: human }))).code).toBe('refused');
  });

  it('reports a truncated answer', async () => {
    const { analyst } = await harness([{ reply: { stop_reason: 'max_tokens', content: [] } }]);
    expect((await failure(analyst.analyze({ matchId: match.result.matchId, requester: human }))).code).toBe('failed');
  });

  it('rejects an answer that is not JSON, or not the schema', async () => {
    const prose: Turn = {
      reply: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here is my analysis!' }] },
    };
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

describe('analyst tool loop', () => {
  it('runs the tools the model asks for and answers with every result in one message', async () => {
    const { analyst, model } = await harness([
      toolTurn([
        { name: 'get_round', input: { round: 1 } },
        { name: 'get_reads', input: { seat: 2 } },
      ]),
      answer(output()),
    ]);
    const steps: string[] = [];
    const { analysis, usage } = await analyst.analyze({
      matchId: match.result.matchId,
      requester: human,
      onStep: (step) => steps.push(step),
    });

    expect(analysis.keyMoments).toEqual([TRUE_MOMENT]);
    // Every turn and every lookup is announced, so a slow call never looks like a hang.
    expect(steps).toEqual([
      'Reading the match overview',
      'Reading round 1',
      'Studying seat #2',
      'Thinking over what it found',
      'Checking the key moments against the rounds',
    ]);
    expect(usage).toMatchObject({ turns: 2, toolCalls: 2 });

    const second = model.requests[1];
    const [, assistant, results] = second?.messages ?? [];
    // The assistant turn is echoed whole, signature first.
    expect(assistant?.role).toBe('assistant');
    expect((assistant?.content as Array<{ type: string }>)[0]?.type).toBe('signature');
    expect(results?.role).toBe('user');
    const blocks = results?.content as Array<{ type: string; tool_use_id: string; content: string; is_error?: boolean }>;
    expect(blocks.map((block) => block.tool_use_id)).toEqual(['call_0', 'call_1']);
    expect(blocks[0]?.content).toContain('Round 1:');
    expect(blocks[1]?.content).toContain('Seat #2');
    expect(blocks.every((block) => block.is_error === undefined)).toBe(true);
  });

  it('keeps tools and system byte-identical across turns and matches, so the prefix caches', async () => {
    const other = {
      ...playReferenceMatch({ label: 'analyst-other', strategies: ['random', 'random', 'reader', 'hider', 'turtle'] }),
      staked: true,
    };
    const archive = new MemoryArchive();
    await archive.save(match);
    await archive.save(other);
    const model = new FakeModel([toolTurn([{ name: 'get_round', input: { round: 2 } }]), answer(output()), answer(output())]);
    const analyst = new Analyst({ archive, model, modelId: 'gemini-3.8-flash', effort: 'medium', maxTokens: 16_000 });
    await analyst.analyze({ matchId: match.result.matchId, requester: human });
    await analyst.analyze({ matchId: other.result.matchId, requester: stranger });

    const prefix = (request: (typeof model.requests)[number] | undefined) =>
      JSON.stringify({ model: request?.model, tools: request?.tools, system: request?.system });
    expect(model.requests).toHaveLength(3);
    expect(prefix(model.requests[1])).toBe(prefix(model.requests[0]));
    expect(prefix(model.requests[2])).toBe(prefix(model.requests[0]));
  });

  it('hands a bad tool call back to the model as an error instead of running it', async () => {
    const { analyst, model } = await harness([
      toolTurn([
        { name: 'get_round', input: { round: 'one' } },
        { name: 'get_wallet', input: { address: '0x0' } },
      ]),
      answer(output()),
    ]);
    await analyst.analyze({ matchId: match.result.matchId, requester: human });
    const results = model.requests[1]?.messages[2]?.content as Array<{ is_error?: boolean; content: string }>;
    expect(results.map((block) => block.is_error)).toEqual([true, true]);
    expect(results[0]?.content).toMatch(/invalid input/);
    expect(results[1]?.content).toMatch(/no tool named/);
  });

  it('switches tools off on the last allowed turn', async () => {
    const archive = new MemoryArchive();
    await archive.save(match);
    const model = new FakeModel([
      toolTurn([{ name: 'get_round', input: { round: 1 } }]),
      toolTurn([{ name: 'get_round', input: { round: 2 } }]),
      answer(output()),
    ]);
    const analyst = new Analyst({ archive, model, modelId: 'm', effort: 'low', maxTokens: 1_000, maxTurns: 3 });
    await analyst.analyze({ matchId: match.result.matchId, requester: human });
    expect(model.requests.map((request) => request.tool_choice)).toEqual([undefined, undefined, 'none']);
  });

  it('never runs a tool call cut off at the token limit', async () => {
    const { analyst, model } = await harness([toolTurn([{ name: 'get_round', input: { round: 1 } }], 'max_tokens')]);
    const error = await failure(analyst.analyze({ matchId: match.result.matchId, requester: human }));
    expect(error.code).toBe('failed');
    expect(model.requests).toHaveLength(1);
  });

  it('sums usage over every turn', async () => {
    const turn = toolTurn([{ name: 'get_round', input: { round: 1 } }]);
    if ('reply' in turn) turn.reply.usage = usage({ input_tokens: 100, cache_read_input_tokens: 3_000, output_tokens: 40 });
    const final = answer(output());
    if ('reply' in final) {
      final.reply.usage = usage({ input_tokens: 50, cache_read_input_tokens: 3_200 });
    }
    const { analyst } = await harness([turn, final]);
    const result = await analyst.analyze({ matchId: match.result.matchId, requester: human });
    expect(result.usage).toMatchObject({
      inputTokens: 150,
      cacheReadTokens: 6_200,
      outputTokens: 540,
    });
  });

  it('refuses a match archived before seats were recorded', async () => {
    const archive = new MemoryArchive();
    const { seats: _seats, ...legacy } = match;
    await archive.save(legacy);
    const model = new FakeModel([]);
    const analyst = new Analyst({ archive, model, modelId: 'm', effort: 'low', maxTokens: 1_000 });
    expect((await failure(analyst.analyze({ matchId: match.result.matchId, requester: human }))).code).toBe('not_found');
    expect(model.requests).toHaveLength(0);
  });
});
