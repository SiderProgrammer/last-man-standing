import { describe, expect, it } from 'vitest';
import {
  Analyst,
  AnalystError,
  ProviderError,
  AnalystLimits,
  KeyedLimiter,
  MemoryArchive,
  PostgresArchive,
  playReferenceMatch,
  turnCost,
  type ArchivedMatch,
  type ModelReply,
} from '@lms/server';
import type { MatchAnalysis } from '@lms/protocol';
import { FakeModel, answer, toolTurn, usage, type Turn } from './analystFakes.js';

const practice = playReferenceMatch({ label: 'prod', strategies: ['reader', 'striker', 'guarder', 'charger'] });
const staked: ArchivedMatch = { ...playReferenceMatch({ label: 'prod-staked', strategies: ['random', 'guarder', 'striker', 'reader'] }), staked: true };
const player = (match: ArchivedMatch, seat = 0) => match.seats?.[seat]?.address as `0x${string}`;
const stranger = `0x${'77'.repeat(20)}` as const;

function output() {
  return {
    summary: 'A short story of the match.',
    decisiveRound: 1,
    keyMoments: [{ round: 1, seat: 2, kind: 'guard', target: null, claim: 'Dug in.' }],
    advice: ['Watch the guarder.'],
  };
}

/** No provider rate limits, for tests about the other ceilings. */
const UNLIMITED = { requestsPerMinute: Infinity, requestsPerDay: Infinity };

/** A priced final turn: 1,000 input, 500 output, 4,000 read from cache. */
function pricedAnswer(): Turn {
  const turn = answer(output());
  if ('reply' in turn) {
    turn.reply.usage = usage({ input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 4_000 });
  }
  return turn;
}

