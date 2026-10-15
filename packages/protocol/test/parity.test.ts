import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { concatHex, encodeAbiParameters, hashDomain, hashTypedData, keccak256, parseAbiParameters, toHex } from 'viem';
import {
  MATCH_ABORT_TYPES,
  matchResultDomain,
  Action,
  DEFAULT_RULES,
  ZERO_SALT,
  chainHistory,
  commitMove,
  deriveMatchId,
  draw,
  drawBps,
  hashRound,
  hashRules,
  historySeed,
  roundSeed,
} from '@lms/protocol';

/** Seat 1 did not reveal, so its salt is zero. Same as `_salts()` in `HashLib.t.sol`. */
const SALTS = [keccak256(toHex('s0')), ZERO_SALT, keccak256(toHex('s2'))];

/**
 * Frozen cross-language vectors.
 *
 * `contracts/test/unit/HashLib.t.sol` asserts the same literals against the
 * Solidity mirror. If one side changes an encoding, exactly one of the two
 * suites fails, which is what makes the drift visible instead of silent.
 */
describe('hash parity with the Solidity mirror', () => {
  it('pins the default rules digest', () => {
    expect(hashRules(DEFAULT_RULES)).toBe(
      '0x51f49b7b1499dec3d067b46387f9a171346327f29942d32497e74e995181c334',
    );
  });

  /**
   * `Deploy.s.sol` reads the rule set it hashes into the config from this
   * file, so it must say exactly what `DEFAULT_RULES` says — same fields, same
   * values — or the chain would accept results only for rules nobody plays.
   */
  it('keeps the deploy script\'s rules file identical to DEFAULT_RULES', () => {
    const file = new URL('../../../contracts/config/rules.json', import.meta.url);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(DEFAULT_RULES);
  });

  it('pins a round seed and the draws taken from it', () => {
    const entropy = roundSeed(keccak256(toHex('seed')), 3, SALTS);
    expect(entropy).toBe('0x7e4cede4cdb60ef627f7567fdd7c76c76994dedca72d33a26b4e24a27ac577e2');
    expect(drawBps(entropy, 1)).toBe(91);
    expect(draw(entropy, 258)).toBe(0x35488afc3fef29f5171659d3e19c131674225566a149e03f8284036d4406df15n);
  });

  it('pins a round hash, salts included', () => {
    const record = {
      round: 3,
      moves: [
        { index: 0, action: Action.Attack, target: 2, revealed: true, salt: SALTS[0] as `0x${string}` },
        { index: 1, action: Action.None, target: 0, revealed: false, salt: ZERO_SALT },
        { index: 2, action: Action.Defend, target: 0, revealed: true, salt: SALTS[2] as `0x${string}` },
      ],
      attacks: [],
      stormDamage: 12,
      eliminated: [1],
      hpAfter: [95, 0, 66],
    };
    expect(hashRound(3, 3, record)).toBe(
      '0xf7eedecb9cbe6f45b5073a84a3ccd9768a9b16d1181979c49ae825f749ae94c4',
    );
  });

  it('changes the round seed when any one salt changes', () => {
    const seed = keccak256(toHex('seed'));
    const base = roundSeed(seed, 3, SALTS);
    SALTS.forEach((_, seat) => {
      const changed = [...SALTS];
      changed[seat] = keccak256(toHex(`other:${seat}`));
      expect(roundSeed(seed, 3, changed)).not.toBe(base);
    });
  });

  it('pins a commitment preimage', () => {
    const commitment = commitMove(keccak256(toHex('match')), 3, 2, {
      action: Action.Attack,
      target: 5,
      salt: keccak256(toHex('salt')),
    });
    expect(commitment).toBe(
      '0xfdceee9c106ff31a867d56723ef84165171e63afe5797667d11127ede92df028',
    );
  });

  it('ignores the target of a non-attack move', () => {
    const salt = keccak256(toHex('salt'));
    const matchId = keccak256(toHex('match'));
    const hidden = commitMove(matchId, 1, 0, { action: Action.Hide, target: 7, salt });
    const zeroed = commitMove(matchId, 1, 0, { action: Action.Hide, target: 0, salt });
    expect(hidden).toBe(zeroed);
  });

  it('derives match ids the way the escrow does', () => {
    expect(deriveMatchId(11155111, '0x0000000000000000000000000000000000000abc', 0n)).toBe(
      keccak256(
        '0x0000000000000000000000000000000000000000000000000000000000aa36a70000000000000000000000000000000000000000000000000000000000000abc0000000000000000000000000000000000000000000000000000000000000000',
      ),
    );
  });

  it('chains history in an order-sensitive way', () => {
    const seed = historySeed(keccak256(toHex('m')), keccak256(toHex('r')), keccak256(toHex('s')));
    const a = keccak256(toHex('round-a'));
    const b = keccak256(toHex('round-b'));
    expect(chainHistory(chainHistory(seed, a), b)).not.toBe(chainHistory(chainHistory(seed, b), a));
  });

  it('keeps draws inside the basis-point range and reproducible', () => {
    for (let round = 1; round <= 30; round += 1) {
      const entropy = roundSeed(keccak256(toHex('seed')), round, SALTS);
      for (let nonce = 0; nonce < 8; nonce += 1) {
        const roll = drawBps(entropy, nonce);
        expect(roll).toBeGreaterThanOrEqual(0);
        expect(roll).toBeLessThan(10_000);
        expect(drawBps(entropy, nonce)).toBe(roll);
      }
    }
  });
});

describe('abort typed data', () => {
  /**
   * `GameEscrow.abortMatch` hashes `keccak256(abi.encode(keccak256("MatchAbort(bytes32 matchId)"), matchId))`
   * under the escrow's domain. Rebuilding that by hand and comparing it with
   * what viem signs pins the type string on both sides: a typo in either would
   * make every abort the server sends recover to a stranger.
   */
  it('matches the digest the escrow verifies', () => {
    const matchId = keccak256(toHex('aborted'));
    const domain = matchResultDomain(31337, '0x00000000000000000000000000000000000000e5');
    const structHash = keccak256(
      encodeAbiParameters(parseAbiParameters('bytes32 typeHash, bytes32 matchId'), [
        keccak256(toHex('MatchAbort(bytes32 matchId)')),
        matchId,
      ]),
    );
    const domainSeparator = hashDomain({
      domain: {
        name: 'LastManStanding',
        version: '1',
        chainId: 31337n,
        verifyingContract: '0x00000000000000000000000000000000000000e5',
      },
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
      },
    });
    const expected = keccak256(concatHex(['0x1901', domainSeparator, structHash]));
    expect(hashTypedData({ domain, types: MATCH_ABORT_TYPES, primaryType: 'MatchAbort', message: { matchId } })).toBe(
      expected,
    );
  });
});
