import { describe, expect, it } from 'vitest';
import type { MatchAnalysis } from '@lms/protocol';
import { markdownRow, referenceSuite, scoreAnalysis, summarize, type AnalysisUsage } from '@lms/server';

const suite = referenceSuite();

function analysis(fields: Partial<MatchAnalysis> = {}): MatchAnalysis {
  return {
    matchId: suite[0]?.match.result.matchId as `0x${string}`,
    seat: 0,
    summary: '',
    decisiveRound: null,
    keyMoments: [],
    advice: [],
    dropped: 0,
    model: 'claude-opus-5-5',
    ...fields,
  };
}

describe('analyst eval suite', () => {
  it('is 24 distinct, staked reference matches, half asked by a spectator', () => {
    expect(suite).toHaveLength(24);
    expect(new Set(suite.map((test) => test.match.result.matchId)).size).toBe(24);
    expect(suite.every((test) => test.match.staked === true)).toBe(true);
    expect(suite.filter((test) => test.seat === null)).toHaveLength(12);
    expect(new Set(suite.map((test) => test.match.seats?.length))).toEqual(new Set([4, 5, 6, 7, 8]));
  });

  it('plays the same matches every time', () => {
    const again = referenceSuite();
    expect(again.map((test) => test.match.result.historyRoot)).toEqual(suite.map((test) => test.match.result.historyRoot));
  });

  it('takes the winner from the signed ranking', () => {
    for (const test of suite) {
      expect(test.match.seats?.[test.winner]?.address).toBe(test.match.result.ranking[0]);
    }
  });

  it('accepts as decisive the final round and the rounds that knocked out the most', () => {
    for (const test of suite) {
      const history = test.match.history;
      expect(test.decisiveRounds).toContain(history.length);
      const most = Math.max(...history.map((record) => record.eliminated.length));
      for (const round of test.decisiveRounds) {
        const record = history[round - 1];
        expect(round === history.length || record?.eliminated.length === most).toBe(true);
      }
    }
  });
});

describe('analyst eval scoring', () => {
  const test = suite[0]!;
  const moment = { round: 1, seat: 0, kind: 'defend' as const, target: null, claim: 'x' };

  it('counts grounding as verified over claimed', () => {
    const score = scoreAnalysis(test, analysis({ keyMoments: [moment, moment, moment], dropped: 1 }));
    expect(score).toMatchObject({ claims: 4, verified: 3, groundingRate: 0.75 });
    expect(scoreAnalysis(test, analysis()).groundingRate).toBeNull();
  });

  it('scores the decisive round against the accepted set', () => {
    const [accepted] = test.decisiveRounds;
    expect(scoreAnalysis(test, analysis({ decisiveRound: accepted ?? 1 })).decisiveHit).toBe(true);
    expect(scoreAnalysis(test, analysis({ decisiveRound: 999 })).decisiveHit).toBe(false);
    expect(scoreAnalysis(test, analysis({ decisiveRound: null })).decisiveHit).toBe(false);
  });

  it('checks the narrative names the winner, and not a seat that merely starts with the same digit', () => {
    expect(scoreAnalysis(test, analysis({ summary: `In the end #${test.winner} survived.` })).namesWinner).toBe(true);
    expect(scoreAnalysis(test, analysis({ summary: `#${test.winner}5 survived.` })).namesWinner).toBe(false);
  });

  it('pools grounding across cases rather than averaging rates', () => {
    const usage: AnalysisUsage = {
      model: 'claude-opus-5-5',
      turns: 2,
      toolCalls: 1,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 300,
      cacheWriteTokens: 100,
      costUsd: 0.01,
      latencyMs: 2_000,
    };
    const a = scoreAnalysis(test, analysis({ keyMoments: [moment], dropped: 0 }), usage);
    const b = scoreAnalysis(test, analysis({ keyMoments: [moment], dropped: 3 }), usage);
    const summary = summarize([a, b], 1);

    expect(summary.cases).toBe(3);
    expect(summary.failures).toBe(1);
    expect(summary.groundingRate).toBeCloseTo(2 / 5);
    expect(summary.totalCostUsd).toBeCloseTo(0.02);
    expect(summary.meanPromptCacheHitRate).toBeCloseTo(0.6);
    expect(markdownRow('opus · medium', summary)).toBe('| opus · medium | 3 | 40.0% | 0.0% | 0.0% | 60.0% | $0.020 | 2.0 s |');
  });
});
