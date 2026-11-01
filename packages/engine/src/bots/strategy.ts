import { encodeAbiParameters, keccak256, parseAbiParameters } from 'viem';
import {
  Action,
  exposedDamage,
  isLegalAction,
  legalActions,
  stallDamageFor,
  strikeDamageFor,
  strikeHeal,
  type ActionValue,
  type BotDifficulty,
  type Move,
  type PlayerState,
  type Rules,
} from '@lms/consensus';
import type { Match } from '../match/match.js';

/** Counter-based keccak PRNG, so bot play is reproducible given a seed. */
export class Prng {
  private counter = 0n;

  constructor(private readonly seed: `0x${string}`) {}

  next(bound: number): number {
    if (bound <= 0) return 0;
    const digest = keccak256(
      encodeAbiParameters(parseAbiParameters('bytes32 seed, uint256 counter'), [this.seed, this.counter]),
    );
    this.counter += 1n;
    return Number(BigInt(digest) % BigInt(bound));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.next(items.length)] as T;
  }
}

/**
 * Cheap seeded floats for the inner loop of a decision. One keccak draw from
 * the `Prng` seeds it, so a decision stays reproducible without hashing for
 * every sample.
 */
function fastRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Strategy = (seat: number, match: Match) => Move;

const opponentsOf = (seat: number, match: Match): number[] => match.alive.filter((other) => other !== seat);

/**
 * Plays `action` whenever it is legal. Guard and Charge cannot be repeated,
 * so on the rounds they are not, it strikes the lowest-indexed opponent.
 */
export function always(action: ActionValue): Strategy {
  return (seat, match) => {
    const target = opponentsOf(seat, match)[0] ?? seat;
    if (action !== Action.Strike && isLegalAction(action, match.playerState(seat))) return { action, target: 0 };
    return { action: Action.Strike, target };
  };
}

/** A uniformly random legal action, striking a random opponent. */
export function randomStrategy(prng: Prng): Strategy {
  return (seat, match) => {
    const opponents = opponentsOf(seat, match);
    const action = prng.pick(legalActions(match.playerState(seat)));
    if (action !== Action.Strike) return { action, target: 0 };
    return { action, target: opponents.length > 0 ? prng.pick(opponents) : seat };
  };
}

/**
 * Uses the public history the way a casual human would after a few rounds:
 * guard after being hit, punish whoever the table keeps striking, otherwise
 * play at random.
 */
export function readerStrategy(prng: Prng): Strategy {
  return (seat, match) => {
    const opponents = opponentsOf(seat, match);
    const state = match.playerState(seat);
    const last = match.history[match.history.length - 1];
    if (last && opponents.length > 0) {
      const incoming = last.strikes.filter((strike) => strike.target === seat);
      if (incoming.length > 0 && isLegalAction(Action.Guard, state) && prng.next(10) < 6) {
        return { action: Action.Guard, target: 0 };
      }
      if (state.charged) return { action: Action.Strike, target: prng.pick(opponents) };

      const hunted = new Map<number, number>();
      for (const round of match.history) {
        for (const move of round.moves) {
          if (move.action !== Action.Strike || move.index === seat) continue;
          hunted.set(move.target, (hunted.get(move.target) ?? 0) + 1);
        }
      }
      const prey = [...hunted.entries()].sort((a, b) => b[1] - a[1])[0];
      if (prey && prey[1] >= 2 && opponents.includes(prey[0]) && prng.next(10) < 5) {
        return { action: Action.Strike, target: prey[0] };
      }
    }
    return randomStrategy(prng)(seat, match);
  };
}

/** Out of ten moves, how many a bot at each difficulty plays at random instead of reading the table. */
const BLUNDERS: Record<BotDifficulty, number> = { easy: 6, normal: 3, hard: 0 };

// Tuned in the design lab against every mindless and rule-based strategy it
// could find; see the notes on `smartStrategy`.
/** How much an HP dealt counts against an HP taken, before sharing it across rivals. */
const DEALT_WEIGHT = 0.75;
/** What finishing a rival is worth, in HP, on top of the damage itself. */
const KILL_VALUE = 50;
/** What dying is worth, in HP, below the overkill itself. */
const DEATH_COST = 60;
/** How much of a loaded Charge's bonus the bot expects to cash in later. */
const CHARGE_FOLLOW_THROUGH = 0.6;
/** Plausible rounds sampled per decision. */
const SAMPLES = 8;

/** What one opponent is likely to do this round, guessed from its revealed moves. */
interface Read {
  /** Actions it may legally take this round, with their likelihood. */
  actions: ActionValue[];
  odds: number[];
  /** Chance a Strike from it is aimed at the seat doing the reading. */
  atMe: number;
}

/**
 * The house bot. Every round it reads each opponent's habits and cooldowns from
 * the public history, samples a handful of plausible rounds, plays each of its
 * own legal moves against the same samples with the real rules, and picks the
 * move whose outcome — HP kept, HP dealt shared across rivals, kills — is best
 * on average. Lower difficulties blunder into a random move some of the time.
 *
 * The rules arithmetic in `outcome` mirrors the kernel without the round
 * entropy: it is an estimate for choosing a move, never a result.
 */
