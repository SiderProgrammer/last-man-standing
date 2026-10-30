// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {LmsToken} from "../../src/governance/LmsToken.sol";
import {LiquidityReserve} from "../../src/governance/LiquidityReserve.sol";
import {ZeroAddress} from "../../src/Errors.sol";

contract LiquidityReserveTest is Test {
    address private timelock = makeAddr("timelock");
    address private safe = makeAddr("safe");
    address private vault = makeAddr("vault");
    address private pool = makeAddr("pool");

    LmsToken private lms;
    LiquidityReserve private reserve;

    function setUp() public {
        lms = new LmsToken(address(this), 5_000_000e18);
        reserve = new LiquidityReserve(lms, safe, vault, timelock);
        lms.transfer(address(reserve), 5_000_000e18);
    }

    function test_constructor_rejectsZero() public {
        vm.expectRevert(ZeroAddress.selector);
        new LiquidityReserve(lms, safe, address(0), timelock);
    }

    function test_releasesOnlyToAnApprovedRecipient() public {
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(LiquidityReserve.RecipientNotApproved.selector, pool));
        reserve.release(pool, 1e18);

        vm.prank(timelock);
        reserve.setRecipient(pool, true);
        vm.prank(safe);
        reserve.release(pool, 1_000_000e18);
        assertEq(lms.balanceOf(pool), 1_000_000e18);

        vm.prank(timelock);
        reserve.release(pool, 1e18);
        assertEq(lms.balanceOf(pool), 1_000_001e18, "the timelock may release too");

        vm.prank(timelock);
        reserve.setRecipient(pool, false);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(LiquidityReserve.RecipientNotApproved.selector, pool));
        reserve.release(pool, 1e18);
    }

    function test_onlyTheSafeOrTheTimelockReleases() public {
        vm.prank(timelock);
        reserve.setRecipient(pool, true);
        vm.prank(pool);
        vm.expectRevert(abi.encodeWithSelector(LiquidityReserve.NotAllowed.selector, pool));
        reserve.release(pool, 1e18);
    }

    function test_onlyTheTimelockApproves() public {
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        reserve.setRecipient(pool, true);
    }

    /// @dev The plain routes to staking it: the vault, or the Safe, which would stake.
    function test_neverApprovesTheVaultTheSafeOrItself() public {
        address[4] memory refused = [vault, safe, address(reserve), address(0)];
        for (uint256 i = 0; i < refused.length; ++i) {
            vm.prank(timelock);
            vm.expectRevert(abi.encodeWithSelector(LiquidityReserve.CannotApprove.selector, refused[i]));
            reserve.setRecipient(refused[i], true);
        }
    }
}
