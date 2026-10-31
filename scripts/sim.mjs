#!/usr/bin/env node
/**
 * `npm run sim` — plays bot matches under the default rules and reports how
 * each pure strategy fares against a mixed field.
 *
 *   npm run sim                       2000 matches, lobbies of 4 to 8
 *   npm run sim -- 500                500 matches
 *   npm run sim -- 500 strike=30 reflect=45
 *
 * Overrides are `key=value` pairs naming fields of `DEFAULT_RULES` by a short
 * alias (see `ALIASES`) or by their full name, so a candidate rule change can
 * be measured before it is proposed. Exits non-zero if the balance targets in
 * `TARGETS` fail, so it can gate a rules change in CI.
 */
import { DEFAULT_RULES, assertValidRules } from '@lms/consensus';
import { balanceFailures, simulate } from '@lms/engine/sim';

// Mindless play must lose: less than its share of wins, and money under the payout schedule.
const TARGETS = { maxWinRatio: 1, maxMeanRounds: 16, maxMindlessProfit: 0 };

const ALIASES = {
  strike: 'strikeDamage',
  heal: 'strikeHealBps',
  reflect: 'guardReflectDamage',
  bonus: 'chargeBonusDamage',
  exposure: 'chargeExposureBps',
  grace: 'stallGraceRounds',
  stall: 'stallDamage',
  hp: 'startingHp',
};

const args = process.argv.slice(2);
const matches = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 2000);
const rules = { ...DEFAULT_RULES };
for (const arg of args.filter((value) => value.includes('='))) {
  const [key, value] = arg.split('=');
  const field = ALIASES[key] ?? key;
  if (!(field in rules)) throw new Error(`unknown rule ${key}`);
  rules[field] = Number(value);
}
assertValidRules(rules);

const started = Date.now();
const report = simulate({ rules, matches, lobbySizes: [4, 5, 6, 7, 8] });

console.log(`${matches} matches in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`rules: ${JSON.stringify(rules)}`);
console.log('');
console.log('strategy    seats   wins   win ratio   mean place   profit/stake');
for (const [name, stats] of Object.entries(report.byStrategy)) {
  console.log(
    `${name.padEnd(10)} ${String(stats.seats).padStart(6)} ${String(stats.wins).padStart(6)}   ${stats.winRatio
      .toFixed(2)
      .padStart(9)}   ${stats.meanPlace.toFixed(2).padStart(10)}   ${(stats.meanProfit >= 0 ? '+' : '') + stats.meanProfit.toFixed(2)}`,
  );
}
console.log('');
console.log(`mean rounds ${report.meanRounds.toFixed(1)} · hit maxRounds ${report.hitMaxRounds} · 1-HP rescues ${report.rescues}`);

const failures = balanceFailures(report, TARGETS);
if (failures.length > 0) {
  console.log('');
  for (const failure of failures) console.log(`FAIL ${failure}`);
  process.exitCode = 1;
}
