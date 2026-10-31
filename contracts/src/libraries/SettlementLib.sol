// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SettlementLib
/// @notice EIP-712 struct hash of a match result.
/// @dev Mirrored by `packages/consensus/src/eip712/result.ts`. The domain half of
///      the digest is the escrow's own `EIP712` base.
library SettlementLib {
    bytes32 internal constant MATCH_RESULT_TYPEHASH = keccak256(
        "MatchResult(bytes32 matchId,uint32 rounds,bytes32 historyRoot,bytes32 transcriptHash,address[] ranking)"
    );

    /// @notice EIP-712 struct hash of a `MatchResult`. An `address[]` member is
    ///         encoded as the hash of its elements, each padded to a word.
    /// @param transcriptHash keccak256 of the archived transcript's canonical
    ///        JSON (`hashTranscript` in `packages/consensus`).
    function hashMatchResult(
        bytes32 matchId,
        uint32 rounds,
        bytes32 historyRoot,
        bytes32 transcriptHash,
        address[] memory ranking
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MATCH_RESULT_TYPEHASH,
                matchId,
                rounds,
                historyRoot,
                transcriptHash,
                keccak256(abi.encodePacked(ranking))
            )
        );
    }
}
