import { encodeAbiParameters, parseAbi, parseAbiParameters } from 'viem';
import { roundPreimage } from '../game/hash.js';
import type { RoundRecord } from '../game/types.js';

/**
 * The `GameEscrow` surface shared by the server and the browser client.
 *
 * It lives in `protocol` for the same reason the EIP-712 schema does: both
 * sides have to agree with the deployed contract exactly, so there should be
 * one copy of the interface and not one per consumer.
 */
export const gameEscrowAbi = parseAbi([
  'function getSeats(bytes32 matchId) view returns (address[])',
  'function getMatch(bytes32 matchId) view returns ((uint128 stake,uint16 feeBps,uint16 minSeats,uint16 maxSeats,uint16 seatCount,uint8 status,uint64 joinDeadline,uint64 settleDeadline,uint64 settleWindow,address treasury,bytes32 rulesHash,bytes32 seed,bytes32 historyRoot,uint64 challengeWindow,uint64 challengeDeadline,uint32 rounds,bytes32 rankingHash,bytes32 signersHash))',
  'function seatOrigin(bytes32 matchId, address player) view returns (uint32)',
  'function hasSeat(bytes32 matchId, address player) view returns (bool)',
  'function createMatch(uint128 stake, uint16 maxSeats) returns (bytes32)',
  'function join(bytes32 matchId) payable',
  'function lockMatch(bytes32 matchId) returns (bytes32)',
  'function settle(bytes32 matchId, uint32 rounds, bytes32 historyRoot, address[] ranking, bytes signatures, bytes log)',
  'function finalize(bytes32 matchId, address[] ranking)',
  'function abortMatch(bytes32 matchId, bytes signatures)',
  'function cancelMatch(bytes32 matchId)',
  'function challenge(bytes32 matchId, (uint16 minPlayers,uint16 maxPlayers,uint32 startingHp,uint32 attackDamage,uint32 riposteDamage,uint16 hideEvadeBps,uint16 hideStormBps,uint16 stormGraceRounds,uint32 stormBaseDamage,uint16 maxRounds) rules, bytes log, address[] signers)',
  'function withdraw(address to) returns (uint256)',
  'function withdrawFor(address account) returns (uint256)',
  'function withdrawable(address account) view returns (uint256)',
  'event MatchCreated(bytes32 indexed matchId, address indexed creator, uint128 stake, uint16 maxSeats, bytes32 rulesHash)',
  'event PlayerJoined(bytes32 indexed matchId, address indexed player, uint16 seat, uint32 originChainId)',
  'event MatchStarted(bytes32 indexed matchId, bytes32 seed, uint64 settleDeadline)',
  'event MatchSettled(bytes32 indexed matchId, bytes32 indexed historyRoot, uint32 rounds, address indexed winner)',
  'event ResultProposed(bytes32 indexed matchId, bytes32 indexed historyRoot, uint32 rounds, address[] ranking, address[] signers, uint64 challengeDeadline)',
  'event FraudProven(bytes32 indexed matchId, address indexed challenger, uint8 verdict, uint256 badRound)',
]);

const ROUND_LOG_ABI = parseAbiParameters(
  '(uint8[] actions,uint8[] targets,bytes32[] salts,uint32[] hpAfter,uint8[] eliminated)[] rounds',
);

/**
 * The round log `GameEscrow.settle` and `challenge` take: every round's hash
 * preimage, `abi.encode`d. `settle` refuses a result whose log does not hash
 * to its root, so this is also what puts the evidence for a fraud proof
 * on-chain, in the settlement transaction itself.
 */
export function encodeRoundLog(seats: number, history: ReadonlyArray<Omit<RoundRecord, 'hash'>>): `0x${string}` {
  return encodeAbiParameters(ROUND_LOG_ABI, [history.map((record) => roundPreimage(seats, record))]);
}

/** Mirrors `GameEscrow.MatchStatus`. */
export const MatchStatus = {
  None: 0,
  Open: 1,
  Pending: 2,
  Live: 3,
  Settled: 4,
  Cancelled: 5,
  /** Signed and published; pays out once the challenge window closes unchallenged. */
  Proposed: 6,
} as const;

export type MatchStatusValue = (typeof MatchStatus)[keyof typeof MatchStatus];
