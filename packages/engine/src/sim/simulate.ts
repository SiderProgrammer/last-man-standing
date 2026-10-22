import { encodeAbiParameters, keccak256, parseAbiParameters } from 'viem';
import { Action, BOT_DIFFICULTIES, commitMove, type BotDifficulty, type Move, type Rules, type Seat } from '@lms/protocol';
import { Match } from '../match/match.js';
import { always, Prng, randomStrategy, readerStrategy, smartStrategy, type Strategy } from '../bots/strategy.js';

/**
 * Balance simulator: plays many bot matches under a rule set and reports how
 * each pure strategy fares against a mixed field.
 *
 * A rule change should come with a run of this showing that no mindless
 * strategy — always strike, guard or charge whenever it can — wins more than
 * its share, or makes money under the payout schedule.
 */

export type StrategyName = 'striker' | 'guarder' | 'charger' | 'random' | 'reader' | BotDifficulty;

/** The strategies that never look at the table. None of them may be worth playing. */
export const MINDLESS_STRATEGIES = ['striker', 'guarder', 'charger'] as const;

export const STRATEGY_NAMES: readonly StrategyName[] = [...MINDLESS_STRATEGIES, 'random', 'reader', ...BOT_DIFFICULTIES];

/** The deployed payout schedule and protocol fee, in basis points, for pricing a finish. */
export const DEFAULT_PAYOUT_BPS: readonly number[] = [6000, 2500, 1500];
export const DEFAULT_FEE_BPS = 500;

/** Strikes a random living opponent every round. */
export function strikerStrategy(prng: Prng): Strategy {
  return (seat, match) => {
    const opponents = match.alive.filter((other) => other !== seat);
    return { action: Action.Strike, target: opponents.length > 0 ? prng.pick(opponents) : seat };
  };
}

/** The strategy a name stands for, seeded with `prng`. */
export function strategyByName(name: StrategyName, prng: Prng): Strategy {
  switch (name) {
    case 'guarder':
      return always(Action.Guard);
    case 'charger':
      return always(Action.Charge);
    case 'striker':
      return strikerStrategy(prng);
    case 'random':
      return randomStrategy(prng);
    case 'reader':
      return readerStrategy(prng);
    case 'easy':
    case 'normal':
    case 'hard':
      return smartStrategy(prng, name);
  }
}

export interface StrategyStats {
  /** Seats this strategy occupied across all matches. */
  seats: number;
  wins: number;
  /** Wins divided by the wins a seat would expect by chance (1 / lobby size). */
  winRatio: number;
  /** Mean finishing place, 1 = winner. */
  meanPlace: number;
  /** Mean payout minus the stake, in stakes, under the payout schedule and fee. */
  meanProfit: number;
}

export interface SimulationReport {
  matches: number;
  byStrategy: Record<StrategyName, StrategyStats>;
  meanRounds: number;
  /** Matches that hit `maxRounds` instead of ending by elimination. */
  hitMaxRounds: number;
  /** Rounds in which the last-survivor rescue at 1 HP decided the winner. */
  rescues: number;
}

export interface SimulationOptions {
  rules: Rules;
  matches: number;
  /** Lobby sizes to cycle through. Each must be within the rules' seat range. */
  lobbySizes: readonly number[];
  seed?: string;
  strategies?: readonly StrategyName[];
  /** Share of the pot each place takes, best first. Defaults to the deployed schedule. */
  payoutBps?: readonly number[];
  feeBps?: number;
}

const LABEL_ABI = parseAbiParameters('string label');
const label = (text: string): `0x${string}` => keccak256(encodeAbiParameters(LABEL_ABI, [text]));

