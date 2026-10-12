import { describe, expect, it } from 'vitest';
import { toHex } from 'viem';
import { SESSION_SCOPE } from '../src/wallet/wallet.js';
import { centreOf, seatPosition, seatRingRadius, stormRing } from '../src/arena/layout.js';
import { COLORS, hpColor } from '../src/arena/theme.js';

describe('session scope', () => {
  /**
   * These three selectors are what a session key is allowed to call. They are
   * derived from the ABIs rather than from hand-written signature strings, so
   * these expectations pin the values that derivation must keep producing: a
   * change here would silently widen or narrow what a granted key can do.
   */
  it('scopes the escrow to join only', () => {
    expect(SESSION_SCOPE.escrow).toEqual(['0xad677d0b']);
  });

  /**
   * `withdraw(address)` is `0x51cff8d9`. A key holding it could send the
   * account's whole escrow balance to any address, and the spend cap would
   * never notice, because the value leaves the escrow and not the account.
   */
  it('never grants a payout selector', () => {
    expect(SESSION_SCOPE.escrow).not.toContain('0x51cff8d9');
  });

  it('scopes the avatar collection to mint and equip', () => {
    expect(SESSION_SCOPE.avatars).toEqual(['0x1249c58b', '0xb85f8027']);
  });

  it('grants nothing else', () => {
    expect(SESSION_SCOPE.escrow.length + SESSION_SCOPE.avatars.length).toBe(3);
  });
});

describe('salt encoding', () => {
  /**
   * `freshSalt` uses viem's `toHex` rather than a hand-rolled loop. The format
   * is load-bearing: a salt that encodes differently after a refresh cannot
   * open the commitment it was sealed with, and the player is scored a
   * no-show. This pins byte-for-byte equality with the original encoding.
   */
  it('matches the hand-rolled lowercase encoding exactly', () => {
    for (const fill of [0x00, 0x0f, 0xab, 0xff]) {
      const bytes = new Uint8Array(32).fill(fill);
      const manual = `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      expect(toHex(bytes)).toBe(manual);
    }
  });

  it('produces a 32-byte hex string', () => {
    expect(toHex(new Uint8Array(32))).toHaveLength(66);
  });
});

describe('arena layout', () => {
  it('centres on the canvas', () => {
    expect(centreOf(800, 600)).toEqual({ x: 400, y: 300 });
  });

  it('pulls the seat ring in when avatars need room below each seat', () => {
    expect(seatRingRadius(800, 600, false)).toBe(230);
    expect(seatRingRadius(800, 600, true)).toBe(208);
  });

  it('puts the first seat at the top and runs clockwise', () => {
    const top = seatPosition(0, 4, 800, 600, false);
    expect(top.x).toBeCloseTo(400);
    expect(top.y).toBeCloseTo(70);

    const right = seatPosition(1, 4, 800, 600, false);
    expect(right.x).toBeCloseTo(630);
    expect(right.y).toBeCloseTo(300);
  });

  it('survives a lobby with no players rather than dividing by zero', () => {
    const { x, y } = seatPosition(0, 0, 800, 600, false);
    expect(x).toBeCloseTo(400);
    expect(y).toBeCloseTo(70);
  });

  it('tightens the storm ring as the round number climbs', () => {
    const early = stormRing(800, 600, 1);
    const late = stormRing(800, 600, 12);

    expect(early.intensity).toBeCloseTo(1 / 12);
    expect(late.intensity).toBe(1);
    expect(late.radius).toBeLessThan(early.radius);
  });

  it('caps the storm at full intensity', () => {
    expect(stormRing(800, 600, 50).intensity).toBe(1);
  });
});

describe('arena theme', () => {
  it('picks the HP colour by remaining fraction', () => {
    expect(hpColor(1)).toBe(COLORS.hp);
    expect(hpColor(0.4)).toBe(COLORS.hpLow);
    expect(hpColor(0.1)).toBe(COLORS.hpCritical);
  });
});
