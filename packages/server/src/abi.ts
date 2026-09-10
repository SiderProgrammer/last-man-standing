import { parseAbi } from 'viem';

/// Subset of `GameEscrow` the server needs: read the seat list, follow the
/// lifecycle, and push an attested result back on-chain.
export const gameEscrowAbi = parseAbi([
  'function getSeats(bytes32 matchId) view returns (address[])',
  'function getMatch(bytes32 matchId) view returns ((uint128 stake,uint16 feeBps,uint16 minSeats,uint16 maxSeats,uint16 seatCount,uint8 status,uint64 joinDeadline,uint64 settleDeadline,uint64 settleWindow,address treasury,bytes32 rulesHash,bytes32 seed,bytes32 historyRoot))',
  'function settle(bytes32 matchId, uint32 rounds, bytes32 historyRoot, address[] ranking, bytes signatures)',
  'function seatOrigin(bytes32 matchId, address player) view returns (uint32)',
  'event MatchStarted(bytes32 indexed matchId, bytes32 seed, uint64 settleDeadline)',
  'event MatchSettled(bytes32 indexed matchId, bytes32 indexed historyRoot, uint32 rounds, address indexed winner)',
]);
