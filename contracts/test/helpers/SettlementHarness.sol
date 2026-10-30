// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {HashLib} from "../../src/libraries/HashLib.sol";
import {SettlementLib} from "../../src/libraries/SettlementLib.sol";
import {SignatureLib} from "../../src/libraries/SignatureLib.sol";

/// @notice External surface over the internal settlement libraries.
///
/// @dev `SignatureLib` reads calldata, so it can only be exercised through a
///      contract that actually receives calldata. This harness is that
///      contract, and nothing else.
///
///      It lives in its own file rather than in `Fixtures.sol` because the
///      pure-library suites need only this — pulling it from `Fixtures` made
///      them compile `GameEscrow`, `SpokeEscrow` and two mocks
///      to test a hashing function.
contract SettlementHarness {
    function hashMatchResult(bytes32 matchId, uint32 rounds, bytes32 historyRoot, address[] calldata ranking)
        external
        pure
        returns (bytes32)
    {
        return SettlementLib.hashMatchResult(matchId, rounds, historyRoot, ranking);
    }

    function toTypedDataHash(bytes32 domainSeparator, bytes32 structHash) external pure returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
    }

    function recover(bytes32 digest, bytes calldata signatures) external pure returns (address[] memory) {
        return SignatureLib.recoverAscending(digest, signatures);
    }

    /// @notice The rules hash the deploy script and the fixtures both pin.
    /// @dev One copy of the tuple for the test tree; `Deploy.s.sol` keeps its
    ///      own, because a script importing from `test/` would be worse.
    function hashRulesDefault() external pure returns (bytes32) {
        return HashLib.hashRules(HashLib.defaultRules());
    }
}
