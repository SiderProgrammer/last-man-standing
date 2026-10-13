// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {AttestorBonds} from "../../src/AttestorBonds.sol";

contract AttestorBondsTest is Fixtures {
    function test_aBondedAllowlistedAttestorIsActive() public view {
        assertTrue(bonds.isActive(attestorA));
        // Bonded but not on the allowlist: not an attestor at all.
        assertFalse(bonds.isActive(players[0]));
    }

    function test_anyoneMayFundABondButOnlyItsAttestorWithdraws() public {
        address attestor = makeAddr("fresh");
        vm.prank(owner);
        config.setAttestor(attestor, true);
        assertFalse(bonds.isActive(attestor));

        vm.prank(players[0]);
        bonds.bond{value: BOND}(attestor);
        assertTrue(bonds.isActive(attestor));

        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(AttestorBonds.NotUnbonding.selector, players[0]));
        bonds.unbond();
    }

    /// @dev The exit clock covers the challenge window, so every result the
    ///      attestor signed has closed its window before the bond can leave.
    function test_unbondingWaitsOutTheDelayAndTheChallengeWindow() public {
        vm.prank(attestorA);
        bonds.requestUnbond();
        assertFalse(bonds.isActive(attestorA), "stops counting at once");

        uint64 at = bonds.unbondAt(attestorA);
        assertEq(at, block.timestamp + 1 days + CHALLENGE_WINDOW);

        vm.warp(at - 1);
        vm.prank(attestorA);
        vm.expectRevert(abi.encodeWithSelector(AttestorBonds.StillUnbonding.selector, at));
        bonds.unbond();

        vm.warp(at);
        vm.prank(attestorA);
        bonds.unbond();
        assertEq(bonds.bondOf(attestorA), 0);
        assertEq(bonds.withdrawable(attestorA), BOND);

        uint256 before = attestorA.balance;
        bonds.withdrawFor(attestorA);
        assertEq(attestorA.balance, before + BOND);
    }

    function test_aPendingUnbondDoesNotProtectABondFromSlashing() public {
        vm.prank(attestorA);
        bonds.requestUnbond();
        vm.prank(owner);
        bonds.setSlasher(address(this), true);

        bonds.slash(attestorA, players[0]);
        assertEq(bonds.bondOf(attestorA), 0);
        assertEq(bonds.withdrawable(players[0]), (BOND * 2_000) / 10_000);

        vm.warp(block.timestamp + 30 days);
        vm.prank(attestorA);
        vm.expectRevert(abi.encodeWithSelector(AttestorBonds.NotUnbonding.selector, attestorA));
        bonds.unbond();
    }

    function test_raisingTheBondDropsUnderBondedAttestors() public {
        vm.prank(owner);
        bonds.setRequiredBond(BOND + 1);
        assertFalse(bonds.isActive(attestorA));

        bonds.bond{value: 1}(attestorA);
        assertTrue(bonds.isActive(attestorA));
    }

    function test_theChallengerShareIsBounded() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AttestorBonds.InvalidBps.selector, uint16(10_001)));
        bonds.setChallengerBps(10_001);
    }

    function test_balancesAlwaysCoverWhatIsOwedAndBonded() public {
        vm.prank(owner);
        bonds.setSlasher(address(this), true);
        bonds.slash(attestorB, players[1]);
        vm.prank(attestorC);
        bonds.requestUnbond();
        vm.warp(block.timestamp + 2 days);
        vm.prank(attestorC);
        bonds.unbond();

        uint256 bonded = bonds.bondOf(attestorA) + bonds.bondOf(attestorB) + bonds.bondOf(attestorC);
        assertEq(address(bonds).balance, bonded + bonds.totalOwed());
    }
}
