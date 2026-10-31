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

    // --- Frozen vectors shared with `packages/consensus/test/parity.test.ts` ---
    // If an encoding drifts on either side, exactly one suite fails.

    function test_defaultRulesHashMatchesTypeScript() public pure {
        assertEq(
            HashLib.hashRules(HashLib.defaultRules()),
            0x07d102f371d483468baf28515199dc3b888d3604c16f48ae909ab07145044d93
        );
    }

    function test_commitMoveMatchesTypeScript() public pure {
        bytes32 commitment =
            HashLib.commitMove(keccak256("match"), 3, 2, HashLib.ACTION_STRIKE, 5, keccak256("salt"));
        assertEq(commitment, 0xfdceee9c106ff31a867d56723ef84165171e63afe5797667d11127ede92df028);
    }

    function test_roundSeedMatchesTypeScript() public pure {
        bytes32 commitmentSet = HashLib.commitmentSetHash(_commitments());
        assertEq(commitmentSet, 0xf18d89b73a8eed2ced885c9152e679820bf8917ea67e7c46a681c6abe5573adc);
        bytes32 roundSeed = HashLib.roundSeed(keccak256("seed"), 3, commitmentSet);
        assertEq(roundSeed, 0x4d667135737ff4ad6b8b379f133a58cbc0bcca5690cfbb05e8015750afc1ad98);
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
            HashLib.hashRound(3, actions, targets, _salts(), _commitments(), hpAfter, eliminated),
            0xf0e024d960c9b3f12a0464761e7f50f2cec8ec60ccd49e62ccc83acd1829a3a3
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

    /// @dev Seat 1 committed, and did not reveal.
    function _commitments() private pure returns (bytes32[] memory commitments) {
        commitments = new bytes32[](3);
        commitments[0] = keccak256("c0");
        commitments[1] = keccak256("c1");
        commitments[2] = keccak256("c2");
    }
}
