import { concat, encodeAbiParameters, getAddress, keccak256, parseAbi, type Address, type Hex } from 'viem';

/**
 * The LMS airdrop: who gets how much, and the Merkle tree that commits to it.
 *
 * Shared because the allocation script builds the tree and anything that lets
 * a player claim has to produce the same leaves. `LmsAirdrop.sol` checks them,
 * so the hashing here must match it byte for byte — pinned by a frozen vector
 * in both test suites.
 */

export const lmsAirdropAbi = parseAbi([
  'function claim(address account, uint256 amount, bytes32[] proof)',
  'function claimAndStake(uint256 amount, bytes32[] proof) returns (uint256 shares)',
  'function claimed(address account) view returns (bool)',
  'function merkleRoot() view returns (bytes32)',
  'function claimDeadline() view returns (uint64)',
  'error AlreadyClaimed(address account)',
  'error InvalidProof()',
  'error ClaimWindowClosed(uint64 deadline)',
]);

/** One settled match, as the fee attribution needs it. */
export interface SettledMatch {
  stake: bigint;
  feeBps: number;
  seats: readonly Address[];
}

export interface AirdropClaim {
  amount: bigint;
  proof: Hex[];
}

export interface Airdrop {
  root: Hex;
  total: bigint;
  /** Keyed by checksummed address. */
  claims: Record<Address, AirdropClaim>;
}

/**
 * The fee each address paid across `matches`.
 *
 * The escrow takes `feeBps` of the whole pool, and every seat put the same
 * stake into it, so each seat paid `stake × feeBps` of it. Cancelled matches
 * charge nothing and must not be passed in.
 */
export function feesPaid(matches: readonly SettledMatch[]): Map<Address, bigint> {
  return new Map([...playerHistory(matches)].map(([account, { fees }]) => [account, fees]));
}

/** What one address did across the settled matches. */
export interface PlayerHistory {
  /** Fees paid, in wei. */
  fees: bigint;
  /** Distinct addresses this one has shared a match with. */
  opponents: number;
}

/**
 * Fees paid and distinct opponents, per address.
 *
 * Opponents are what make farming expensive beyond the fee. Someone filling a
 * lobby with their own wallets gets every stake back, so the fee is their only
 * cost; someone who must have played many *different* people has put their
 * stake against strangers who can win it.
 */
export function playerHistory(matches: readonly SettledMatch[]): Map<Address, PlayerHistory> {
  const fees = new Map<Address, bigint>();
  const opponents = new Map<Address, Set<Address>>();
  for (const match of matches) {
    const perSeat = (match.stake * BigInt(match.feeBps)) / 10_000n;
    if (perSeat === 0n) continue;
    const seats = [...new Set(match.seats.map((seat) => getAddress(seat)))];
    for (const account of seats) {
      fees.set(account, (fees.get(account) ?? 0n) + perSeat * BigInt(countOf(match.seats, account)));
      const met = opponents.get(account) ?? new Set<Address>();
      for (const other of seats) if (other !== account) met.add(other);
      opponents.set(account, met);
    }
  }
  return new Map([...fees].map(([account, paid]) => [account, { fees: paid, opponents: opponents.get(account)!.size }]));
}

function countOf(seats: readonly Address[], account: Address): number {
  return seats.filter((seat) => getAddress(seat) === account).length;
}

export interface AllocateOptions {
  /** Team wallets, house bots: they get nothing and their weight is not counted. */
  exclude?: readonly Address[];
  /**
   * Most an account may receive per unit of weight, as a fraction. With
   * weights in wei of fees paid, set it to `reference LMS per ETH × capBps`
   * (see `feeCap`) so nobody is airdropped more than that share of what they
   * paid — which is what keeps farming unprofitable.
   */
  capPerWeight?: { numerator: bigint; denominator: bigint };
}

/**
 * Splits `total` in proportion to `weights`, rounding each share down.
 *
 * The rounding dust is left out rather than handed to someone, so the sum of
 * the allocations is at most `total` and no account gets more than its share.
 *
 * With a cap, whatever the cap cuts is *not* redistributed to the others:
 * that would push them towards their own caps and reward whoever farmed
 * hardest. It stays undistributed — with the Safe, for a later season.
 */
