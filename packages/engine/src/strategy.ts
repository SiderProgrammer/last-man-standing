import { encodeAbiParameters, keccak256, parseAbiParameters } from 'viem';
import { Action, type ActionValue, type Move } from '@lms/protocol';
import type { Match } from './match.js';

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
