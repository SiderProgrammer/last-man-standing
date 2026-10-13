import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import {
  allocate,
  buildAirdrop,
  eligibleFees,
  feeCap,
  feesPaid,
  playerHistory,
  verifyAirdropClaim,
} from '../src/chain/airdrop.js';

const A1 = '0x00000000000000000000000000000000000000A1' as const;
const A2 = '0x00000000000000000000000000000000000000A2' as const;
const A3 = '0x00000000000000000000000000000000000000A3' as const;
const E18 = 10n ** 18n;

/**
 * Frozen vector, pinned against `contracts/test/unit/LmsAirdrop.t.sol`. The
 * contract verifies these exact proofs; if the leaf or pair hashing here ever
 * changes, this test fails rather than every player's claim.
 */
const ROOT = '0xc8142836db2816d597956a59efe05a50fcaa3545f8329a2bb31edccc4981ef43';

describe('buildAirdrop', () => {
  const airdrop = buildAirdrop(
    new Map<Address, bigint>([
      [A1, 100n * E18],
      [A2, 250n * E18],
      [A3, 7n],
    ]),
  );

  it('matches the frozen vector the Solidity side is pinned to', () => {
    expect(airdrop.root).toBe(ROOT);
    expect(airdrop.total).toBe(350n * E18 + 7n);
    expect(airdrop.claims[A1]?.proof).toEqual(['0x2621105fb1c8fca9e58a40d3418d97e09803c789114402bcffce8ceeb805ae2b']);
  });

  it('gives every account a proof that verifies, and only for its own amount', () => {
    for (const [account, claim] of Object.entries(airdrop.claims) as [Address, { amount: bigint; proof: `0x${string}`[] }][]) {
      expect(verifyAirdropClaim(airdrop.root, account, claim)).toBe(true);
      expect(verifyAirdropClaim(airdrop.root, account, { ...claim, amount: claim.amount + 1n })).toBe(false);
    }
  });

  it('does not depend on input order or address casing', () => {
    const reordered = buildAirdrop(
      new Map<Address, bigint>([
        [A3.toLowerCase() as Address, 7n],
        [A2, 250n * E18],
        [A1, 100n * E18],
      ]),
    );
    expect(reordered.root).toBe(ROOT);
  });

  it('handles a single claim and larger odd-sized trees', () => {
    const single = buildAirdrop(new Map<Address, bigint>([[A1, 1n]]));
    expect(single.claims[A1]?.proof).toEqual([]);
    expect(verifyAirdropClaim(single.root, A1, single.claims[A1]!)).toBe(true);

    const many = new Map<Address, bigint>();
    for (let i = 1; i <= 11; i++) many.set(`0x${i.toString(16).padStart(40, '0')}` as Address, BigInt(i) * E18);
    const tree = buildAirdrop(many);
    for (const [account, claim] of Object.entries(tree.claims) as [Address, { amount: bigint; proof: `0x${string}`[] }][]) {
      expect(verifyAirdropClaim(tree.root, account, claim)).toBe(true);
    }
  });

  it('refuses an empty allocation', () => {
    expect(() => buildAirdrop(new Map())).toThrow();
  });
});

describe('feesPaid', () => {
  it('charges each seat stake × feeBps, summed across matches, merging address casing', () => {
    const fees = feesPaid([
      { stake: 1n * E18, feeBps: 500, seats: [A1, A2, A3, A1.toLowerCase() as Address] },
      { stake: 2n * E18, feeBps: 250, seats: [A2] },
    ]);

    expect(fees.get(A1)).toBe(E18 / 10n); // two seats at 0.05
    expect(fees.get(A2)).toBe(E18 / 20n + E18 / 20n);
    expect(fees.get(A3)).toBe(E18 / 20n);
  });

  it('skips matches that charged nothing', () => {
    expect(feesPaid([{ stake: 1n * E18, feeBps: 0, seats: [A1] }]).size).toBe(0);
  });
});

