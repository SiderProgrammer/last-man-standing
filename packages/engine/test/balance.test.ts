import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '@lms/protocol';
import { balanceFailures, simulate } from '@lms/engine';

/**
 * A cheap guard on the default rules. `npm run sim` is the real measurement
 * (2000 matches, mindless play gated below its share and below break-even);
 * this smaller run uses a wider margin so its sampling noise never fails the
 * build, while still catching a change that makes one mindless strategy worth
 * playing. Without the Guard cooldown, always-Guard wins over 3x its share.
 */
describe('default rules balance', () => {
  it('lets no pure strategy run away with the game', () => {
    const report = simulate({
      rules: DEFAULT_RULES,
      matches: 300,
      lobbySizes: [4, 5, 6, 7, 8],
      seed: 'balance-test',
    });
    expect(balanceFailures(report, { maxWinRatio: 1.2, maxMeanRounds: 16, maxMindlessProfit: 0.1 })).toEqual([]);
    expect(report.hitMaxRounds).toBe(0);
  }, 60_000);
});

describe('house bot difficulty', () => {
  it('plays better at each level, and hard beats every mindless strategy', () => {
    const report = simulate({
      rules: DEFAULT_RULES,
      matches: 300,
      lobbySizes: [4, 5, 6, 7, 8],
      seed: 'difficulty-test',
      strategies: ['striker', 'guarder', 'charger', 'random', 'easy', 'normal', 'hard'],
    });
    const ratio = (name: keyof typeof report.byStrategy) => report.byStrategy[name].winRatio;
    expect(ratio('easy')).toBeLessThan(ratio('normal'));
    expect(ratio('normal')).toBeLessThan(ratio('hard'));
    for (const name of ['striker', 'guarder', 'charger', 'random'] as const) {
      expect(ratio('hard')).toBeGreaterThan(ratio(name));
    }
  }, 60_000);
});
