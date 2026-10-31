import { keccak256, toHex } from 'viem';
import {
  Action,
  commitMove,
  DEFAULT_RULES,
  type Move,
  type PlayerState,
  type Rules,
  type Seat,
  ZERO_SALT,
} from '@lms/consensus';
import { Match, type MatchSetup } from '@lms/engine';
import type { Strategy } from '@lms/engine/bots';
import type { DeclaredMove } from '@lms/engine';

export { Prng, always, randomStrategy, readerStrategy, smartStrategy, type Strategy } from '@lms/engine/bots';

/** Deterministic stand-in wallet addresses, one per seat. */
export function seatsFor(count: number, chainIds: number[] = [11155111]): Seat[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    address: `0x${(index + 1).toString(16).padStart(40, '0')}` as `0x${string}`,
    chainId: chainIds[index % chainIds.length] as number,
  }));
}

export function bytes32(label: string): `0x${string}` {
  return keccak256(toHex(label));
}

/** Every seat alive on full HP, the state a match starts from. */
export function freshStates(count: number, hp = DEFAULT_RULES.startingHp): PlayerState[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    hp,
    alive: true,
    eliminatedInRound: 0,
    timeouts: 0,
    charged: false,
    lastAction: Action.None,
  }));
}

export function setupFor(
  players: number,
  seedLabel = 'seed',
  rules: Rules = DEFAULT_RULES,
): MatchSetup {
  return {
    matchId: bytes32(`match:${players}:${seedLabel}`),
    seats: seatsFor(players),
    seed: bytes32(`seed:${seedLabel}`),
    rules,
  };
}

export interface PlayedMatch {
  match: Match;
  moveLog: DeclaredMove[][];
}

export function playMatch(
  setup: MatchSetup,
  strategy: Strategy,
  silentSeats: ReadonlySet<number> = new Set(),
): PlayedMatch {
  const match = new Match(setup);
  const moveLog: DeclaredMove[][] = [];

  while (!match.finished) {
    const round = match.round;
    const living = match.alive;
    const chosen = new Map<number, Move>();

    const commitments = new Map<number, `0x${string}`>();
    for (const seat of living) {
      const move = strategy(seat, match);
      chosen.set(seat, move);
      const salt = bytes32(`salt:${setup.matchId}:${round}:${seat}`);
      const commitment = commitMove(setup.matchId, round, seat, { ...move, salt });
      commitments.set(seat, commitment);
      match.submitCommit(seat, commitment);
    }

    match.openRevealPhase();

    const revealedMoves: DeclaredMove[] = [];
    for (const seat of living) {
      const move = chosen.get(seat) as Move;
      if (silentSeats.has(seat)) {
        revealedMoves.push({
          index: seat,
          action: Action.None,
          target: 0,
          revealed: false,
          salt: ZERO_SALT,
          commitment: commitments.get(seat) as `0x${string}`,
        });
        continue;
      }
      const salt = bytes32(`salt:${setup.matchId}:${round}:${seat}`);
      match.submitReveal(seat, { ...move, salt });
      revealedMoves.push({
        index: seat,
        action: move.action,
        target: move.action === Action.Strike ? move.target : 0,
        revealed: true,
        salt,
        commitment: commitments.get(seat) as `0x${string}`,
      });
    }

    moveLog.push(revealedMoves);
    match.resolve();
  }

  return { match, moveLog };
}
