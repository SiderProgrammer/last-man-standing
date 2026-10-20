import { encodeAbiParameters, keccak256, parseAbiParameters } from 'viem';
import {
  Action,
  BPS_DENOMINATOR,
  stormDamageForRound,
  type ActionValue,
  type BotDifficulty,
  type Move,
} from '@lms/protocol';
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

export type Strategy = (seat: number, match: Match) => Move;

/** Always plays the same action; attacks the lowest-indexed living opponent. */
export function always(action: ActionValue): Strategy {
  return (seat, match) => {
    if (action !== Action.Attack) return { action, target: 0 };
    const target = match.alive.find((other) => other !== seat) ?? seat;
    return { action, target };
  };
}

export function randomStrategy(prng: Prng): Strategy {
  return (seat, match) => {
    const opponents = match.alive.filter((other) => other !== seat);
    const action = prng.pick([Action.Attack, Action.Defend, Action.Hide] as const);
    if (action !== Action.Attack || opponents.length === 0) {
      return { action: action === Action.Attack ? Action.Hide : action, target: 0 };
    }
    return { action, target: prng.pick(opponents) };
  };
}

/**
 * Uses the public history the way a human would after a few rounds:
 * punish players who keep attacking the same seat, and respect a defender.
 */
export function readerStrategy(prng: Prng): Strategy {
  return (seat, match) => {
    const opponents = match.alive.filter((other) => other !== seat);
    if (opponents.length === 0) return { action: Action.Hide, target: 0 };

    const last = match.history[match.history.length - 1];
    if (last) {
      const incoming = last.attacks.filter((attack) => attack.target === seat);
      if (incoming.length > 0 && prng.next(10) < 6) {
        return { action: Action.Defend, target: 0 };
      }

      const hunters = new Map<number, number>();
      for (const round of match.history) {
        for (const move of round.moves) {
          if (move.action !== Action.Attack || move.index === seat) continue;
          hunters.set(move.target, (hunters.get(move.target) ?? 0) + 1);
        }
      }
      const hunted = [...hunters.entries()].sort((a, b) => b[1] - a[1])[0];
      if (hunted && hunted[1] >= 2 && opponents.includes(hunted[0]) && prng.next(10) < 5) {
        return { action: Action.Attack, target: hunted[0] };
      }
    }

    return randomStrategy(prng)(seat, match);
  };
}

/** Out of ten moves, how many a bot at each difficulty plays at random instead of reading the table. */
const BLUNDERS: Record<BotDifficulty, number> = { easy: 6, normal: 3, hard: 0 };

// Tuned with `npm run sim`: any more appetite for damage and the bot loses to
// always-defend; any less and it stops finishing players off.
/** How much an HP dealt counts against an HP taken, before sharing it across rivals. */
const DEALT_WEIGHT = 0.75;
/** What finishing a rival is worth, in HP, on top of the damage itself. */
const KILL_VALUE = 50;

/** What one opponent is likely to do this round, guessed from its revealed moves. */
interface Read {
  attack: number;
  defend: number;
  hide: number;
  /** Chance it attacks the seat doing the reading. */
  atMe: number;
}

/**
 * The house bot. Every round it prices each move against the rules — how much
 * HP it is expected to lose, how much it deals, whether a hit would finish
 * someone — and plays the best one. Lower difficulties blunder into a random
 * move some of the time.
 */
export function smartStrategy(prng: Prng, difficulty: BotDifficulty): Strategy {
  const blunder = randomStrategy(prng);

  return (seat, match) => {
    if (prng.next(10) < BLUNDERS[difficulty]) return blunder(seat, match);

    const opponents = match.alive.filter((other) => other !== seat);
    if (opponents.length === 0) return { action: Action.Hide, target: 0 };

    const { rules } = match;
    const storm = stormDamageForRound(rules, match.round);
    const hiddenStorm = Math.floor((storm * rules.hideStormBps) / BPS_DENOMINATOR);
    const evade = rules.hideEvadeBps / BPS_DENOMINATOR;

    const reads = new Map(opponents.map((other) => [other, read(match, other, seat)]));
    const incoming = [...reads.values()].map((r) => r.attack * r.atMe);
    const expectedAttackers = incoming.reduce((sum, p) => sum + p, 0);
    const anyAttacker = 1 - incoming.reduce((none, p) => none * (1 - p), 1);

    // Damage dealt to one rival only helps against that rival, so it counts
    // for less the more rivals are left. Taking damage always counts in full.
    const dealtWeight = DEALT_WEIGHT / opponents.length;

    let best: Move = { action: Action.Hide, target: 0 };
    let bestScore = -(expectedAttackers * rules.attackDamage * (1 - evade) + hiddenStorm);

    // A defender parries one attacker and ripostes it; the rest still hit.
    const defendScore =
      -((expectedAttackers - anyAttacker) * rules.attackDamage + storm) +
      anyAttacker * rules.riposteDamage * dealtWeight;
    if (defendScore > bestScore) {
      best = { action: Action.Defend, target: 0 };
      bestScore = defendScore;
    }

    const attackCost = expectedAttackers * rules.attackDamage + storm;
    for (const target of opponents) {
      const r = reads.get(target) as Read;
      // A defender parries us; a hider sometimes evades.
      const hit = r.attack + r.hide * (1 - evade);
      const kills = match.playerState(target).hp <= rules.attackDamage + hiddenStorm;
      const score =
        -attackCost -
        r.defend * rules.riposteDamage +
        hit * rules.attackDamage * dealtWeight +
        (kills ? hit * KILL_VALUE * dealtWeight : 0);
      if (score > bestScore) {
        best = { action: Action.Attack, target };
        bestScore = score;
      }
    }
    return best;
  };
}

/**
 * Reads one opponent from its revealed moves. Starts from one imaginary move of
 * each kind, so a player with no history reads as a coin flip rather than a
 * certainty.
 */
function read(match: Match, other: number, seat: number): Read {
  const counts = { attack: 1, defend: 1, hide: 1 };
  let attacks = 0;
  let atMe = 0;
  for (const round of match.history) {
    for (const move of round.moves) {
      if (move.index !== other || !move.revealed) continue;
      if (move.action === Action.Attack) {
        counts.attack += 1;
        attacks += 1;
        if (move.target === seat) atMe += 1;
      } else if (move.action === Action.Defend) {
        counts.defend += 1;
      } else if (move.action === Action.Hide) {
        counts.hide += 1;
      }
    }
  }
  const total = counts.attack + counts.defend + counts.hide;
  const spread = 1 / (match.alive.length - 1);
  return {
    attack: counts.attack / total,
    defend: counts.defend / total,
    hide: counts.hide / total,
    atMe: (atMe + spread) / (attacks + 1),
  };
}
