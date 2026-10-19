import type { StrategyName } from '@lms/engine';
import type { MatchAnalysis, RoundRecord } from '@lms/protocol';
import type { AnalysisUsage } from './analyst.js';
import { playReferenceMatch, type ReferenceMatch } from './reference.js';

/**
 * The analyst's eval suite: reference matches whose facts are known, and the
 * scores an answer earns against them.
 *
 * Every case is a real game played by the engine's seeded bots, so the
 * ground truth is the round history itself and the suite is identical on
 * every run. Scoring is mechanical — no second model grades the first —
 * which keeps the numbers cheap to compute and impossible to argue with,
 * at the price of measuring only what can be checked mechanically.
 */
export interface EvalCase {
  name: string;
  match: ReferenceMatch;
  /** Whose analysis is asked for: a seat, or null for a spectator. */
  seat: number | null;
  /** The seat that won. */
  winner: number;
  /**
   * Rounds that count as decisive: those that eliminated the most players,
   * plus the round that left the winner alone. A heuristic, stated here so
   * the score means something specific: did the analyst point at a round
   * where the field actually changed.
   */
  decisiveRounds: number[];
}

/** Mixes chosen so each lobby has a different shape of game: brawls, standoffs, a lone reader. */
const MIXES: StrategyName[][] = [
  ['aggressor', 'turtle', 'hider', 'reader'],
  ['reader', 'reader', 'random', 'aggressor'],
  ['turtle', 'turtle', 'aggressor', 'aggressor'],
  ['hider', 'random', 'reader', 'turtle', 'aggressor'],
  ['aggressor', 'aggressor', 'aggressor', 'reader', 'hider'],
  ['random', 'random', 'random', 'random', 'random', 'reader'],
  ['reader', 'turtle', 'hider', 'aggressor', 'random', 'turtle'],
  ['aggressor', 'reader', 'reader', 'reader', 'hider', 'turtle', 'random'],
  ['turtle', 'hider', 'turtle', 'hider', 'aggressor', 'random', 'reader', 'aggressor'],
  ['random', 'aggressor', 'reader', 'hider', 'turtle', 'random', 'reader', 'random'],
  ['hider', 'hider', 'aggressor', 'reader'],
  ['reader', 'random', 'turtle', 'random', 'aggressor'],
];

/**
 * The suite: every mix played twice under different seeds, once asked from
 * seat 0 and once by a spectator. 24 cases by default.
 */
export function referenceSuite(size = MIXES.length * 2): EvalCase[] {
  const cases: EvalCase[] = [];
  for (let i = 0; i < size; i += 1) {
    const mix = MIXES[i % MIXES.length] as StrategyName[];
    const name = `case-${String(i + 1).padStart(2, '0')}-${mix.length}p`;
    // Staked, so the spectator cases are allowed to ask.
    const match: ReferenceMatch = { ...playReferenceMatch({ label: name, strategies: mix }), staked: true };
    cases.push({
      name,
      match,
      seat: i % 2 === 0 ? 0 : null,
      winner: winnerOf(match),
      decisiveRounds: decisiveRounds(match.history),
    });
  }
  return cases;
}

export interface EvalScore {
  name: string;
  /** Key moments the model claimed, before the verifier. */
  claims: number;
  /** Those the history supported. */
  verified: number;
  /** verified / claims; null when the model made no claims. */
  groundingRate: number | null;
  /** The analysis named a decisive round from the case's set. */
  decisiveHit: boolean;
  /** The narrative names the winner by seat. */
  namesWinner: boolean;
  costUsd: number | null;
  latencyMs: number;
  /** Share of prompt tokens read from the prompt cache. */
  promptCacheHitRate: number | null;
}

export function scoreAnalysis(test: EvalCase, analysis: MatchAnalysis, usage?: AnalysisUsage): EvalScore {
  const verified = analysis.keyMoments.length;
  const claims = verified + analysis.dropped;
  const prompt = usage ? usage.inputTokens + usage.cacheReadTokens : 0;
  return {
    name: test.name,
    claims,
    verified,
    groundingRate: claims === 0 ? null : verified / claims,
    decisiveHit: analysis.decisiveRound !== null && test.decisiveRounds.includes(analysis.decisiveRound),
    namesWinner: new RegExp(`#${test.winner}(?!\\d)`).test(analysis.summary),
    costUsd: usage?.costUsd ?? null,
    latencyMs: usage?.latencyMs ?? 0,
    promptCacheHitRate: usage && prompt > 0 ? usage.cacheReadTokens / prompt : null,
  };
}

export interface EvalSummary {
  cases: number;
  failures: number;
  /** All verified claims over all claims, pooled across cases. */
  groundingRate: number | null;
  decisiveRoundRate: number;
  winnerNamedRate: number;
  totalCostUsd: number;
  meanLatencyMs: number;
  meanPromptCacheHitRate: number | null;
}

export function summarize(scores: readonly EvalScore[], failures: number): EvalSummary {
  const claims = scores.reduce((sum, score) => sum + score.claims, 0);
  const verified = scores.reduce((sum, score) => sum + score.verified, 0);
  const rate = (count: number) => (scores.length === 0 ? 0 : count / scores.length);
  const cacheRates = scores.map((score) => score.promptCacheHitRate).filter((value): value is number => value !== null);
  return {
    cases: scores.length + failures,
    failures,
    groundingRate: claims === 0 ? null : verified / claims,
    decisiveRoundRate: rate(scores.filter((score) => score.decisiveHit).length),
    winnerNamedRate: rate(scores.filter((score) => score.namesWinner).length),
    totalCostUsd: scores.reduce((sum, score) => sum + (score.costUsd ?? 0), 0),
    meanLatencyMs: rate(scores.reduce((sum, score) => sum + score.latencyMs, 0)),
    meanPromptCacheHitRate:
      cacheRates.length === 0 ? null : cacheRates.reduce((sum, value) => sum + value, 0) / cacheRates.length,
  };
}

/** The summary as a Markdown table row, matching the README's results table. */
export function markdownRow(label: string, summary: EvalSummary): string {
  const pct = (value: number | null) => (value === null ? '–' : `${(value * 100).toFixed(1)}%`);
  return `| ${label} | ${summary.cases} | ${pct(summary.groundingRate)} | ${pct(summary.decisiveRoundRate)} | ${pct(
    summary.winnerNamedRate,
  )} | ${pct(summary.meanPromptCacheHitRate)} | $${summary.totalCostUsd.toFixed(3)} | ${(summary.meanLatencyMs / 1000).toFixed(1)} s |`;
}

/** The winner's seat, from the signed ranking: a match that hits its round cap can end with several standing. */
export function winnerOf(match: ReferenceMatch): number {
  const winner = match.result.ranking[0]?.toLowerCase();
  return match.seats?.find((seat) => seat.address.toLowerCase() === winner)?.index ?? 0;
}

/** See `EvalCase.decisiveRounds`. */
export function decisiveRounds(history: readonly RoundRecord[]): number[] {
  const most = Math.max(0, ...history.map((record) => record.eliminated.length));
  const rounds = new Set(history.filter((record) => most > 0 && record.eliminated.length === most).map((r) => r.round));
  const last = history[history.length - 1];
  if (last) rounds.add(last.round);
  return [...rounds].sort((a, b) => a - b);
}
