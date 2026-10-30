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
  commitmentSetHash,
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
/** Seat 1 committed and did not reveal. Same as `_commitments()` in `HashLib.t.sol`. */
const COMMITMENTS = [keccak256(toHex('c0')), keccak256(toHex('c1')), keccak256(toHex('c2'))];

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
      '0x07d102f371d483468baf28515199dc3b888d3604c16f48ae909ab07145044d93',
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

  it('pins a commitment set, a round seed and the draws taken from it', () => {
    const set = commitmentSetHash(COMMITMENTS);
    expect(set).toBe('0xf18d89b73a8eed2ced885c9152e679820bf8917ea67e7c46a681c6abe5573adc');
    const entropy = roundSeed(keccak256(toHex('seed')), 3, set);
    expect(entropy).toBe('0x4d667135737ff4ad6b8b379f133a58cbc0bcca5690cfbb05e8015750afc1ad98');
    expect(drawBps(entropy, 1)).toBe(4023);
    expect(draw(entropy, 258)).toBe(0xe2504df953442fd406f6996306c6bcd20bea346d70650cee4541d118af9a7e57n);
  });

  it('pins a round hash, salts and commitments included', () => {
    const record = {
      round: 3,
      moves: [
        { index: 0, action: Action.Strike, target: 2, revealed: true, salt: SALTS[0] as `0x${string}`, commitment: COMMITMENTS[0] as `0x${string}` },
        { index: 1, action: Action.None, target: 0, revealed: false, salt: ZERO_SALT, commitment: COMMITMENTS[1] as `0x${string}` },
        { index: 2, action: Action.Guard, target: 0, revealed: true, salt: SALTS[2] as `0x${string}`, commitment: COMMITMENTS[2] as `0x${string}` },
      ],
      strikes: [],
      stallDamage: 12,
      eliminated: [1],
      hpAfter: [95, 0, 66],
    };
    expect(hashRound(3, 3, record)).toBe(
      '0xf0e024d960c9b3f12a0464761e7f50f2cec8ec60ccd49e62ccc83acd1829a3a3',
    );
  });

  it('changes the round seed when any one commitment changes', () => {
    const seed = keccak256(toHex('seed'));
    const base = roundSeed(seed, 3, commitmentSetHash(COMMITMENTS));
    COMMITMENTS.forEach((_, seat) => {
      const changed = [...COMMITMENTS];
      changed[seat] = keccak256(toHex(`other:${seat}`));
      expect(roundSeed(seed, 3, commitmentSetHash(changed))).not.toBe(base);
    });
  });

  it('pins a commitment preimage', () => {
    const commitment = commitMove(keccak256(toHex('match')), 3, 2, {
      action: Action.Strike,
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
    const hidden = commitMove(matchId, 1, 0, { action: Action.Charge, target: 7, salt });
    const zeroed = commitMove(matchId, 1, 0, { action: Action.Charge, target: 0, salt });
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
      const entropy = roundSeed(keccak256(toHex('seed')), round, commitmentSetHash(COMMITMENTS));
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
