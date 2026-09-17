// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {SettlementHarness} from "../helpers/Fixtures.sol";

/// @dev Pins the Yul hasher against the ABI-encoder reference: same digest, and
///      no worse on gas. Both paths are measured through the same external
///      harness with the same calldata, so the only difference left is what the
///      library does with the ranking — hash it where it lies, or decode it into
///      memory and re-encode it.
contract SettlementLibGasTest is Test {
    SettlementHarness internal harness;

    function setUp() public {
        harness = new SettlementHarness();
    }

    function test_yulMatchesReferenceAndIsNoMoreExpensive() public {
        address[] memory ranking = new address[](8);
        for (uint256 i = 0; i < 8; ++i) {
            ranking[i] = address(uint160(i + 1));
        }

        // Warm the account and both code paths first. The very first external
        // call pays 2600 gas of cold-account access, which would otherwise swamp
        // the difference being measured.
        bytes32 yul = harness.hashMatchResult(bytes32(uint256(1)), 4, bytes32(uint256(2)), ranking);
        bytes32 ref =
            harness.hashMatchResultReference(bytes32(uint256(1)), 4, bytes32(uint256(2)), ranking);
        assertEq(yul, ref);

        uint256 yulGas = gasleft();
        harness.hashMatchResult(bytes32(uint256(1)), 4, bytes32(uint256(2)), ranking);
        yulGas -= gasleft();

        uint256 refGas = gasleft();
        harness.hashMatchResultReference(bytes32(uint256(1)), 4, bytes32(uint256(2)), ranking);
        refGas -= gasleft();

        assertLe(yulGas, refGas);
        emit log_named_uint("yul gas", yulGas);
        emit log_named_uint("reference gas", refGas);
        emit log_named_uint("saved", refGas - yulGas);
    }

    /// @dev The saving grows with the lobby, which is the reason the Yul path
    ///      exists at all: `settle` hashes the ranking on the only code path
    ///      that moves escrowed value.
    function test_savingGrowsWithLobbySize() public view {
        uint256 smallSaving = _saving(4);
        uint256 largeSaving = _saving(64);
        assertGe(largeSaving, smallSaving);
    }

    function _saving(uint256 seats) private view returns (uint256) {
        address[] memory ranking = new address[](seats);
        for (uint256 i = 0; i < seats; ++i) {
            ranking[i] = address(uint160(i + 1));
        }

        harness.hashMatchResult(bytes32(uint256(1)), 4, bytes32(uint256(2)), ranking);
        harness.hashMatchResultReference(bytes32(uint256(1)), 4, bytes32(uint256(2)), ranking);

        uint256 yulGas = gasleft();
        harness.hashMatchResult(bytes32(uint256(1)), 4, bytes32(uint256(2)), ranking);
        yulGas -= gasleft();

        uint256 refGas = gasleft();
        harness.hashMatchResultReference(bytes32(uint256(1)), 4, bytes32(uint256(2)), ranking);
        refGas -= gasleft();

        return refGas > yulGas ? refGas - yulGas : 0;
    }
}