async function harness(script: Turn[], extra: Partial<ConstructorParameters<typeof Analyst>[0]> = {}) {
  const archive = new MemoryArchive();
  await archive.save(practice);
  await archive.save(staked);
  const model = new FakeModel(script);
  let now = Date.UTC(2026, 9, 18, 12);
  const analyst = new Analyst({
    archive,
    model,
    modelId: 'gemini-3.8-flash',
    effort: 'medium',
    maxTokens: 16_000,
    now: () => now,
    ...extra,
  });
  return { analyst, model, archive, advance: (ms: number) => (now += ms) };
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

describe('analysis access', () => {
  it('lets a player analyse their own practice match', async () => {
    const { analyst } = await harness([answer(output())]);
    const { analysis } = await analyst.analyze({ matchId: practice.result.matchId, requester: player(practice) });
    expect(analysis.seat).toBe(0);
  });

  it('keeps a practice match private to the player who sat in it', async () => {
    const { analyst, model } = await harness([]);
    const error = await failure(analyst.analyze({ matchId: practice.result.matchId, requester: stranger }));
    expect(error.code).toBe('forbidden');
    expect(model.requests).toHaveLength(0);
  });

  it('opens a staked match to spectators, written for no seat', async () => {
    const { analyst } = await harness([answer(output())]);
    const { analysis } = await analyst.analyze({ matchId: staked.result.matchId, requester: stranger });
    expect(analysis.seat).toBeNull();
  });
});

describe('analysis cache', () => {
  it('answers the same question twice for the price of once', async () => {
    const { analyst, model } = await harness([answer(output())]);
    const request = { matchId: practice.result.matchId, requester: player(practice) };
    const first = await analyst.analyze(request);
    const second = await analyst.analyze(request);

    expect(model.requests).toHaveLength(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.usage).toBeUndefined();
    expect(second.analysis).toEqual(first.analysis);
  });

  it('keeps one answer per seat, since the advice differs', async () => {
    const { analyst, model } = await harness([answer(output()), answer(output())]);
    await analyst.analyze({ matchId: staked.result.matchId, requester: player(staked, 0) });
    await analyst.analyze({ matchId: staked.result.matchId, requester: player(staked, 1) });
    expect(model.requests).toHaveLength(2);
  });

  it('stops serving answers written under another prompt, model or effort', async () => {
    const archive = new MemoryArchive();
    await archive.save(practice);
    const base = { archive, modelId: 'gemini-3.8-flash', effort: 'medium' as const, maxTokens: 1_000 };
    const before = new Analyst({ ...base, model: new FakeModel([answer(output())]) });
    const after = new Analyst({ ...base, effort: 'high', model: new FakeModel([answer(output())]) });
    expect(after.version).not.toBe(before.version);

    const request = { matchId: practice.result.matchId, requester: player(practice) };
    await before.analyze(request);
    expect((await after.analyze(request)).cached).toBe(false);
  });

  it('shares an analysis already being written instead of starting another', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const model = new FakeModel([answer(output())]);
    const slow = {
      generate: async (...args: Parameters<FakeModel['generate']>): Promise<ModelReply> => {
        await gate;
        return model.generate(...args);
      },
    };
    const { analyst } = await harness([], { model: slow });
    const request = { matchId: practice.result.matchId, requester: player(practice) };
    const first = analyst.analyze(request);
    const second = analyst.analyze(request);
    await new Promise((resolve) => setImmediate(resolve));
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(model.requests).toHaveLength(1);
    expect(b.analysis).toEqual(a.analysis);
    expect(b.cached).toBe(true);
  });

  it('round-trips through the Postgres archive, keyed by lower-cased id, seat and version', async () => {
    const rows = new Map<string, unknown>();
    const pool = {
      async query(text: string, values: unknown[] = []) {
        const [matchId, seat, version, json] = values as [string, number, string, string];
        const key = `${matchId}|${seat}|${version}`;
        if (text.startsWith('INSERT INTO match_analyses')) {
          if (!rows.has(key)) rows.set(key, JSON.parse(json));
          return { rows: [] };
        }
        const found = rows.get(key);
        return { rows: found ? [{ analysis: found }] : [] };
      },
    };
    const archive = PostgresArchive.fromPool(pool);
    const analysis: MatchAnalysis = {
      matchId: `0x${'AB'.repeat(32)}`,
      seat: null,
      summary: 's',
      decisiveRound: null,
      keyMoments: [],
      advice: [],
      dropped: 0,
      model: 'gemini-3.8-flash',
    };
    await archive.saveAnalysis({ analysis, version: 'v1' });

    expect([...rows.keys()]).toEqual([`0x${'ab'.repeat(32)}|-1|v1`]);
    expect(await archive.loadAnalysis(`0x${'ab'.repeat(32)}`, null, 'v1')).toEqual(analysis);
    expect(await archive.loadAnalysis(`0x${'ab'.repeat(32)}`, null, 'v2')).toBeNull();
    expect(await archive.loadAnalysis(`0x${'ab'.repeat(32)}`, 0, 'v1')).toBeNull();
  });
});

