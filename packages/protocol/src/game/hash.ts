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

const ROUND_ABI = parseAbiParameters(
  'uint32 round, uint8[] actions, uint8[] targets, uint32[] hpAfter, uint8[] eliminated',
);

/** Canonical hash of one resolved round, ordered by seat index. */
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
  const hpAfter = record.hpAfter.map((hp) => (hp > 0 ? hp : 0));
  return keccak256(
    encodeAbiParameters(ROUND_ABI, [round, actions, targets, hpAfter, [...record.eliminated]]),
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

const DRAW_ABI = parseAbiParameters('bytes32 seed, uint32 round, uint32 nonce');

/**
 * Deterministic draw in `[0, 10000)` derived from the match seed.
 *
 * The seed comes from a randomness oracle and is fixed before the first
 * commit, so the server cannot bias a roll and anyone holding the seed can
 * replay every roll in the match.
 */
export function drawBps(seed: `0x${string}`, round: number, nonce: number): number {
  const digest = keccak256(encodeAbiParameters(DRAW_ABI, [seed, round, nonce]));
  return Number(BigInt(digest) % BigInt(BPS_DENOMINATOR));
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
