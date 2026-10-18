import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { Action, type RoundRecord } from '@lms/protocol';
import { Analyst, AnalystError, MemoryArchive, SYSTEM_PROMPT, classify, playReferenceMatch } from '@lms/server';
import { FakeModel, answer, type Turn } from './analystFakes.js';

const match = playReferenceMatch({ label: 'analyst', strategies: ['reader', 'aggressor', 'turtle', 'hider'] });
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
  const analyst = new Analyst({ archive, model, modelId: 'claude-opus-5-5', effort: 'medium', maxTokens: 16_000 });
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
  it('streams the narrative and returns a verified analysis', async () => {
    const { analyst } = await harness([answer(output(), 7)]);
    const deltas: string[] = [];
    const { analysis, cached } = await analyst.analyze({
      matchId: match.result.matchId,
      requester: human,
      onDelta: (text) => deltas.push(text),
    });

    expect(cached).toBe(false);
    expect(deltas.length).toBeGreaterThan(3);
    expect(deltas.join('')).toBe(output().summary);
    expect(analysis.summary).toBe(output().summary);
    expect(analysis.seat).toBe(0);
    expect(analysis.decisiveRound).toBe(2);
    expect(analysis.keyMoments).toEqual([TRUE_MOMENT]);
    expect(analysis.dropped).toBe(1);
    expect(analysis.advice).toEqual(output().advice);
  });

  it('writes for a spectator when the asker did not play', async () => {
    const { analyst, model } = await harness([answer(output())]);
    const { analysis } = await analyst.analyze({ matchId: match.result.matchId, requester: stranger });
    expect(analysis.seat).toBeNull();
    expect(JSON.stringify(model.requests[0]?.messages)).toMatch(/spectator/);
  });

  it('sends a frozen, cacheable system prompt and keeps the match after it', async () => {
    const { analyst, model } = await harness([answer(output())]);
    await analyst.analyze({ matchId: match.result.matchId, requester: human });
    const request = model.requests[0];

    expect(request?.system).toEqual([{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
    expect(SYSTEM_PROMPT).not.toContain(match.result.matchId);
    const user = JSON.stringify(request?.messages);
    expect(user).toContain(match.result.matchId);
    expect(user).toContain('seat #0');
  });

  it('pins effort, structured output and the refusal fallback', async () => {
    const { analyst, model } = await harness([answer(output())]);
    await analyst.analyze({ matchId: match.result.matchId, requester: human });
    const request = model.requests[0];

    expect(request?.model).toBe('claude-opus-5-5');
    expect(request?.output_config?.effort).toBe('medium');
    expect(request?.output_config?.format?.type).toBe('json_schema');
    expect(request?.betas).toContain('server-side-fallback-2026-07-01');
    expect(request?.fallbacks).toBe('default');
    // Thinking is always on for this model; sending `disabled` would be a 400.
    expect(request?.thinking).toBeUndefined();
  });

  it('renders every round of the match for the model', async () => {
    const { analyst, model } = await harness([answer(output())]);
    await analyst.analyze({ matchId: match.result.matchId, requester: human });
    const user = String(model.requests[0]?.messages[0]?.content);
    for (const record of match.history) expect(user).toContain(`Round ${record.round}:`);
    const first = match.history[0] as RoundRecord;
    const turtle = first.moves.find((move) => move.index === 2);
    expect(turtle?.action).toBe(Action.Defend);
    expect(user).toContain('#2 defend');
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
          stop_details: {
            type: 'refusal',
            category: null,
            explanation: null,
            fallback_credit_token: null,
            fallback_has_prefill_claim: false,
            recommended_model: null,
          },
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
      reply: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here is my analysis!', citations: null }] },
    };
    const { analyst } = await harness([prose, answer({ summary: 'no moments, no advice' })]);
    const notJson = await failure(analyst.analyze({ matchId: match.result.matchId, requester: human }));
    expect(notJson.code).toBe('failed');
    expect(notJson.message).toMatch(/not JSON/);
    const wrongShape = await failure(analyst.analyze({ matchId: match.result.matchId, requester: human }));
    expect(wrongShape.message).toMatch(/schema/);
  });

  it('maps provider errors by class', async () => {
    const headers = new Headers();
    const cases: Array<[unknown, string]> = [
      [new Anthropic.AuthenticationError(401, {}, 'bad key', headers), 'unavailable'],
      [new Anthropic.PermissionDeniedError(403, {}, 'no', headers), 'unavailable'],
      [new Anthropic.RateLimitError(429, {}, 'slow down', headers), 'busy'],
      [new Anthropic.InternalServerError(529, {}, 'overloaded', headers), 'busy'],
      [new Anthropic.APIConnectionTimeoutError(), 'timeout'],
      [new Anthropic.APIConnectionError({ message: 'reset' }), 'busy'],
      [new Anthropic.BadRequestError(400, {}, 'bad', headers), 'failed'],
      [new Error('something else'), 'failed'],
    ];
    for (const [error, code] of cases) expect(classify(error).code, String(error)).toBe(code);

    const { analyst } = await harness([{ error: new Anthropic.RateLimitError(429, {}, 'slow down', headers) }]);
    expect((await failure(analyst.analyze({ matchId: match.result.matchId, requester: human }))).code).toBe('busy');
  });
});