export function allocate(
  weights: ReadonlyMap<Address, bigint>,
  total: bigint,
  options: AllocateOptions = {},
): Map<Address, bigint> {
  const excluded = new Set((options.exclude ?? []).map((account) => getAddress(account)));
  const eligible = [...weights].filter(([account, weight]) => weight > 0n && !excluded.has(getAddress(account)));
  const sum = eligible.reduce((acc, [, weight]) => acc + weight, 0n);

  const allocations = new Map<Address, bigint>();
  if (sum === 0n) return allocations;
  for (const [account, weight] of eligible) {
    let amount = (total * weight) / sum;
    if (options.capPerWeight) {
      const cap = (weight * options.capPerWeight.numerator) / options.capPerWeight.denominator;
      if (amount > cap) amount = cap;
    }
    if (amount > 0n) allocations.set(getAddress(account), amount);
  }
  return allocations;
}

/**
 * The cap for weights in wei of fees paid: at most `capBps` of what an account
 * paid, valued at `lmsPerEth` LMS per ETH.
 *
 * A farmer's only cost is the fee, so with `capBps` below 10,000 farming loses
 * money at the reference price. The margin below 10,000 is what covers LMS
 * trading above that price later; 2,500 tolerates a 4× rise.
 */
export function feeCap(lmsPerEth: bigint, capBps: number): { numerator: bigint; denominator: bigint } {
  if (!Number.isInteger(capBps) || capBps < 0) throw new Error('capBps must be a non-negative whole number');
  return { numerator: lmsPerEth * BigInt(capBps), denominator: 10_000n };
}

/** The weights of every address that has met at least `minOpponents` distinct opponents. */
export function eligibleFees(
  history: ReadonlyMap<Address, PlayerHistory>,
  minOpponents: number,
): Map<Address, bigint> {
  return new Map(
    [...history].filter(([, entry]) => entry.opponents >= minOpponents).map(([account, entry]) => [account, entry.fees]),
  );
}

/** `keccak256(bytes.concat(keccak256(abi.encode(account, amount))))`, as `LmsAirdrop.leaf`. */
export function airdropLeaf(account: Address, amount: bigint): Hex {
  return keccak256(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account, amount])));
}

/** Sorted-pair hashing, as OpenZeppelin's `MerkleProof` expects. */
function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/**
 * Builds the tree over `allocations` and a proof for every account.
 *
 * Leaves are sorted by hash, so the root depends only on the allocation and
 * not on the order it was produced in. An odd node at the end of a layer moves
 * up unpaired, and its proof simply has no entry for that layer.
 */
export function buildAirdrop(allocations: ReadonlyMap<Address, bigint>): Airdrop {
  const entries = [...allocations].map(([account, amount]) => {
    const checksummed = getAddress(account);
    return { account: checksummed, amount, leaf: airdropLeaf(checksummed, amount) };
  });
  if (entries.length === 0) throw new Error('an airdrop needs at least one claim');
  entries.sort((a, b) => (BigInt(a.leaf) < BigInt(b.leaf) ? -1 : 1));

  const layers: Hex[][] = [entries.map((entry) => entry.leaf)];
  while (layers[layers.length - 1]!.length > 1) {
    const below = layers[layers.length - 1]!;
    const above: Hex[] = [];
    for (let i = 0; i < below.length; i += 2) {
      above.push(i + 1 < below.length ? hashPair(below[i]!, below[i + 1]!) : below[i]!);
    }
    layers.push(above);
  }

  const claims: Record<Address, AirdropClaim> = {};
  entries.forEach((entry, index) => {
    const proof: Hex[] = [];
    let position = index;
    for (const layer of layers.slice(0, -1)) {
      const sibling = position ^ 1;
      if (sibling < layer.length) proof.push(layer[sibling]!);
      position >>= 1;
    }
    claims[entry.account] = { amount: entry.amount, proof };
  });

  return {
    root: layers[layers.length - 1]![0]!,
    total: entries.reduce((sum, entry) => sum + entry.amount, 0n),
    claims,
  };
}

/** Recomputes the root from a claim, as `LmsAirdrop.verify` does. */
export function verifyAirdropClaim(root: Hex, account: Address, claim: AirdropClaim): boolean {
  let node = airdropLeaf(getAddress(account), claim.amount);
  for (const sibling of claim.proof) node = hashPair(node, sibling);
  return node === root;
}
