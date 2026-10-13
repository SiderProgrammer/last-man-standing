// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {HashLib} from "../../src/libraries/HashLib.sol";

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
        uint256 first = HashLib.drawBps(seed, 1);
        uint256 again = HashLib.drawBps(seed, 1);
        uint256 other = HashLib.drawBps(seed, 2);
        assertEq(first, again);
        assertTrue(first != other);
        assertTrue(first < 10_000);
        assertTrue(other < 10_000);
    }

    // --- Frozen vectors shared with `packages/protocol/test/parity.test.ts` ---
    // If an encoding drifts on either side, exactly one suite fails.

    function test_defaultRulesHashMatchesTypeScript() public pure {
        assertEq(
            HashLib.hashRules(HashLib.defaultRules()),
            0x51f49b7b1499dec3d067b46387f9a171346327f29942d32497e74e995181c334
        );
    }

    function test_commitMoveMatchesTypeScript() public pure {
        bytes32 commitment = HashLib.commitMove(
            keccak256("match"), 3, 2, HashLib.ACTION_ATTACK, 5, keccak256("salt")
        );
        assertEq(commitment, 0xfdceee9c106ff31a867d56723ef84165171e63afe5797667d11127ede92df028);
    }

    function test_roundSeedAndDrawsMatchTypeScript() public pure {
        bytes32 roundSeed = HashLib.roundSeed(keccak256("seed"), 3, _salts());
        assertEq(roundSeed, 0x7e4cede4cdb60ef627f7567fdd7c76c76994dedca72d33a26b4e24a27ac577e2);
        assertEq(HashLib.drawBps(roundSeed, 1), 91);
        assertEq(HashLib.draw(roundSeed, 258), 0x35488afc3fef29f5171659d3e19c131674225566a149e03f8284036d4406df15);
    }

    function test_hashRoundMatchesTypeScript() public pure {
        uint8[] memory actions = new uint8[](3);
        actions[0] = 1;
        actions[2] = 2;
        uint8[] memory targets = new uint8[](3);
        targets[0] = 2;
        uint32[] memory hpAfter = new uint32[](3);
        hpAfter[0] = 95;
        hpAfter[2] = 66;
        uint8[] memory eliminated = new uint8[](1);
        eliminated[0] = 1;

        assertEq(
            HashLib.hashRound(3, actions, targets, _salts(), hpAfter, eliminated),
            0xf7eedecb9cbe6f45b5073a84a3ccd9768a9b16d1181979c49ae825f749ae94c4
        );
    }

    function test_deriveMatchIdMatchesEscrowFormula() public pure {
        bytes32 id = HashLib.deriveMatchId(11155111, address(0xabc), 0);
        assertEq(id, keccak256(abi.encode(uint256(11155111), address(0xabc), uint256(0))));
    }

    /// @dev Seat 1 did not reveal, so its salt is zero.
    function _salts() private pure returns (bytes32[] memory salts) {
        salts = new bytes32[](3);
        salts[0] = keccak256("s0");
        salts[2] = keccak256("s2");
    }
}