export function simulate(options: SimulationOptions): SimulationReport {
  const roster = options.strategies ?? STRATEGY_NAMES;
  const base = options.seed ?? 'lms-sim';
  const payout = options.payoutBps ?? DEFAULT_PAYOUT_BPS;
  const fee = options.feeBps ?? DEFAULT_FEE_BPS;

  const totals = Object.fromEntries(
    roster.map((name) => [name, { seats: 0, wins: 0, expectedWins: 0, placeSum: 0, profit: 0 }]),
  ) as Record<StrategyName, { seats: number; wins: number; expectedWins: number; placeSum: number; profit: number }>;

  let roundSum = 0;
  let hitMaxRounds = 0;
  let rescues = 0;

  for (let n = 0; n < options.matches; n += 1) {
    const size = options.lobbySizes[n % options.lobbySizes.length] as number;
    const prng = new Prng(label(`${base}:match:${n}`));

    // Seat a mixed field: each seat draws a strategy uniformly, so over many
    // matches every strategy meets every other in every position.
    const names = Array.from({ length: size }, () => prng.pick(roster));
    const seats: Seat[] = names.map((_, index) => ({
      index,
      address: `0x${(index + 1).toString(16).padStart(40, '0')}` as `0x${string}`,
      chainId: 0,
    }));
    const match = new Match({
      matchId: label(`${base}:id:${n}`),
      seats,
      seed: label(`${base}:seed:${n}`),
      rules: options.rules,
    });
    const strategies = names.map((name, seat) => strategyByName(name, new Prng(label(`${base}:${n}:${seat}`))));

    while (!match.finished) {
      const round = match.round;
      const living = match.alive;
      const chosen = new Map<number, Move & { salt: `0x${string}` }>();
      for (const seat of living) {
        const move = (strategies[seat] as Strategy)(seat, match);
        const salt = label(`${base}:salt:${n}:${round}:${seat}`);
        chosen.set(seat, { ...move, salt });
        match.submitCommit(seat, commitMove(match.matchId, round, seat, { ...move, salt }));
      }
      match.openRevealPhase();
      for (const seat of living) match.submitReveal(seat, chosen.get(seat) as Move & { salt: `0x${string}` });
      const record = match.resolve();
      // Everyone left fell in the same round and the survivor sits on exactly
      // 1 HP: the rescue rule, not play, picked the winner. (A survivor can
      // also land on 1 HP honestly, so this slightly overcounts.)
      const survivor = match.alive[0];
      if (
        match.finished &&
        record.eliminated.length > 0 &&
        record.eliminated.length === record.moves.length - 1 &&
        survivor !== undefined &&
        record.hpAfter[survivor] === 1
      ) {
        rescues += 1;
      }
    }

    roundSum += match.history.length;
    if (match.alive.length > 1) hitMaxRounds += 1;

    const pot = size * (1 - fee / 10_000);
    match.ranking().forEach((seat, place) => {
      const entry = totals[names[seat] as StrategyName];
      entry.seats += 1;
      entry.placeSum += place + 1;
      entry.expectedWins += 1 / size;
      entry.profit += ((payout[place] ?? 0) / 10_000) * pot - 1;
      if (place === 0) entry.wins += 1;
    });
  }

  const byStrategy = Object.fromEntries(
    roster.map((name) => {
      const entry = totals[name];
      return [
        name,
        {
          seats: entry.seats,
          wins: entry.wins,
          winRatio: entry.expectedWins === 0 ? 0 : entry.wins / entry.expectedWins,
          meanPlace: entry.seats === 0 ? 0 : entry.placeSum / entry.seats,
          meanProfit: entry.seats === 0 ? 0 : entry.profit / entry.seats,
        },
      ];
    }),
  ) as Record<StrategyName, StrategyStats>;

  return {
    matches: options.matches,
    byStrategy,
    meanRounds: roundSum / options.matches,
    hitMaxRounds,
    rescues,
  };
}

/**
 * Balance targets a rule set should meet. `simulate` measures; this judges.
 * Returns the list of failures, empty when the rules pass.
 */
export function balanceFailures(
  report: SimulationReport,
  limits: { maxWinRatio: number; maxMeanRounds: number; maxMindlessProfit?: number },
): string[] {
  const failures: string[] = [];
  for (const name of MINDLESS_STRATEGIES) {
    const stats = report.byStrategy[name];
    if (!stats || stats.seats === 0) continue;
    if (stats.winRatio > limits.maxWinRatio) {
      failures.push(`${name} wins ${stats.winRatio.toFixed(2)}x its share (limit ${limits.maxWinRatio})`);
    }
    if (limits.maxMindlessProfit !== undefined && stats.meanProfit > limits.maxMindlessProfit) {
      failures.push(`${name} makes ${stats.meanProfit.toFixed(2)} stakes per seat (limit ${limits.maxMindlessProfit})`);
    }
  }
  if (report.meanRounds > limits.maxMeanRounds) {
    failures.push(`matches last ${report.meanRounds.toFixed(1)} rounds on average (limit ${limits.maxMeanRounds})`);
  }
  return failures;
}