describe('analysis limits', () => {
  it('stops a wallet at its hourly allowance, without touching the model', async () => {
    const limits = new AnalystLimits({ ...UNLIMITED, perWalletPerHour: 1, maxConcurrent: 4, dailyBudgetUsd: Infinity });
    const { analyst, model } = await harness([answer(output())], { limits });
    await analyst.analyze({ matchId: practice.result.matchId, requester: player(practice) });
    const error = await failure(analyst.analyze({ matchId: staked.result.matchId, requester: player(practice) }));
    expect(error.code).toBe('quota');
    expect(model.requests).toHaveLength(1);
  });

  it('never charges for an answer from the cache', async () => {
    const limits = new AnalystLimits({ ...UNLIMITED, perWalletPerHour: 1, maxConcurrent: 4, dailyBudgetUsd: Infinity });
    const { analyst } = await harness([answer(output())], { limits });
    const request = { matchId: practice.result.matchId, requester: player(practice) };
    await analyst.analyze(request);
    expect((await analyst.analyze(request)).cached).toBe(true);
  });

  it("refunds the allowance when the provider, not the player, failed", async () => {
    const limits = new AnalystLimits({ ...UNLIMITED, perWalletPerHour: 1, maxConcurrent: 4, dailyBudgetUsd: Infinity });
    const overloaded = new ProviderError('busy', 'overloaded', 503);
    const { analyst } = await harness([{ error: overloaded }, answer(output())], { limits });
    const request = { matchId: practice.result.matchId, requester: player(practice) };
    expect((await failure(analyst.analyze(request))).code).toBe('busy');
    expect((await analyst.analyze(request)).cached).toBe(false);
  });

  it('does not refund a refusal', async () => {
    const limits = new AnalystLimits({ ...UNLIMITED, perWalletPerHour: 1, maxConcurrent: 4, dailyBudgetUsd: Infinity });
    const refusal: Turn = { reply: { stop_reason: 'refusal', content: [] } };
    const { analyst } = await harness([refusal], { limits });
    const request = { matchId: practice.result.matchId, requester: player(practice) };
    expect((await failure(analyst.analyze(request))).code).toBe('refused');
    expect((await failure(analyst.analyze(request))).code).toBe('quota');
  });

  it('caps analyses in flight across every wallet', () => {
    const limits = new AnalystLimits({ ...UNLIMITED, perWalletPerHour: 10, maxConcurrent: 1, dailyBudgetUsd: Infinity });
    const first = limits.admit(player(practice), 0);
    expect('release' in first).toBe(true);
    expect(limits.admit(stranger, 0)).toMatchObject({ code: 'busy' });
    if ('release' in first) first.release(false, 0);
    expect('release' in limits.admit(stranger, 0)).toBe(true);
  });

  it('stops fresh analyses once the day budget is spent, until the next UTC day', async () => {
    const limits = new AnalystLimits({ ...UNLIMITED, perWalletPerHour: 10, maxConcurrent: 4, dailyBudgetUsd: 0.002 });
    const { analyst, advance } = await harness([pricedAnswer(), answer(output())], { limits });
    await analyst.analyze({ matchId: practice.result.matchId, requester: player(practice) });
    expect(limits.spent).toBeGreaterThan(0.002);

    const blocked = await failure(analyst.analyze({ matchId: staked.result.matchId, requester: player(staked) }));
    expect(blocked.code).toBe('quota');
    expect(blocked.message).toMatch(/budget/);

    advance(24 * 3_600_000);
    expect((await analyst.analyze({ matchId: staked.result.matchId, requester: player(staked) })).cached).toBe(false);
  });

  it('refills a wallet over the hour, and refunds never exceed the burst', () => {
    const limiter = new KeyedLimiter(1 / 3_600, 2);
    expect(limiter.take('a', 0)).toBe(true);
    expect(limiter.take('a', 0)).toBe(true);
    expect(limiter.take('a', 0)).toBe(false);
    limiter.refund('a', 0, 5);
    expect(limiter.take('a', 0)).toBe(true);
    expect(limiter.take('a', 0)).toBe(true);
    expect(limiter.take('a', 0)).toBe(false);
    expect(limiter.take('a', 3_600_000)).toBe(true);
  });
});

describe('analysis deadline', () => {
  it('stops a model that never answers and reports a timeout', async () => {
    const { analyst } = await harness([{ hang: true }], { deadlineMs: 20 });
    const error = await failure(analyst.analyze({ matchId: practice.result.matchId, requester: player(practice) }));
    expect(error.code).toBe('timeout');
  });

  it('tells a cancellation by the asker apart from a timeout', async () => {
    const { analyst } = await harness([{ hang: true }]);
    const controller = new AbortController();
    const pending = analyst.analyze({
      matchId: practice.result.matchId,
      requester: player(practice),
      signal: controller.signal,
    });
    controller.abort();
    const error = await failure(pending);
    expect(error.code).toBe('failed');
    expect(error.message).toMatch(/cancelled/);
  });
});

describe('analysis cost', () => {
  it('prices a turn at list rates, cache reads included', () => {
    const cost = turnCost('gemini-3.8-flash', usage({ input_tokens: 1_000_000, output_tokens: 0 }));
    expect(cost).toBeCloseTo(0.75);
    expect(turnCost('gemini-3.8-flash', usage({ input_tokens: 0, output_tokens: 1_000_000 }))).toBeCloseTo(3.75);
    expect(turnCost('gemini-3.8-flash', usage({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }))).toBeCloseTo(0.075);
    expect(turnCost('some-future-model', usage())).toBeNull();
  });

  it('accounts tokens, cost and verifier drops', async () => {
    const turn = pricedAnswer();
    if ('reply' in turn) {
      const text = JSON.stringify({
        ...output(),
        keyMoments: [...output().keyMoments, { round: 99, seat: 0, kind: 'guard', target: null, claim: 'never happened' }],
      });
      turn.reply.content = [{ type: 'text', text }];
    }
    const { analyst } = await harness([turn]);
    const { usage: spent, analysis } = await analyst.analyze({ matchId: practice.result.matchId, requester: player(practice) });

    expect(spent).toMatchObject({ turns: 1, inputTokens: 1_000, cacheReadTokens: 4_000, outputTokens: 500 });
    expect(spent?.costUsd).toBeCloseTo((1_000 * 0.75 + 500 * 3.75 + 4_000 * 0.075) / 1_000_000);
    expect(analysis.keyMoments).toHaveLength(1);
    expect(analysis.dropped).toBe(1);
  });
});

