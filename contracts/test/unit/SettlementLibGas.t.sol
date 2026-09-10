// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {SettlementHarness} from "../helpers/Fixtures.sol";

/// @dev Pins the Yul hasher against the ABI-encoder reference so a future
///      "optimisation" cannot quietly change the digest.
contract SettlementLibGasTest is Test {
    SettlementHarness internal harness;

    function setUp() public {
        harness = new SettlementHarness();
    }

    function test_yulIsCheaperThanReferenceOnEightSeats() public {
        address[] memory ranking = new address[](8);
        for (uint256 i = 0; i < 8; ++i) {
            ranking[i] = address(uint160(i + 1));
        }

        uint256 yulGas = gasleft();
        bytes32 yul = harness.hashMatchResult(bytes32(uint256(1)), 4, bytes32(uint256(2)), ranking);
        yulGas -= gasleft();

        uint256 refGas = gasleft();
        bytes32 ref = harness.hashMatchResultReference(bytes32(uint256(1)), 4, bytes32(uint256(2)), ranking);
        refGas -= gasleft();

        assertEq(yul, ref);
        // Calldata Yul path should not be worse than the memory ABI-encoder path
        // when both go through the same external harness.
        assertLe(yulGas, refGas + 500);
    }
}
