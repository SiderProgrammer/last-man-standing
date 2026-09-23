// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SettlementLib} from "../../src/libraries/SettlementLib.sol";

/// @notice Straightforward Solidity twin of `SettlementLib`'s Yul hashers.
///
/// @dev Exists so `test/fuzz/SettlementLibFuzz.t.sol` has something honest to
///      diff the assembly against, and `test/unit/SettlementLibGas.t.sol` has a
///      baseline to measure it beating.
///
///      It lives here rather than in `src/libraries/SettlementLib.sol`, where
///      it used to sit: it is reachable only from tests, and production code
///      should not carry a second implementation of its own hot path just to
///      be compared with.
library SettlementRef {
    /// @notice EIP-712 reference: keccak of 32-byte left-padded addresses.
    /// @dev `abi.encodePacked` over `address[]` would pack 20-byte words and
    ///      diverge from both the library and `viem`'s typed-data hasher.
    function hashRanking(address[] memory ranking) internal pure returns (bytes32 digest) {
        assembly ("memory-safe") {
            digest := keccak256(add(ranking, 0x20), mul(mload(ranking), 0x20))
        }
    }

    function hashMatchResult(
        bytes32 matchId,
        uint32 rounds,
        bytes32 historyRoot,
        address[] memory ranking
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SettlementLib.MATCH_RESULT_TYPEHASH, matchId, rounds, historyRoot, hashRanking(ranking)
            )
        );
    }
}
