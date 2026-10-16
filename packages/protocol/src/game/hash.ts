import { encodeAbiParameters, keccak256, parseAbiParameters } from 'viem';
import { Action, type ActionValue, type RoundRecord, type SealedMove } from './types.js';
import { BPS_DENOMINATOR } from './rules.js';

/**
 * Every hash in this module is built with `abi.encode` so that Solidity can
 * recompute it byte-for-byte. Any change here is a consensus-breaking change
 * and must be mirrored in `contracts/src/libraries/`.
 */

const COMMIT_ABI = parseAbiParameters(
  'bytes32 matchId, uint32 round, uint8 seat, uint8 action, uint8 target, bytes32 salt',
);

/**
 * Blinded commitment a player broadcasts during the commit phase.
 *
 * The match id, round, and seat are bound into the hash so a commitment cannot
 * be replayed in a later round or claimed by a different seat. The target is
 * forced to zero for non-attack actions, otherwise the number of hash
 * preimages would leak whether a player intended to attack.
 */
export function commitMove(
  matchId: `0x${string}`,
  round: number,
  seat: number,
  move: SealedMove,
): `0x${string}` {
  const target = move.action === Action.Attack ? move.target : 0;
  return keccak256(
    encodeAbiParameters(COMMIT_ABI, [matchId, round, seat, move.action, target, move.salt]),
  );
}

/** Salt recorded for a seat that revealed nothing this round. */
export const ZERO_SALT = `0x${'0'.repeat(64)}` as const;

/**
 * Every seat's revealed salt for a round, indexed by seat, with `ZERO_SALT`
 * for any seat that was dead or did not reveal. The one canonical layout used
 * by both the round seed and the round hash.
 */
export function saltsBySeat(
  seats: number,
  moves: ReadonlyArray<{ index: number; revealed: boolean; salt: `0x${string}` }>,
): `0x${string}`[] {
  const salts: `0x${string}`[] = new Array<`0x${string}`>(seats).fill(ZERO_SALT);
  for (const move of moves) {
    if (move.revealed && move.index >= 0 && move.index < seats) salts[move.index] = move.salt;
  }
  return salts;
}

const ROUND_ABI = parseAbiParameters(
  'uint32 round, uint8[] actions, uint8[] targets, bytes32[] salts, uint32[] hpAfter, uint8[] eliminated',
);

/**
 * Canonical hash of one resolved round, ordered by seat index.
 *
 * The salts are part of it because they are part of the outcome: they decide
 * every roll in the round. A history root that left them out would let a
 * quorum publish different salts after the fact, and a replay could no
 * longer re-derive the rolls the root was signed over.
 */
export function hashRound(
  round: number,
  seats: number,
  record: Omit<RoundRecord, 'hash'>,
): `0x${string}` {
  const actions: number[] = new Array<number>(seats).fill(Action.None);
  const targets: number[] = new Array<number>(seats).fill(0);
  for (const move of record.moves) {
    actions[move.index] = move.action;
    targets[move.index] = move.action === Action.Attack ? move.target : 0;
  }
  const salts = saltsBySeat(seats, record.moves);
  const hpAfter = record.hpAfter.map((hp) => (hp > 0 ? hp : 0));
  return keccak256(
    encodeAbiParameters(ROUND_ABI, [round, actions, targets, salts, hpAfter, [...record.eliminated]]),
  );
}

const HISTORY_SEED_ABI = parseAbiParameters('bytes32 matchId, bytes32 rulesHash, bytes32 seed');
const HISTORY_STEP_ABI = parseAbiParameters('bytes32 previous, bytes32 roundHash');

/**
 * First link of the history chain. Seeding it with the rules digest means a
 * result can only be verified against the rule set it was produced under.
 */
export function historySeed(
  matchId: `0x${string}`,
  rulesHash: `0x${string}`,
  seed: `0x${string}`,
): `0x${string}` {
  return keccak256(encodeAbiParameters(HISTORY_SEED_ABI, [matchId, rulesHash, seed]));
}

/** Folds one round hash into the running history root. */
export function chainHistory(previous: `0x${string}`, roundHash: `0x${string}`): `0x${string}` {
  return keccak256(encodeAbiParameters(HISTORY_STEP_ABI, [previous, roundHash]));
}

const ROUND_SEED_ABI = parseAbiParameters('bytes32 seed, uint32 round, bytes32[] salts');

/**
 * Entropy for one round's rolls: the match seed, the round, and every revealed
 * salt, in seat order.
 *
 * The match seed alone is public from the moment the match starts, so rolls
 * keyed on it could be computed before anyone committed — Hide's evade chance
 * would be a lookup table. Mixing in the salts makes each round's rolls depend
 * on every player's secret, so nobody can know them until all reveals are in.
 * A player who withholds a reveal to change the roll forfeits their own move
 * and takes every hit at no evade, which prices that grind honestly.
 */
export function roundSeed(
  seed: `0x${string}`,
  round: number,
  salts: readonly `0x${string}`[],
): `0x${string}` {
  return keccak256(encodeAbiParameters(ROUND_SEED_ABI, [seed, round, [...salts]]));
}

const DRAW_ABI = parseAbiParameters('bytes32 roundSeed, uint32 nonce');

/** Deterministic 256-bit draw from a round seed. `nonce` separates independent draws. */
export function draw(seedOfRound: `0x${string}`, nonce: number): bigint {
  return BigInt(keccak256(encodeAbiParameters(DRAW_ABI, [seedOfRound, nonce])));
}

/** Deterministic draw in `[0, 10000)` from a round seed. */
export function drawBps(seedOfRound: `0x${string}`, nonce: number): number {
  return Number(draw(seedOfRound, nonce) % BigInt(BPS_DENOMINATOR));
}

const MATCH_ID_ABI = parseAbiParameters('uint256 chainId, address escrow, uint256 nonce');

/** Match ids are derived from the escrow that holds the stakes, so they are unique across chains. */
export function deriveMatchId(
  chainId: number,
  escrow: `0x${string}`,
  nonce: bigint,
): `0x${string}` {
  return keccak256(encodeAbiParameters(MATCH_ID_ABI, [BigInt(chainId), escrow, nonce]));
}

/** Narrowing guard for values arriving off the wire. */
export function isActionValue(value: unknown): value is ActionValue {
  return value === Action.None || value === Action.Attack || value === Action.Defend || value === Action.Hide;
}
