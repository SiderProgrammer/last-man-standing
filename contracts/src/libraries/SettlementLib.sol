// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SettlementLib
/// @notice EIP-712 struct hash of a match result.
/// @dev Mirrored by `packages/protocol/src/chain/eip712.ts`. The domain half of
///      the digest is the escrow's own `EIP712` base.
library SettlementLib {
    bytes32 internal constant MATCH_RESULT_TYPEHASH =
        keccak256("MatchResult(bytes32 matchId,uint32 rounds,bytes32 historyRoot,address[] ranking)");

    /// @notice EIP-712 struct hash of a `MatchResult`. An `address[]` member is
    ///         encoded as the hash of its elements, each padded to a word.
    function hashMatchResult(bytes32 matchId, uint32 rounds, bytes32 historyRoot, address[] memory ranking)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                MATCH_RESULT_TYPEHASH, matchId, rounds, historyRoot, keccak256(abi.encodePacked(ranking))
            )
        );
    }
}
