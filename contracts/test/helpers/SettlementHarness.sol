// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HashLib} from "../../src/libraries/HashLib.sol";
import {SettlementLib} from "../../src/libraries/SettlementLib.sol";
import {SignatureLib} from "../../src/libraries/SignatureLib.sol";
import {SeatSetLib} from "../../src/libraries/SeatSetLib.sol";
import {SettlementRef} from "./SettlementRef.sol";

/// @notice External surface over the internal settlement libraries.
///
/// @dev The libraries are `internal`, so their calldata-reading Yul can only be
///      exercised through a contract that actually receives calldata. This
///      harness is that contract, and nothing else.
///
///      It lives in its own file rather than in `Fixtures.sol` because the six
///      pure-library suites need only this — pulling it from `Fixtures` made
///      them compile `GameEscrow`, `SpokeEscrow` and two mocks
///      to test a hashing function.
contract SettlementHarness {
    function hashRanking(address[] calldata ranking) external pure returns (bytes32) {
        return SettlementLib.hashRanking(ranking);
    }

    function hashMatchResult(bytes32 matchId, uint32 rounds, bytes32 historyRoot, address[] calldata ranking)
        external
        pure
        returns (bytes32)
    {
        return SettlementLib.hashMatchResult(matchId, rounds, historyRoot, ranking);
    }

    function hashMatchResultReference(
        bytes32 matchId,
        uint32 rounds,
        bytes32 historyRoot,
        address[] memory ranking
    ) external pure returns (bytes32) {
        return SettlementRef.hashMatchResult(matchId, rounds, historyRoot, ranking);
    }

    function toTypedDataHash(bytes32 domainSeparator, bytes32 structHash) external pure returns (bytes32) {
        return SettlementLib.toTypedDataHash(domainSeparator, structHash);
    }

    function recover(bytes32 digest, bytes calldata signatures) external view returns (address[] memory) {
        return SignatureLib.recoverAscending(digest, signatures);
    }

    function assertPermutation(address[] memory seats, address[] calldata ranking) external {
        SeatSetLib.assertPermutation(seats, ranking);
    }

    /// @notice The rules hash the deploy script and the fixtures both pin.
    /// @dev One copy of the tuple for the test tree; `Deploy.s.sol` keeps its
    ///      own, because a script importing from `test/` would be worse.
    function hashRulesDefault() external pure returns (bytes32) {
        return HashLib.hashRules(4, 8, 100, 34, 20, 6000, 3000, 5000, 2, 6, 30);
    }
}
