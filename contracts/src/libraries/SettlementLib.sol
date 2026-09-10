// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SettlementLib
/// @notice EIP-712 hashing for match results, written in Yul.
/// @dev Settlement is the only path that moves escrowed value, and it hashes a
///      variable-length ranking on every call. The naive Solidity version
///      (`abi.encodePacked` over the ranking, then `abi.encode` over the
///      struct) allocates two intermediate `bytes` arrays and copies the
///      ranking twice. These routines hash straight out of calldata into
///      scratch memory instead. `test/unit/SettlementLibGas.t.sol` pins the
///      saving and `test/fuzz/SettlementLibFuzz.t.sol` proves equivalence with
///      the reference implementation.
library SettlementLib {
    /// @dev keccak256("MatchResult(bytes32 matchId,uint32 rounds,bytes32 historyRoot,address[] ranking)")
    bytes32 internal constant MATCH_RESULT_TYPEHASH =
        keccak256("MatchResult(bytes32 matchId,uint32 rounds,bytes32 historyRoot,address[] ranking)");

    /// @notice EIP-712 `encodeData` hash of an `address[]` member.
    /// @dev Calldata array elements are not validated by the compiler, so the
    ///      upper 96 bits of each word have to be masked before hashing;
    ///      otherwise a caller could produce different digests for the same
    ///      logical ranking by dirtying those bits.
    function hashRanking(address[] calldata ranking) internal pure returns (bytes32 digest) {
        assembly ("memory-safe") {
            // Scratch space above the free memory pointer. It is never handed
            // out, so the pointer itself does not need to move.
            let buffer := mload(0x40)
            let source := ranking.offset
            let cursor := buffer
            let end := add(source, shl(5, ranking.length))

            for {} lt(source, end) {} {
                mstore(cursor, and(calldataload(source), 0xffffffffffffffffffffffffffffffffffffffff))
                source := add(source, 0x20)
                cursor := add(cursor, 0x20)
            }

            digest := keccak256(buffer, sub(cursor, buffer))
        }
    }

    /// @notice EIP-712 struct hash of a `MatchResult`.
    function hashMatchResult(
        bytes32 matchId,
        uint32 rounds,
        bytes32 historyRoot,
        address[] calldata ranking
    ) internal pure returns (bytes32 structHash) {
        bytes32 rankingHash = hashRanking(ranking);
        // Constants are not addressable from inline assembly, so bind it first.
        bytes32 typeHash = MATCH_RESULT_TYPEHASH;

        assembly ("memory-safe") {
            let buffer := mload(0x40)
            mstore(buffer, typeHash)
            mstore(add(buffer, 0x20), matchId)
            mstore(add(buffer, 0x40), and(rounds, 0xffffffff))
            mstore(add(buffer, 0x60), historyRoot)
            mstore(add(buffer, 0x80), rankingHash)
            structHash := keccak256(buffer, 0xa0)
        }
    }

    /// @notice Final EIP-712 digest: `keccak256(0x1901 ‖ domainSeparator ‖ structHash)`.
    function toTypedDataHash(bytes32 domainSeparator, bytes32 structHash)
        internal
        pure
        returns (bytes32 digest)
    {
        assembly ("memory-safe") {
            let buffer := mload(0x40)
            mstore(buffer, hex"1901")
            mstore(add(buffer, 0x02), domainSeparator)
            mstore(add(buffer, 0x22), structHash)
            digest := keccak256(buffer, 0x42)
        }
    }

    /// @notice EIP-712 reference: keccak of 32-byte left-padded addresses.
    /// @dev `abi.encodePacked` over `address[]` would pack 20-byte words and
    ///      diverge from both this library and `viem`'s typed-data hasher.
    function hashRankingReference(address[] memory ranking) internal pure returns (bytes32 digest) {
        assembly ("memory-safe") {
            digest := keccak256(add(ranking, 0x20), mul(mload(ranking), 0x20))
        }
    }

    /// @notice Reference implementation, kept for differential testing only.
    function hashMatchResultReference(
        bytes32 matchId,
        uint32 rounds,
        bytes32 historyRoot,
        address[] memory ranking
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(MATCH_RESULT_TYPEHASH, matchId, rounds, historyRoot, hashRankingReference(ranking))
        );
    }
}
