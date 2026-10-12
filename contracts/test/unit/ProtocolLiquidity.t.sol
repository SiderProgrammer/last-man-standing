// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {LmsToken} from "../../src/governance/LmsToken.sol";
import {ProtocolLiquidity} from "../../src/governance/ProtocolLiquidity.sol";
import {PoolKey} from "../../src/interfaces/IPoolManager.sol";
import {MockPoolManager} from "../../src/mocks/MockPoolManager.sol";

contract ProtocolLiquidityTest is Test {
    uint24 private constant FEE = 3000;
    int24 private constant SPACING = 60;

    address private owner;
    address private funder;

    MockPoolManager private manager;
    LmsToken private lms;
    ProtocolLiquidity private pol;

    function setUp() public {
        owner = makeAddr("owner");
        funder = makeAddr("funder");
        vm.deal(funder, 100 ether);

        manager = new MockPoolManager();
        lms = new LmsToken(funder, 10_000_000e18);
        pol = new ProtocolLiquidity(manager, lms, owner, FEE, SPACING);

        vm.prank(funder);
        lms.approve(address(pol), type(uint256).max);
    }

    function test_fullRangeTicksForTheSpacing() public view {
        assertEq(pol.tickLower(), -887_220);
        assertEq(pol.tickUpper(), 887_220);
    }

    function test_bootstrap_createsPoolAtTheSuppliedRatio() public {
        vm.prank(funder);
        uint128 added = pol.bootstrap{value: 10 ether}(1_000_000e18);

        assertGt(added, 0);
        assertEq(pol.liquidity(), added);
        (uint256 rate,,) = manager.pools(keccak256(abi.encode(pol.poolKey())));
        assertApproxEqRel(rate, 100_000e18, 1e9, "100k LMS per ETH");
    }

    function test_bootstrap_spendsAtMostWhatWasGiven_andRefundsTheRest() public {
        uint256 ethBefore = funder.balance;
        uint256 lmsBefore = lms.balanceOf(funder);

        vm.prank(funder);
        pol.bootstrap{value: 10 ether}(1_000_000e18);

        uint256 ethSpent = ethBefore - funder.balance;
        uint256 lmsSpent = lmsBefore - lms.balanceOf(funder);
        assertLe(ethSpent, 10 ether);
        assertLe(lmsSpent, 1_000_000e18);
        assertApproxEqAbs(ethSpent, 10 ether, 1e6, "rounding dust only");
        assertApproxEqAbs(lmsSpent, 1_000_000e18, 1e12, "rounding dust only");
        assertEq(address(pol).balance, 0, "nothing stays behind");
        assertEq(lms.balanceOf(address(pol)), 0);
        assertEq(address(manager).balance, ethSpent);
    }

    function test_bootstrap_onlyOnce() public {
        vm.startPrank(funder);
        pol.bootstrap{value: 1 ether}(100_000e18);
        vm.expectRevert(MockPoolManager.PoolAlreadyInitialized.selector);
        pol.bootstrap{value: 1 ether}(100_000e18);
        vm.stopPrank();
    }

    function test_bootstrap_rejectsZeroAmounts() public {
        vm.startPrank(funder);
        vm.expectRevert(ProtocolLiquidity.ZeroAmount.selector);
        pol.bootstrap{value: 0}(1e18);
        vm.expectRevert(ProtocolLiquidity.ZeroAmount.selector);
        pol.bootstrap{value: 1 ether}(0);
        vm.stopPrank();
    }

    function test_removeLiquidity_ownerOnly_paysTheRecipient() public {
        vm.prank(funder);
        uint128 added = pol.bootstrap{value: 10 ether}(1_000_000e18);
        address to = makeAddr("to");

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, funder));
        vm.prank(funder);
        pol.removeLiquidity(added, to);

        vm.prank(owner);
        (uint256 ethOut, uint256 lmsOut) = pol.removeLiquidity(added / 2, to);

        assertApproxEqAbs(ethOut, 5 ether, 1e6);
        assertApproxEqAbs(lmsOut, 500_000e18, 1e12);
        assertEq(to.balance, ethOut);
        assertEq(lms.balanceOf(to), lmsOut);
        assertEq(pol.liquidity(), added - added / 2);
    }

    function test_removeLiquidity_boundedByWhatIsHeld() public {
        vm.prank(funder);
        uint128 added = pol.bootstrap{value: 1 ether}(100_000e18);

        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ProtocolLiquidity.InsufficientLiquidity.selector, added + 1, added)
        );
        pol.removeLiquidity(added + 1, owner);
        vm.expectRevert(ProtocolLiquidity.ZeroAmount.selector);
        pol.removeLiquidity(0, owner);
        vm.stopPrank();
    }

    function test_unlockCallback_onlyPoolManager() public {
        vm.expectRevert(abi.encodeWithSelector(ProtocolLiquidity.NotPoolManager.selector, address(this)));
        pol.unlockCallback("");
    }

    function test_poolKey_matchesTheRouterConvention() public view {
        PoolKey memory key = pol.poolKey();
        assertEq(key.currency0, address(0), "native ETH sorts first");
        assertEq(key.currency1, address(lms));
        assertEq(key.fee, FEE);
        assertEq(key.tickSpacing, SPACING);
        assertEq(key.hooks, address(0));
    }

    /// forge-config: default.fuzz.runs = 256
    function testFuzz_bootstrap_neverSpendsMoreThanGiven(uint96 eth, uint96 lmsAmount) public {
        eth = uint96(bound(eth, 1e12, 100 ether));
        lmsAmount = uint96(bound(lmsAmount, 1e15, 10_000_000e18));
        uint256 ethBefore = funder.balance;
        uint256 lmsBefore = lms.balanceOf(funder);

        vm.prank(funder);
        pol.bootstrap{value: eth}(lmsAmount);

        assertLe(ethBefore - funder.balance, eth);
        assertLe(lmsBefore - lms.balanceOf(funder), lmsAmount);
        assertEq(address(pol).balance, 0);
    }
}
