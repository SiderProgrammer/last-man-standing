// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {HashLib} from "../../src/libraries/HashLib.sol";
import {SettlementHarness} from "../helpers/SettlementHarness.sol";

contract HashLibTest is Test {
    function test_commitMoveZeroesTargetForNonAttack() public pure {
        bytes32 salt = keccak256("salt");
        bytes32 hide = HashLib.commitMove(bytes32(uint256(1)), 1, 0, 3, 7, salt);
        bytes32 hideZero = HashLib.commitMove(bytes32(uint256(1)), 1, 0, 3, 0, salt);
        assertEq(hide, hideZero);

        bytes32 attack = HashLib.commitMove(bytes32(uint256(1)), 1, 0, 1, 7, salt);
        assertTrue(attack != hide);
    }

    function test_historyChainIsOrderSensitive() public pure {
        bytes32 seed = HashLib.historySeed(bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        bytes32 a = keccak256("round-a");
        bytes32 b = keccak256("round-b");
        assertTrue(HashLib.chainHistory(HashLib.chainHistory(seed, a), b) != HashLib.chainHistory(HashLib.chainHistory(seed, b), a));
    }

    function test_drawBpsInRangeAndDeterministic() public pure {
        bytes32 seed = keccak256("seed");
        uint256 first = HashLib.drawBps(seed, 4, 1);
        uint256 again = HashLib.drawBps(seed, 4, 1);
        uint256 other = HashLib.drawBps(seed, 4, 2);
        assertEq(first, again);
        assertTrue(first != other);
        assertTrue(first < 10_000);
        assertTrue(other < 10_000);
    }

    /// @dev Frozen vectors shared with `packages/protocol/test/parity.test.ts`.
    ///      If an encoding drifts on either side, exactly one suite fails.
    function test_defaultRulesHashMatchesTypeScript() public pure {
        assertEq(
            HashLib.hashRules(4, 8, 100, 34, 20, 6000, 3000, 5000, 2, 6, 30),
            0xecd9fc8f0491a1bdbb67dec6eb01afb553aab4aed819d2dc3ce9531b63188dcf
        );
    }

    function test_commitMoveMatchesTypeScript() public pure {
        bytes32 commitment = HashLib.commitMove(
            keccak256("match"), 3, 2, HashLib.ACTION_ATTACK, 5, keccak256("salt")
        );
        assertEq(commitment, 0xfdceee9c106ff31a867d56723ef84165171e63afe5797667d11127ede92df028);
    }

    function test_deriveMatchIdMatchesEscrowFormula() public pure {
        bytes32 id = HashLib.deriveMatchId(11155111, address(0xabc), 0);
        assertEq(id, keccak256(abi.encode(uint256(11155111), address(0xabc), uint256(0))));
    }
}
