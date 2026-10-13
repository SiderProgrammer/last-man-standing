import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, parseAbiParameters } from 'viem';
import { Action, DEFAULT_RULES, encodeRoundLog, roundPreimage, type Rules } from '@lms/protocol';
import { always, Prng, randomStrategy, readerStrategy, aggressorStrategy, type Strategy } from '@lms/engine';
import { bytes32, playMatch, setupFor } from './helpers.js';

/**
 * Cross-language vectors for the fraud proof.
 *
 * Each case is a whole match played by the TypeScript engine, ABI-encoded the
 * way `MatchVerifier.verify` takes it. `contracts/test/unit/MatchVerifier.t.sol`
 * replays every one through the Solidity kernel and requires the same rounds,
 * the same ending and the same ranking. If the two kernels ever disagree, an
 * honest result could be "proven" fraudulent — so this file is the contract
 * between them.
 *
 * Regenerate after a deliberate kernel change with `UPDATE_VECTORS=1 npx vitest run vectors`.
 */
const FILE = new URL('../../../contracts/test/vectors/matches.json', import.meta.url);

const CASE_ABI = parseAbiParameters(
  '(uint16 minPlayers,uint16 maxPlayers,uint32 startingHp,uint32 attackDamage,uint32 riposteDamage,uint16 hideEvadeBps,uint16 hideStormBps,uint16 stormGraceRounds,uint32 stormBaseDamage,uint16 maxRounds) rules, bytes32 matchId, bytes32 seed, uint256 seats, bytes32 historyRoot, (uint8[] actions,uint8[] targets,bytes32[] salts,uint32[] hpAfter,uint8[] eliminated)[] rounds, uint8[] ranking',
);

/** Everyone hides and nobody takes storm: the only way a match runs to `maxRounds`. */
const LONG_RULES: Rules = { ...DEFAULT_RULES, hideStormBps: 0, stormBaseDamage: 25, maxRounds: 6 };

interface Spec {
  label: string;
  seats: number;
  strategy: (prng: Prng) => Strategy;
  silent?: number[];
  rules?: Rules;
}

const SPECS: Spec[] = [
  { label: 'random-4', seats: 4, strategy: randomStrategy },
  { label: 'random-6', seats: 6, strategy: randomStrategy },
  { label: 'random-8', seats: 8, strategy: randomStrategy },
  { label: 'reader-5', seats: 5, strategy: readerStrategy },
  { label: 'reader-7', seats: 7, strategy: readerStrategy },
  // Everyone on one target: parries and focus fire every round.
  { label: 'aggressor-8', seats: 8, strategy: aggressorStrategy },
  { label: 'aggressor-4', seats: 4, strategy: aggressorStrategy },
  // Silent seats: the no-show path, zero salts, full storm.
  { label: 'silent-6', seats: 6, strategy: readerStrategy, silent: [1, 4] },
  { label: 'all-silent-4', seats: 4, strategy: randomStrategy, silent: [0, 1, 2, 3] },
  // Mutual defending until the storm wipes the table: the 1-HP rescue.
  { label: 'turtles-5', seats: 5, strategy: () => always(Action.Defend) },
  // Nobody dies: the match ends on the round cap and ranks by HP.
  { label: 'cap-4', seats: 4, strategy: () => always(Action.Hide), rules: LONG_RULES },
];

function encodeCase(spec: Spec): { data: `0x${string}`; log: `0x${string}` } {
  const setup = setupFor(spec.seats, `vector:${spec.label}`, spec.rules ?? DEFAULT_RULES);
  const { match } = playMatch(
    setup,
    spec.strategy(new Prng(bytes32(`vector-strategy:${spec.label}`))),
    new Set(spec.silent ?? []),
  );
  // `log` is exactly what the relayer passes to `settle`.
  const log = encodeRoundLog(spec.seats, match.history);
  const data = encodeAbiParameters(CASE_ABI, [
    setup.rules,
    setup.matchId,
    setup.seed,
    BigInt(spec.seats),
    match.historyRoot,
    match.history.map((record) => roundPreimage(spec.seats, record)),
    match.ranking(),
  ]);
  return { data, log };
}

describe('fraud-proof vectors', () => {
  it('match the committed file the Solidity verifier replays', () => {
    const generated = { cases: SPECS.map((spec) => ({ label: spec.label, ...encodeCase(spec) })) };
    const text = `${JSON.stringify(generated, null, 2)}\n`;
    if (process.env.UPDATE_VECTORS) writeFileSync(FILE, text);
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(generated);
  });

  it('cover the paths a verifier has to get right', () => {
    const covered = new Set<string>();
    for (const spec of SPECS) {
      const setup = setupFor(spec.seats, `vector:${spec.label}`, spec.rules ?? DEFAULT_RULES);
      const { match } = playMatch(
        setup,
        spec.strategy(new Prng(bytes32(`vector-strategy:${spec.label}`))),
        new Set(spec.silent ?? []),
      );
      for (const record of match.history) {
        for (const attack of record.attacks) covered.add(attack.outcome);
        if (record.moves.some((move) => !move.revealed)) covered.add('silent');
      }
      if (match.history.length === (spec.rules ?? DEFAULT_RULES).maxRounds && match.alive.length > 1) {
        covered.add('cap');
      }
      const last = match.history[match.history.length - 1];
      if (last && last.hpAfter.filter((hp) => hp > 0).length === 1 && last.hpAfter.includes(1)) covered.add('rescue');
    }
    // No 'void': the engine rejects an attack on a dead seat at reveal, so an
    // honest record never has one. The verifier still voids one if it appears.
    expect([...covered].sort()).toEqual(['cap', 'hit', 'missed', 'parried', 'rescue', 'silent'].sort());
  });
});
