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
 * forced to zero for every action but Strike, otherwise the number of hash
 * preimages would leak whether a player intended to strike.
 */
export function commitMove(
  matchId: `0x${string}`,
  round: number,
  seat: number,
  move: SealedMove,
): `0x${string}` {
  const target = move.action === Action.Strike ? move.target : 0;
  return keccak256(
    encodeAbiParameters(COMMIT_ABI, [matchId, round, seat, move.action, target, move.salt]),
  );
}

/** Salt recorded for a seat that revealed nothing this round. */
export const ZERO_SALT = `0x${'0'.repeat(64)}` as const;

/** Commitment recorded for a seat that sealed nothing this round. */
export const NO_COMMITMENT = ZERO_SALT;

/**
 * Every seat's commitment for a round, indexed by seat, with `NO_COMMITMENT`
 * for any seat that was dead or did not commit.
 */
export function commitmentsBySeat(
  seats: number,
  moves: ReadonlyArray<{ index: number; commitment: `0x${string}` }>,
): `0x${string}`[] {
  const commitments: `0x${string}`[] = new Array<`0x${string}`>(seats).fill(NO_COMMITMENT);
  for (const move of moves) {
    if (move.index >= 0 && move.index < seats) commitments[move.index] = move.commitment;
  }
  return commitments;
}

/**
 * Every seat's revealed salt for a round, indexed by seat, with `ZERO_SALT`
 * for any seat that was dead or did not reveal. The layout the round hash uses.
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
  'uint32 round, uint8[] actions, uint8[] targets, bytes32[] salts, bytes32[] commitments, uint32[] hpAfter, uint8[] eliminated',
);

/**
 * Canonical hash of one resolved round, ordered by seat index.
 *
 * The salts are part of it because they are part of the outcome: they decide
 * every roll in the round. A history root that left them out would let a
 * quorum publish different salts after the fact, and a replay could no
 * longer re-derive the rolls the root was signed over. The commitments are
 * part of it so the signed root pins what every seat sealed, revealed or not:
 * each reveal can be checked against its commitment, and a commitment a
 * player holds a receipt for cannot be left out without the root changing.
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
    targets[move.index] = move.action === Action.Strike ? move.target : 0;
  }
  const salts = saltsBySeat(seats, record.moves);
  const commitments = commitmentsBySeat(seats, record.moves);
  const hpAfter = record.hpAfter.map((hp) => (hp > 0 ? hp : 0));
  return keccak256(
    encodeAbiParameters(ROUND_ABI, [round, actions, targets, salts, commitments, hpAfter, [...record.eliminated]]),
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

const COMMITMENT_SET_ABI = parseAbiParameters('bytes32[] commitments');

/**
 * Digest of a round's commitments, in seat order with `NO_COMMITMENT` for a
 * seat that sealed nothing. Fixed the moment the commit window closes.
 */
export function commitmentSetHash(commitments: readonly `0x${string}`[]): `0x${string}` {
  return keccak256(encodeAbiParameters(COMMITMENT_SET_ABI, [[...commitments]]));
}

const ROUND_SEED_ABI = parseAbiParameters('bytes32 seed, uint32 round, bytes32 commitmentSet');

/**
 * Entropy for one round's rolls: the match seed, the round, and the digest of
 * every commitment sealed in it (`commitmentSetHash`).
 *
 * The match seed alone is public from the moment the match starts, so rolls
 * keyed on it could be computed before anyone committed — which striker a
 * Guard blocks, and how ties break, would be a lookup table. Each commitment
 * hides a fresh salt, so nobody can know the rolls until every commitment is
 * in. And they are fixed at that moment: what happens at reveal cannot move
 * them. A player who withholds a reveal, or a server that drops one, changes
 * only that seat's move, never the dice. (Keyed on the revealed salts instead,
 * a withheld reveal re-rolled the round.)
 *
 * The commitments are kept from everyone until the window closes, or the
 * last to commit could grind their salt against the others' and pick the
 * rolls. The server sees them as they arrive; it still cannot choose a
 * player's salt, and with `hold` it is the one party that knows a move before
 * the reveal.
 */
export function roundSeed(seed: `0x${string}`, round: number, commitmentSet: `0x${string}`): `0x${string}` {
  return keccak256(encodeAbiParameters(ROUND_SEED_ABI, [seed, round, commitmentSet]));
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
  return value === Action.None || value === Action.Strike || value === Action.Guard || value === Action.Charge;
}
