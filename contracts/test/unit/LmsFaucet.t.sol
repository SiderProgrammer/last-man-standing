// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {LmsToken} from "../../src/governance/LmsToken.sol";
import {StakedLms} from "../../src/governance/StakedLms.sol";
import {LmsFaucet} from "../../src/governance/LmsFaucet.sol";
import {ZeroAddress} from "../../src/Errors.sol";

contract LmsFaucetTest is Test {
    uint256 private constant LIQUID = 10_000e18;
    uint256 private constant STAKED = 40_000e18;

    address private timelock = makeAddr("timelock");
    address private alice = makeAddr("alice");
    address private bob = makeAddr("bob");

    LmsToken private lms;
    StakedLms private vault;
    LmsFaucet private faucet;

    function setUp() public {
        lms = new LmsToken(address(this), 1_000_000e18);
        vault = new StakedLms(lms, timelock, 10 days, 7 days);
        faucet = new LmsFaucet(lms, vault, LIQUID, STAKED);
        // Four scoops' worth, and a little over.
        lms.transfer(address(faucet), 4 * (LIQUID + STAKED) + 1e18);
    }

    function test_drip_sendsLiquidAndStakesTheRest_andTheVotesAreTheirs() public {
        vm.prank(bob);
        faucet.drip(alice);

        assertEq(lms.balanceOf(alice), LIQUID);
        assertEq(vault.balanceOf(alice), STAKED);
        assertEq(vault.getVotes(alice), STAKED, "staking self-delegates: the scoop votes at once");
        assertTrue(faucet.dripped(alice));
        assertEq(vault.balanceOf(address(faucet)), 0, "the faucet stakes nothing for itself");
    }

    function test_drip_emitsWhoAskedForWhom() public {
        vm.expectEmit(address(faucet));
        emit LmsFaucet.Dripped(alice, LIQUID, STAKED, bob);
        vm.prank(bob);
        faucet.drip(alice);
    }

    function test_drip_oncePerAddress() public {
        faucet.drip(alice);
        vm.expectRevert(abi.encodeWithSelector(LmsFaucet.AlreadyDripped.selector, alice));
        vm.prank(alice);
        faucet.drip(alice);
    }

    function test_drip_refusesZeroItselfAndTheVault() public {
        vm.expectRevert(ZeroAddress.selector);
        faucet.drip(address(0));
        vm.expectRevert(abi.encodeWithSelector(LmsFaucet.CannotDrip.selector, address(faucet)));
        faucet.drip(address(faucet));
        vm.expectRevert(abi.encodeWithSelector(LmsFaucet.CannotDrip.selector, address(vault)));
        faucet.drip(address(vault));
    }

    function test_drip_revertsWhenLessThanAScoopIsLeft() public {
        assertEq(faucet.scoopsLeft(), 4);
        for (uint256 i = 0; i < 4; ++i) {
            faucet.drip(vm.addr(i + 1));
        }
        assertEq(faucet.scoopsLeft(), 0);
        vm.expectRevert(abi.encodeWithSelector(LmsFaucet.FaucetEmpty.selector, 1e18, LIQUID + STAKED));
        faucet.drip(alice);
        assertFalse(faucet.dripped(alice), "a failed drip leaves the address free to try again");
    }

    function test_liquidOnly_orStakedOnly() public {
        LmsFaucet liquidOnly = new LmsFaucet(lms, vault, LIQUID, 0);
        lms.transfer(address(liquidOnly), LIQUID);
        liquidOnly.drip(alice);
        assertEq(lms.balanceOf(alice), LIQUID);
        assertEq(vault.balanceOf(alice), 0);

        LmsFaucet stakedOnly = new LmsFaucet(lms, vault, 0, STAKED);
        lms.transfer(address(stakedOnly), STAKED);
        stakedOnly.drip(bob);
        assertEq(lms.balanceOf(bob), 0);
        assertEq(vault.balanceOf(bob), STAKED);
    }

    function test_constructor_rejectsAnEmptyScoopZeroOrAnotherTokensVault() public {
        vm.expectRevert(LmsFaucet.EmptyScoop.selector);
        new LmsFaucet(lms, vault, 0, 0);

        vm.expectRevert(ZeroAddress.selector);
        new LmsFaucet(lms, StakedLms(address(0)), LIQUID, STAKED);

        LmsToken other = new LmsToken(address(this), 1e18);
        StakedLms otherVault = new StakedLms(other, timelock, 10 days, 7 days);
        vm.expectRevert(abi.encodeWithSelector(LmsFaucet.WrongVault.selector, address(otherVault)));
        new LmsFaucet(lms, otherVault, LIQUID, STAKED);
    }
}
