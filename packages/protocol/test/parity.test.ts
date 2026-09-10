import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import {
  Action,
  DEFAULT_RULES,
  chainHistory,
  commitMove,
  deriveMatchId,
  drawBps,
  hashRules,
  historySeed,
} from '@lms/protocol';

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
      '0xecd9fc8f0491a1bdbb67dec6eb01afb553aab4aed819d2dc3ce9531b63188dcf',
    );
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
    const seed = keccak256(toHex('seed'));
    for (let round = 1; round <= 30; round += 1) {
      for (let nonce = 0; nonce < 8; nonce += 1) {
        const roll = drawBps(seed, round, nonce);
        expect(roll).toBeGreaterThanOrEqual(0);
        expect(roll).toBeLessThan(10_000);
        expect(drawBps(seed, round, nonce)).toBe(roll);
      }
    }
  });
});
