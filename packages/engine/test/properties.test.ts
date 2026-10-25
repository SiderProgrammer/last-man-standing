import { describe, expect, it } from 'vitest';
import { Action, DEFAULT_RULES, MatchPhase } from '@lms/protocol';
import { moveLogFromHistory, replayMatch, verifyResult } from '@lms/engine';
import {
  always,
  bytes32,
  playMatch,
  Prng,
  randomStrategy,
  readerStrategy,
  setupFor,
  smartStrategy,
  type Strategy,
} from './helpers.js';

const TRIALS = 120;

/**
 * These are the properties the settlement layer depends on. If any of them can
 * be broken, a match can reach a state where the escrow has no valid payout.
 */
describe('engine invariants', () => {
  it('always terminates within maxRounds with exactly one winner', () => {
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const players = 4 + (trial % 5);
      const setup = setupFor(players, `terminate-${trial}`);
      const prng = new Prng(bytes32(`strategy-${trial}`));
      const { match } = playMatch(setup, randomStrategy(prng));

      expect(match.phase).toBe(MatchPhase.Finished);
      expect(match.history.length).toBeLessThanOrEqual(DEFAULT_RULES.maxRounds);
      expect(match.alive).toHaveLength(1);
    }
  });

  it('always ranks every seat exactly once', () => {
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const players = 4 + (trial % 5);
      const setup = setupFor(players, `ranking-${trial}`);
      const prng = new Prng(bytes32(`ranking-strategy-${trial}`));
      const { match } = playMatch(setup, randomStrategy(prng));

      const ranking = match.ranking();
      expect(ranking).toHaveLength(players);
      expect(new Set(ranking).size).toBe(players);
      expect([...ranking].sort((a, b) => a - b)).toEqual(
        Array.from({ length: players }, (_, i) => i),
      );

      const addresses = match.result().ranking;
      expect(new Set(addresses.map((a) => a.toLowerCase())).size).toBe(players);
    }
  });

  it('keeps hit points inside [0, startingHp] and only ever removes players', () => {
    for (let trial = 0; trial < 40; trial += 1) {
      const setup = setupFor(6, `hp-${trial}`);
      const prng = new Prng(bytes32(`hp-strategy-${trial}`));
      const { match } = playMatch(setup, randomStrategy(prng));

      let previousAlive = setup.seats.length;
      for (const round of match.history) {
        for (const hp of round.hpAfter) {
          expect(hp).toBeGreaterThanOrEqual(0);
          expect(hp).toBeLessThanOrEqual(DEFAULT_RULES.startingHp);
        }
        const aliveNow = round.hpAfter.filter((hp) => hp > 0).length;
        expect(aliveNow).toBeLessThanOrEqual(previousAlive);
        previousAlive = aliveNow;
      }
    }
  });

  it('produces the same result for the same inputs', () => {
    for (let trial = 0; trial < 30; trial += 1) {
      const setup = setupFor(5, `determinism-${trial}`);
      const first = playMatch(setup, randomStrategy(new Prng(bytes32(`det-${trial}`))));
      const second = playMatch(setup, randomStrategy(new Prng(bytes32(`det-${trial}`))));

      expect(second.match.historyRoot).toBe(first.match.historyRoot);
      expect(second.match.result()).toEqual(first.match.result());
    }
  });

  it('produces a different history root for a different oracle seed', () => {
    const roots = new Set<string>();
    for (let trial = 0; trial < 20; trial += 1) {
      const setup = setupFor(6, `seed-${trial}`);
      const { match } = playMatch(setup, always(Action.Strike));
      roots.add(match.historyRoot);
    }
    expect(roots.size).toBe(20);
  });

  // `replay.ts` deliberately re-derives the initial state, the per-round fold
  // and the ranking rather than sharing them with `Match` — that independence
  // is what makes `verifyResult` an audit rather than a tautology. This test is
  // what pays for the duplication, so it covers every strategy: `reader`
  // concentrates fire and eliminates seats in a different order to `random`,
  // and the house bot mixes all three actions around their cooldowns.
  it('lets an independent replay reproduce the signed result', () => {
    for (let trial = 0; trial < 45; trial += 1) {
      const setup = setupFor(4 + (trial % 5), `replay-${trial}`);
      const prng = new Prng(bytes32(`replay-strategy-${trial}`));
      const strategies = [randomStrategy(prng), readerStrategy(prng), smartStrategy(prng, 'hard')];
      const strategy = strategies[trial % strategies.length] as Strategy;
      const { match, moveLog } = playMatch(setup, strategy);

      const replayed = replayMatch(setup, moveLog);
      expect(replayed.result).toEqual(match.result());
      expect(replayed.rounds.map((round) => round.hash)).toEqual(
        match.history.map((round) => round.hash),
      );
      expect(verifyResult(setup, moveLog, match.result())).toBe(true);
    }
  });

  it('reproduces a result for a match where seats went silent', () => {
    // No-shows take a different path through `resolveRound` (Action.None), and
    // the move log records them as unrevealed — the replay has to agree there
    // too, or a timing-out lobby could not be audited.
    const setup = setupFor(6, 'replay-silent');
    const prng = new Prng(bytes32('replay-silent'));
    const { match, moveLog } = playMatch(setup, randomStrategy(prng), new Set([1, 4]));

    expect(replayMatch(setup, moveLog).result).toEqual(match.result());
    expect(verifyResult(setup, moveLog, match.result())).toBe(true);
  });

  it('replays from nothing but the published history', () => {
    const setup = setupFor(5, 'from-history');
    const { match } = playMatch(setup, readerStrategy(new Prng(bytes32('from-history'))), new Set([2]));
    expect(verifyResult(setup, moveLogFromHistory(match.history), match.result())).toBe(true);
  });

  it('rejects a replay whose salts were swapped', () => {
    // Salts decide the rolls, so a history that keeps every move but changes
    // one salt is a different match and must not verify.
    const setup = setupFor(4, 'salt-tamper');
    const { match, moveLog } = playMatch(setup, randomStrategy(new Prng(bytes32('salt-tamper'))));
    const tampered = moveLog.map((round) => round.map((move) => ({ ...move })));
    (tampered[0]?.[0] as { salt: `0x${string}` }).salt = bytes32('forged');
    expect(verifyResult(setup, tampered, match.result())).toBe(false);
  });

  it('rejects a replay whose move log was tampered with', () => {
    const setup = setupFor(6, 'tamper');
    const { match, moveLog } = playMatch(setup, randomStrategy(new Prng(bytes32('tamper'))));

    const tampered = moveLog.map((round) => round.map((move) => ({ ...move })));
    const victim = tampered[0]?.find((move) => move.action !== Action.Guard);
    expect(victim).toBeDefined();
    (victim as { action: number }).action = Action.Guard;

    expect(verifyResult(setup, tampered, match.result())).toBe(false);
  });

  it('survives a lobby where nobody ever reveals', () => {
    const setup = setupFor(8, 'all-silent');
    const silent = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
    const { match } = playMatch(setup, always(Action.Charge), silent);

    expect(match.finished).toBe(true);
    expect(match.alive).toHaveLength(1);
    // Nobody struck, so the stall penalty grew every round until the lobby collapsed.
    for (const seat of [0, 1, 2, 3, 4, 5, 6, 7]) {
      expect(match.playerState(seat).timeouts).toBeGreaterThan(0);
    }
  });
});
