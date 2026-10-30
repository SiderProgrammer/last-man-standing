import { describe, expect, it } from 'vitest';
import { toHex } from 'viem';
import { ONE_CLICK_CAPS } from '@lms/protocol';
import { centreOf, seatPosition, seatRingRadius, stormRing } from '../src/arena/layout.js';
import { COLORS, hpColor } from '../src/arena/theme.js';

describe('one-click caps', () => {
  /** The delegate refuses a grant whose per-call cap exceeds its total. */
  it('are a grant the delegate accepts', () => {
    expect(ONE_CLICK_CAPS.valueCap).toBeLessThanOrEqual(ONE_CLICK_CAPS.spendCap);
  });

  /**
   * What a leaked key can stake is what the caps say, so they stay small: a
   * few joins at the hub's 0.001 ETH minimum, never a meaningful balance.
   */
  it('cover a join at the minimum stake and stay small', () => {
    expect(ONE_CLICK_CAPS.valueCap).toBeGreaterThanOrEqual(10n ** 15n);
    expect(ONE_CLICK_CAPS.spendCap).toBeLessThanOrEqual(10n ** 18n);
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

  it('closes the arena wall in as the table stalls', () => {
    const fighting = stormRing(800, 600, 0);
    const stalling = stormRing(800, 600, 1);

    expect(fighting.intensity).toBe(0);
    expect(stalling.intensity).toBe(1);
    expect(stalling.radius).toBeLessThan(fighting.radius);
  });

  it('caps the wall at full pressure', () => {
    expect(stormRing(800, 600, 5).intensity).toBe(1);
  });
});

describe('arena theme', () => {
  it('picks the HP colour by remaining fraction', () => {
    expect(hpColor(1)).toBe(COLORS.hp);
    expect(hpColor(0.4)).toBe(COLORS.hpLow);
    expect(hpColor(0.1)).toBe(COLORS.hpCritical);
  });
});