describe('provider rate limits', () => {
  const PACIFIC_NOON = Date.UTC(2026, 9, 20, 19);
  const limits = (rpm: number, rpd: number) =>
    new AnalystLimits({ perWalletPerHour: 100, maxConcurrent: 4, dailyBudgetUsd: Infinity, requestsPerMinute: rpm, requestsPerDay: rpd });

  it('books requests into the minute, then queues the next one behind the oldest', () => {
    const quota = limits(5, 100);
    for (let i = 0; i < 5; i++) expect(quota.reserve(PACIFIC_NOON + i * 1_000)).toEqual({ waitMs: 0 });
    // The sixth must wait until the first leaves the window, a minute after it went.
    expect(quota.reserve(PACIFIC_NOON + 10_000)).toEqual({ waitMs: 50_000 });
    // The seventh queues behind the second.
    expect(quota.reserve(PACIFIC_NOON + 10_000)).toEqual({ waitMs: 51_000 });
    // Once the window has passed, requests go straight out again.
    expect(quota.reserve(PACIFIC_NOON + 200_000)).toEqual({ waitMs: 0 });
  });

  it('refuses requests past the daily allowance until midnight Pacific', () => {
    const quota = limits(Infinity, 2);
    expect(quota.reserve(PACIFIC_NOON)).toEqual({ waitMs: 0 });
    expect(quota.reserve(PACIFIC_NOON)).toEqual({ waitMs: 0 });
    expect(quota.reserve(PACIFIC_NOON)).toMatchObject({ code: 'quota' });
    expect(quota.requests).toBe(2);
    // 23:59 Pacific is still the same quota day; 00:01 is the next one.
    expect(quota.reserve(PACIFIC_NOON + 12 * 3_600_000 - 60_000)).toMatchObject({ code: 'quota' });
    expect(quota.reserve(PACIFIC_NOON + 12 * 3_600_000 + 60_000)).toEqual({ waitMs: 0 });
  });

  it('only starts an analysis the day still has room for', () => {
    const quota = limits(Infinity, 5);
    for (let i = 0; i < 2; i++) quota.reserve(PACIFIC_NOON);
    expect('release' in quota.admit(player(practice), PACIFIC_NOON, 3)).toBe(true);
    expect(quota.admit(stranger, PACIFIC_NOON, 4)).toMatchObject({ code: 'quota' });
  });

  it('waits for a slot between turns instead of tripping the provider', async () => {
    const quota = limits(1, 100);
    const waits: number[] = [];
    const steps: string[] = [];
    const { analyst, model } = await harness([toolTurn([{ name: 'get_round', input: { round: 1 } }]), answer(output())], {
      limits: quota,
      sleep: async (ms) => void waits.push(ms),
    });
    await analyst.analyze({ matchId: practice.result.matchId, requester: player(practice), onStep: (step) => steps.push(step) });
    expect(model.requests).toHaveLength(2);
    expect(waits).toEqual([60_000]);
    // The wait is said out loud, with how long it will be.
    expect(steps).toContain('Waiting for a free Gemini slot, about 60s (free-tier rate limit)');
  });

  it('refuses a new analysis once the daily requests are used up', async () => {
    const quota = limits(Infinity, 1);
    const { analyst } = await harness([answer(output())], { limits: quota, maxTurns: 1 });
    await analyst.analyze({ matchId: practice.result.matchId, requester: player(practice) });
    const error = await failure(analyst.analyze({ matchId: staked.result.matchId, requester: player(staked) }));
    expect(error.code).toBe('quota');
    expect(error.message).toMatch(/model requests/);
  });
});
