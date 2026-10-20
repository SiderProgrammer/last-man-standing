import { encodeAbiParameters, keccak256, parseAbiParameters } from 'viem';
import { Action, DEFAULT_RULES, commitMove, type Move, type Rules, type Seat } from '@lms/protocol';
import {
  Match,
  Prng,
  aggressorStrategy,
  always,
  randomStrategy,
  readerStrategy,
  smartStrategy,
  type Strategy,
  type StrategyName,
} from '@lms/engine';
import type { ArchivedMatch } from '../lobby/store.js';

/**
 * Reference matches: real games, played by the engine's seeded bots, whose
 * every fact is known in advance because the same label always plays the
 * same match.
 *
 * Unit tests use them as realistic fixtures for the analyst and the claim
 * verifier — no hand-written history that the engine could never have
 * produced.
 */
export interface ReferenceMatch extends ArchivedMatch {
  /** The strategy each seat played, by seat index. */
  strategies: StrategyName[];
}

const LABEL_ABI = parseAbiParameters('string label');
const label = (text: string): `0x${string}` => keccak256(encodeAbiParameters(LABEL_ABI, [text]));

export function playReferenceMatch(options: {
  label: string;
  strategies: readonly StrategyName[];
  rules?: Rules;
}): ReferenceMatch {
  const rules = options.rules ?? DEFAULT_RULES;
  const base = `analyst-ref:${options.label}`;
  const seats: Seat[] = options.strategies.map((_, index) => ({
    index,
    address: `0x${label(`${base}:seat:${index}`).slice(2, 42)}` as `0x${string}`,
    chainId: 0,
  }));
  const match = new Match({ matchId: label(`${base}:id`), seats, seed: label(`${base}:seed`), rules });
  const players = options.strategies.map((name, seat) => strategyFor(name, new Prng(label(`${base}:${seat}`))));

  while (!match.finished) {
    const round = match.round;
    const living = match.alive;
    const chosen = new Map<number, Move & { salt: `0x${string}` }>();
    for (const seat of living) {
      const move = (players[seat] as Strategy)(seat, match);
      const sealed = { ...move, salt: label(`${base}:salt:${round}:${seat}`) };
      chosen.set(seat, sealed);
      match.submitCommit(seat, commitMove(match.matchId, round, seat, sealed));
    }
    match.openRevealPhase();
    for (const seat of living) match.submitReveal(seat, chosen.get(seat) as Move & { salt: `0x${string}` });
    match.resolve();
  }

  return {
    result: match.result(),
    history: [...match.history],
    settledTx: null,
    seats,
    rules,
    strategies: [...options.strategies],
  };
}

function strategyFor(name: StrategyName, prng: Prng): Strategy {
  switch (name) {
    case 'turtle':
      return always(Action.Defend);
    case 'hider':
      return always(Action.Hide);
    case 'aggressor':
      return aggressorStrategy(prng);
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