export function smartStrategy(prng: Prng, difficulty: BotDifficulty): Strategy {
  const blunder = randomStrategy(prng);

  return (seat, match) => {
    if (prng.next(10) < BLUNDERS[difficulty]) return blunder(seat, match);

    const opponents = opponentsOf(seat, match);
    if (opponents.length === 0) return { action: Action.Strike, target: seat };
    const random = fastRandom(prng.next(2 ** 31));
    const { rules } = match;
    const states = new Map(match.alive.map((other) => [other, match.playerState(other)]));
    const me = states.get(seat) as PlayerState;

    const reads = new Map(opponents.map((other) => [other, read(match, other, seat, states.get(other) as PlayerState)]));
    const samples = Array.from({ length: SAMPLES }, () => {
      const moves = new Map<number, Move>();
      for (const other of opponents) {
        const r = reads.get(other) as Read;
        let roll = random(), i = 0;
        while (i < r.odds.length - 1 && roll >= (r.odds[i] as number)) { roll -= r.odds[i] as number; i++; }
        const action = r.actions[i] as ActionValue;
        let target = 0;
        if (action === Action.Strike) {
          const rest = match.alive.filter((x) => x !== other && x !== seat);
          target = random() < r.atMe || rest.length === 0 ? seat : (rest[Math.floor(random() * rest.length)] as number);
        }
        moves.set(other, { action, target });
      }
      return { moves, seed: Math.floor(random() * 2 ** 31) };
    });

    const options: Move[] = [];
    for (const action of legalActions(me)) {
      if (action === Action.Strike) for (const target of opponents) options.push({ action, target });
      else options.push({ action, target: 0 });
    }

    // Damage dealt to one rival only helps against that rival, so it counts
    // for less the more rivals are left. Taking damage always counts in full.
    const weight = DEALT_WEIGHT / opponents.length;
    const chargeValue =
      rules.chargeBonusDamage * (weight + rules.strikeHealBps / 10_000) * CHARGE_FOLLOW_THROUGH;

    let best = options[0] as Move;
    let bestScore = -Infinity;
    for (const option of options) {
      let score = 0;
      for (const sample of samples) {
        sample.moves.set(seat, option);
        const after = outcome(rules, states, sample.moves, fastRandom(sample.seed));
        const mine = after.get(seat) as number;
        let value = mine <= 0 ? mine - DEATH_COST : mine;
        for (const other of opponents) {
          const hp = after.get(other) as number;
          value -= weight * Math.max(0, hp) - (hp <= 0 ? KILL_VALUE * weight : 0);
        }
        score += value;
      }
      score /= samples.length;
      if (option.action === Action.Charge) score += chargeValue;
      if (score > bestScore) {
        best = option;
        bestScore = score;
      }
    }
    return best;
  };
}

/** Raw HP after one round of `moves`, by the rules, with Guard picks drawn from `random`. */
function outcome(
  rules: Rules,
  states: ReadonlyMap<number, PlayerState>,
  moves: ReadonlyMap<number, Move>,
  random: () => number,
): Map<number, number> {
  const incoming = new Map<number, number>();
  const healing = new Map<number, number>();
  const add = (map: Map<number, number>, seat: number, value: number) => map.set(seat, (map.get(seat) ?? 0) + value);
  const strikersAt = new Map<number, number[]>();
  for (const [seat, move] of moves) {
    if (move.action === Action.Strike && move.target !== seat && states.has(move.target)) {
      strikersAt.set(move.target, [...(strikersAt.get(move.target) ?? []), seat]);
    }
  }
  let landed = false;
  for (const [target, strikers] of strikersAt) {
    const response = moves.get(target)?.action;
    const blocked = response === Action.Guard ? strikers[Math.floor(random() * strikers.length)] : undefined;
    for (const striker of strikers) {
      if (striker === blocked) {
        add(incoming, striker, rules.guardReflectDamage);
        landed = true;
        continue;
      }
      const base = strikeDamageFor(rules, (states.get(striker) as PlayerState).charged);
      const damage = response === Action.Charge ? exposedDamage(rules, base) : base;
      add(incoming, target, damage);
      add(healing, striker, strikeHeal(rules, damage));
      landed = true;
    }
  }
  // Bots do not track the quiet streak; a round with no hit is priced as the
  // first one that would draw the stall penalty.
  const stall = landed ? 0 : stallDamageFor(rules, rules.stallGraceRounds);
  const after = new Map<number, number>();
  for (const [seat, state] of states) {
    after.set(seat, Math.min(rules.startingHp, state.hp - (incoming.get(seat) ?? 0) + (healing.get(seat) ?? 0)) - stall);
  }
  return after;
}

/**
 * Reads one opponent from its revealed moves. Starts from one imaginary move of
 * each kind, so a player with no history reads as a coin flip rather than a
 * certainty, and drops whatever its cooldowns rule out this round.
 */
function read(match: Match, other: number, seat: number, state: PlayerState): Read {
  const counts = new Map<ActionValue, number>([
    [Action.Strike, 1],
    [Action.Guard, 1],
    [Action.Charge, 1],
  ]);
  let strikes = 0;
  let atMe = 0;
  for (const round of match.history) {
    for (const move of round.moves) {
      if (move.index !== other || !move.revealed) continue;
      counts.set(move.action, (counts.get(move.action) ?? 0) + 1);
      if (move.action === Action.Strike) {
        strikes += 1;
        if (move.target === seat) atMe += 1;
      }
    }
  }
  const actions = legalActions(state);
  const total = actions.reduce<number>((sum, action) => sum + (counts.get(action) ?? 0), 0);
  const spread = 1 / (match.alive.length - 1);
  return {
    actions,
    odds: actions.map((action) => (counts.get(action) ?? 0) / total),
    atMe: (atMe + spread) / (strikes + 1),
  };
}
