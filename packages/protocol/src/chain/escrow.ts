import { parseAbi } from 'viem';

/**
 * The `GameEscrow` surface shared by the server and the browser client.
 *
 * It lives in `protocol` for the same reason the EIP-712 schema does: both
 * sides have to agree with the deployed contract exactly, so there should be
 * one copy of the interface and not one per consumer.
 */
export const gameEscrowAbi = parseAbi([
  'function getSeats(bytes32 matchId) view returns (address[])',
  'function getMatch(bytes32 matchId) view returns ((uint128 stake,uint16 feeBps,uint16 minSeats,uint16 maxSeats,uint16 seatCount,uint8 status,uint64 joinDeadline,uint64 settleDeadline,uint64 settleWindow,address treasury,bytes32 rulesHash,bytes32 seed,bytes32 historyRoot))',
  'function getRanking(bytes32 matchId) view returns (address[])',
  'function seatOrigin(bytes32 matchId, address player) view returns (uint32)',
  'function hasSeat(bytes32 matchId, address player) view returns (bool)',
  'function createMatch(uint128 stake, uint16 maxSeats) returns (bytes32)',
  'function join(bytes32 matchId) payable',
  'function lockMatch(bytes32 matchId) returns (bytes32)',
  'function settle(bytes32 matchId, uint32 rounds, bytes32 historyRoot, address[] ranking, bytes signatures)',
  'function withdraw(address to) returns (uint256)',
  'function withdrawFor(address account) returns (uint256)',
  'function withdrawToChain(uint32 dstChainId) payable returns (uint256)',
  'function withdrawable(address account) view returns (uint256)',
  'event MatchCreated(bytes32 indexed matchId, address indexed creator, uint128 stake, uint16 maxSeats, bytes32 rulesHash)',
  'event PlayerJoined(bytes32 indexed matchId, address indexed player, uint16 seat, uint32 originChainId)',
  'event MatchStarted(bytes32 indexed matchId, bytes32 seed, uint64 settleDeadline)',
  'event MatchSettled(bytes32 indexed matchId, bytes32 indexed historyRoot, uint32 rounds, address indexed winner)',
]);

/** Mirrors `GameEscrow.MatchStatus`. */
export const MatchStatus = {
  None: 0,
  Open: 1,
  Pending: 2,
  Live: 3,
  Settled: 4,
  Cancelled: 5,
} as const;

export type MatchStatusValue = (typeof MatchStatus)[keyof typeof MatchStatus];