describe('allocate', () => {
  it('splits in proportion to weight, rounding down so the sum never exceeds the total', () => {
    const allocations = allocate(
      new Map<Address, bigint>([
        [A1, 1n],
        [A2, 2n],
      ]),
      100n,
    );

    expect(allocations.get(A1)).toBe(33n);
    expect(allocations.get(A2)).toBe(66n);
    expect([...allocations.values()].reduce((a, b) => a + b, 0n)).toBeLessThanOrEqual(100n);
  });

  it('drops excluded accounts and does not count their weight', () => {
    const allocations = allocate(
      new Map<Address, bigint>([
        [A1, 1n],
        [A2, 1n],
      ]),
      100n,
      { exclude: [A2.toLowerCase() as Address] },
    );

    expect(allocations.get(A1)).toBe(100n);
    expect(allocations.has(A2)).toBe(false);
  });

  it('is empty when nobody has any weight', () => {
    expect(allocate(new Map(), 100n).size).toBe(0);
  });

  it('caps each account at a share of the fees it paid, and does not hand the cut to others', () => {
    // A1 paid 1 ETH of fees, A2 paid 0.01 ETH. 100,000 LMS per ETH, capped at 25%.
    const weights = new Map<Address, bigint>([
      [A1, E18],
      [A2, E18 / 100n],
    ]);
    const total = 1_000_000n * E18;

    const allocations = allocate(weights, total, { capPerWeight: feeCap(100_000n, 2_500) });

    expect(allocations.get(A1)).toBe(25_000n * E18); // 25% of 1 ETH × 100k
    expect(allocations.get(A2)).toBe(250n * E18); // 25% of 0.01 ETH × 100k
    const distributed = [...allocations.values()].reduce((a, b) => a + b, 0n);
    expect(distributed).toBeLessThan(total);
  });

  it('leaves an account under its cap with its plain proportional share', () => {
    const allocations = allocate(new Map<Address, bigint>([[A1, E18]]), 10n * E18, {
      capPerWeight: feeCap(100_000n, 2_500),
    });

    expect(allocations.get(A1)).toBe(10n * E18);
  });

  it('makes farming lose money at the reference price', () => {
    // A farmer pays `fees` wei and receives at most capBps of their value in LMS.
    const fees = 3n * E18;
    const lmsPerEth = 100_000n;
    const received = allocate(new Map<Address, bigint>([[A1, fees]]), 10n ** 30n, {
      capPerWeight: feeCap(lmsPerEth, 2_500),
    }).get(A1)!;

    const valueInEth = received / lmsPerEth;
    expect(valueInEth).toBeLessThan(fees);
  });

  it('rejects a cap that is not a whole number of basis points', () => {
    expect(() => feeCap(1n, -1)).toThrow();
    expect(() => feeCap(1n, 0.5)).toThrow();
  });
});

describe('playerHistory and eligibleFees', () => {
  const A4 = getAddress('0x00000000000000000000000000000000000000a4');

  it('counts distinct opponents across matches', () => {
    const history = playerHistory([
      { stake: E18, feeBps: 500, seats: [A1, A2, A3] },
      { stake: E18, feeBps: 500, seats: [A1, A2, A4] },
    ]);

    expect(history.get(A1)).toEqual({ fees: E18 / 10n, opponents: 3 });
    expect(history.get(A3)).toEqual({ fees: E18 / 20n, opponents: 2 });
  });

  it('drops accounts that have only ever played a small closed circle', () => {
    // A1–A3 only ever play each other; A4 also met the others in a second lobby.
    const history = playerHistory([
      { stake: E18, feeBps: 500, seats: [A1, A2, A3] },
      { stake: E18, feeBps: 500, seats: [A1, A2, A3] },
      { stake: E18, feeBps: 500, seats: [A4, A1, A2, A3] },
    ]);

    expect([...eligibleFees(history, 3).keys()].sort()).toEqual([A1, A2, A3, A4].sort());
    expect([...eligibleFees(history, 4).keys()]).toEqual([]);
    expect(eligibleFees(history, 0).get(A1)).toBe((3n * E18) / 20n);
  });
});
