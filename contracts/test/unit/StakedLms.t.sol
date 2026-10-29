// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {LmsToken} from "../../src/governance/LmsToken.sol";
import {StakedLms} from "../../src/governance/StakedLms.sol";
import {NothingToWithdraw, ZeroAddress} from "../../src/Errors.sol";

contract StakedLmsTest is Test {
    uint64 private constant COOLDOWN = 7 days;
    uint64 private constant DURATION = 7 days;
    /// @dev Wei lost to integer division across a whole reward period.
    uint256 private constant DUST = 10;
    uint256 private constant CAROL_PK = 0xCA401;

    address private owner;
    address private alice;
    address private bob;

    LmsToken private lms;
    StakedLms private vault;

    function setUp() public {
        owner = makeAddr("owner");
        alice = makeAddr("alice");
        bob = makeAddr("bob");

        lms = new LmsToken(address(this), 1_000_000e18);
        vault = new StakedLms(lms, owner, COOLDOWN, DURATION);

        lms.transfer(alice, 1_000e18);
        lms.transfer(bob, 1_000e18);
        vm.prank(alice);
        lms.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        lms.approve(address(vault), type(uint256).max);
        vm.deal(address(this), 100 ether);
    }

    // --- Votes -------------------------------------------------------------

    function test_deposit_selfDelegatesSoStakingAloneVotes() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(100e18, alice);

        assertEq(shares, 100e18);
        assertEq(vault.delegates(alice), alice);
        assertEq(vault.getVotes(alice), 100e18);
    }

    function test_existingDelegateIsKept() public {
        vm.startPrank(alice);
        vault.deposit(100e18, alice);
        vault.delegate(bob);
        vault.deposit(50e18, alice);
        vm.stopPrank();

        assertEq(vault.delegates(alice), bob);
        assertEq(vault.getVotes(bob), 150e18);
        assertEq(vault.getVotes(alice), 0);
    }

    function test_transfer_movesVotes() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);
        vm.prank(alice);
        vault.transfer(bob, 40e18);

        assertEq(vault.getVotes(alice), 60e18);
        assertEq(vault.getVotes(bob), 40e18);
    }

    function test_clockIsTimestamp_andPastVotesAreSnapshotted() public {
        assertEq(vault.clock(), block.timestamp);
        assertEq(vault.CLOCK_MODE(), "mode=timestamp");

        vm.prank(alice);
        vault.deposit(100e18, alice);
        uint256 staked = block.timestamp;

        vm.warp(staked + 1);
        vm.prank(alice);
        vault.requestUnstake(100e18);

        vm.warp(staked + 2);
        assertEq(vault.getPastVotes(alice, staked), 100e18, "a past snapshot keeps the vote");
        assertEq(vault.getVotes(alice), 0, "unstaking drops the vote at once");
    }

    // --- One sLMS is one LMS -------------------------------------------------

    function test_aDirectTransferDoesNotMoveTheRate_andCanBeSwept() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);
        lms.transfer(address(vault), 50e18); // a mistake, or a donation attack

        assertEq(vault.totalAssets(), 100e18);
        assertEq(vault.convertToAssets(100e18), 100e18);
        vm.prank(bob);
        assertEq(vault.deposit(100e18, bob), 100e18, "the next staker gets one share per LMS");

        address to = makeAddr("to");
        vm.prank(owner);
        assertEq(vault.sweepStray(to), 50e18);
        assertEq(lms.balanceOf(to), 50e18);
        assertEq(lms.balanceOf(address(vault)), 200e18, "staked LMS untouched");
    }

    function test_sweepStray_cannotTouchStakedOrUnstaking() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);
        vm.prank(alice);
        vault.requestUnstake(40e18);

        vm.startPrank(owner);
        vm.expectRevert(NothingToWithdraw.selector);
        vault.sweepStray(owner);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        vault.sweepStray(alice);
    }

    // --- Rewards -------------------------------------------------------------

    function test_rewards_splitProRataAcrossStakers() public {
        vm.prank(alice);
        vault.deposit(300e18, alice);
        vm.prank(bob);
        vault.deposit(100e18, bob);

        vault.depositRewards{value: 4 ether}();
        vm.warp(block.timestamp + DURATION);

        assertApproxEqAbs(vault.earned(alice), 3 ether, DUST);
        assertApproxEqAbs(vault.earned(bob), 1 ether, DUST);
    }

    function test_rewards_arePaidOutEvenlyOverTheDuration() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);
        vault.depositRewards{value: 7 ether}();

        assertEq(vault.earned(alice), 0, "nothing at the moment of the deposit");
        vm.warp(block.timestamp + DURATION / 7);
        assertApproxEqAbs(vault.earned(alice), 1 ether, DUST);
        vm.warp(block.timestamp + DURATION);
        assertApproxEqAbs(vault.earned(alice), 7 ether, DUST, "and nothing more once the stream runs dry");
    }

    /// @dev The attack the stream exists for: stake, harvest and claim in one
    ///      transaction, then leave. Paid out at once, the harvest would have
    ///      split evenly between Bob and Alice, who had been staked all along.
    function test_rewards_stakingRightBeforeAHarvestEarnsOnlyForTheTimeStaked() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);
        vm.warp(block.timestamp + 30 days);
        vm.deal(bob, 2 ether);

        vm.startPrank(bob);
        vault.deposit(100e18, bob);
        vault.depositRewards{value: 2 ether}();
        assertEq(vault.earned(bob), 0);
        vault.requestUnstake(100e18);
        vm.stopPrank();

        vm.warp(block.timestamp + DURATION);
        assertEq(vault.earned(bob), 0);
        assertApproxEqAbs(vault.earned(alice), 2 ether, DUST);
    }

    function test_rewards_aLateStakerSharesOnlyWhatIsLeft() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);
        vault.depositRewards{value: 2 ether}();
        vm.warp(block.timestamp + DURATION / 2);

        vm.prank(bob);
        vault.deposit(100e18, bob);
        vm.warp(block.timestamp + DURATION / 2);

        assertApproxEqAbs(vault.earned(alice), 1.5 ether, DUST);
        assertApproxEqAbs(vault.earned(bob), 0.5 ether, DUST);
    }

    function test_rewards_aSecondDepositAddsToWhatIsStillUnpaid() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);
        vault.depositRewards{value: 1 ether}();
        vm.warp(block.timestamp + DURATION / 2);

        vault.depositRewards{value: 1 ether}();
        assertEq(vault.periodFinish(), block.timestamp + DURATION, "the period restarts");
        vm.warp(block.timestamp + DURATION / 2);
        assertApproxEqAbs(vault.earned(alice), 0.5 ether + 0.75 ether, DUST);

        vm.warp(block.timestamp + DURATION);
        assertApproxEqAbs(vault.earned(alice), 2 ether, DUST);
    }

    function test_rewards_withNobodyStaked_theStreamPausesForTheFirstStakers() public {
        vault.depositRewards{value: 1 ether}();
        vm.warp(block.timestamp + 3 * DURATION);

        vm.prank(alice);
        vault.deposit(100e18, alice);
        assertEq(
            vault.periodFinish(), block.timestamp + DURATION, "none of it ran out while nobody was staked"
        );

        vm.warp(block.timestamp + DURATION);
        assertApproxEqAbs(vault.earned(alice), 1 ether, DUST);
    }

    function test_rewards_pauseWhenEveryoneLeaves_andResumeForTheNextStaker() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);
        vault.depositRewards{value: 2 ether}();
        vm.warp(block.timestamp + DURATION / 2);

        vm.prank(alice);
        vault.requestUnstake(100e18);
        vm.warp(block.timestamp + 10 days);

        vm.prank(bob);
        vault.deposit(100e18, bob);
        vm.warp(block.timestamp + DURATION);

        assertApproxEqAbs(vault.earned(alice), 1 ether, DUST);
        assertApproxEqAbs(vault.earned(bob), 1 ether, DUST);
    }

    function test_rewards_earnedBeforeATransferStayWithTheSender() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);
        vault.depositRewards{value: 2 ether}();
        vm.warp(block.timestamp + DURATION / 2);

        vm.prank(alice);
        vault.transfer(bob, 100e18);
        vm.warp(block.timestamp + DURATION / 2);

        assertApproxEqAbs(vault.earned(alice), 1 ether, DUST);
        assertApproxEqAbs(vault.earned(bob), 1 ether, DUST);
    }

    function test_rewards_unstakingKeepsWhatWasEarned_andTheCooldownEarnsNothing() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);
        vm.prank(bob);
        vault.deposit(100e18, bob);
        vault.depositRewards{value: 2 ether}();
        vm.warp(block.timestamp + DURATION / 2);

        vm.prank(alice);
        vault.requestUnstake(100e18);
        vm.warp(block.timestamp + DURATION / 2);

        assertApproxEqAbs(vault.earned(alice), 0.5 ether, DUST);
        assertApproxEqAbs(vault.earned(bob), 1.5 ether, DUST);
    }

    function test_constructor_boundsTheRewardDuration() public {
        uint64 tooShort = vault.MIN_REWARD_DURATION() - 1;
        vm.expectRevert(abi.encodeWithSelector(StakedLms.RewardDurationOutOfRange.selector, tooShort));
        new StakedLms(lms, owner, COOLDOWN, tooShort);

        uint64 tooLong = vault.MAX_REWARD_DURATION() + 1;
        vm.expectRevert(abi.encodeWithSelector(StakedLms.RewardDurationOutOfRange.selector, tooLong));
        new StakedLms(lms, owner, COOLDOWN, tooLong);
    }

    function test_claimRewards_paysOnce() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);
        vault.depositRewards{value: 1 ether}();
        vm.warp(block.timestamp + DURATION);
        address to = makeAddr("to");

        vm.prank(alice);
        uint256 paid = vault.claimRewards(to);

        assertApproxEqAbs(paid, 1 ether, DUST);
        assertEq(to.balance, paid);
        assertEq(vault.earned(alice), 0);

        vm.prank(alice);
        vm.expectRevert(NothingToWithdraw.selector);
        vault.claimRewards(to);

        vm.prank(alice);
        vm.expectRevert(ZeroAddress.selector);
        vault.claimRewards(address(0));
    }

    /// forge-config: default.fuzz.runs = 256
    function testFuzz_rewards_neverPayMoreThanArrived(
        uint96 a,
        uint96 b,
        uint96 r1,
        uint96 r2,
        uint96 moved,
        uint32 gap1,
        uint32 gap2
    ) public {
        a = uint96(bound(a, 1, 1_000e18));
        b = uint96(bound(b, 1, 1_000e18));
        r1 = uint96(bound(r1, 0, 10 ether));
        r2 = uint96(bound(r2, 0, 10 ether));
        gap1 = uint32(bound(gap1, 0, 2 * DURATION));
        gap2 = uint32(bound(gap2, 0, 2 * DURATION));

        vm.prank(alice);
        vault.deposit(a, alice);
        vm.prank(bob);
        vault.deposit(b, bob);
        vault.depositRewards{value: r1}();
        vm.warp(block.timestamp + gap1);
        moved = uint96(bound(moved, 0, a));
        vm.prank(alice);
        vault.transfer(bob, moved);
        vault.depositRewards{value: r2}();
        vm.warp(block.timestamp + gap2);

        assertLe(vault.earned(alice) + vault.earned(bob), uint256(r1) + r2, "never more than arrived");

        vm.warp(block.timestamp + DURATION);
        assertGe(
            vault.earned(alice) + vault.earned(bob) + DUST, uint256(r1) + r2, "only rounding dust is lost"
        );
        assertEq(address(vault).balance, uint256(r1) + r2);
    }

    // --- Unstake -----------------------------------------------------------

    function test_requestUnstake_burnsSharesAndQueuesTheLms() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);

        vm.prank(alice);
        uint256 assets = vault.requestUnstake(40e18);

        assertEq(assets, 40e18);
        assertEq(vault.balanceOf(alice), 60e18);
        assertEq(vault.totalStaked(), 60e18);
        assertEq(vault.totalUnstaking(), 40e18);
        (uint128 pending, uint64 unlockAt) = vault.unstakeOf(alice);
        assertEq(pending, 40e18);
        assertEq(unlockAt, block.timestamp + COOLDOWN);
    }

    function test_claim_onlyAfterCooldown() public {
        vm.startPrank(alice);
        vault.deposit(100e18, alice);
        vault.requestUnstake(100e18);

        vm.expectRevert(
            abi.encodeWithSelector(StakedLms.StillCoolingDown.selector, block.timestamp + COOLDOWN)
        );
        vault.claim(alice);

        vm.warp(block.timestamp + COOLDOWN);
        uint256 claimed = vault.claim(alice);
        vm.stopPrank();

        assertEq(claimed, 100e18);
        assertEq(lms.balanceOf(alice), 1_000e18);
        assertEq(vault.totalUnstaking(), 0);
    }

    function test_claim_revertsWithNothingPending() public {
        vm.expectRevert(StakedLms.NothingToClaim.selector);
        vm.prank(alice);
        vault.claim(alice);
    }

    function test_secondRequest_addsAndRestartsCooldown() public {
        vm.startPrank(alice);
        vault.deposit(100e18, alice);
        vault.requestUnstake(40e18);
        vm.warp(block.timestamp + 3 days);
        vault.requestUnstake(60e18);
        vm.stopPrank();

        (uint128 pending, uint64 unlockAt) = vault.unstakeOf(alice);
        assertEq(pending, 100e18);
        assertEq(unlockAt, block.timestamp + COOLDOWN);
    }

    function test_requestUnstake_rejectsZeroAndMoreThanBalance() public {
        vm.startPrank(alice);
        vault.deposit(100e18, alice);
        vm.expectRevert(StakedLms.ZeroShares.selector);
        vault.requestUnstake(0);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 100e18, 101e18)
        );
        vault.requestUnstake(101e18);
        vm.stopPrank();
    }

    function test_standardWithdrawAndRedeem_areDisabled() public {
        vm.startPrank(alice);
        vault.deposit(100e18, alice);
        assertEq(vault.maxWithdraw(alice), 0);
        assertEq(vault.maxRedeem(alice), 0);

        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, alice, 1, 0));
        vault.withdraw(1, alice, alice);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxRedeem.selector, alice, 1, 0));
        vault.redeem(1, alice, alice);
        vm.stopPrank();
    }

    // --- depositWithPermit --------------------------------------------------------

    function test_depositWithPermit_stakesInOneTransaction() public {
        address carol = vm.addr(CAROL_PK);
        lms.transfer(carol, 100e18);
        (uint8 v, bytes32 r, bytes32 s) = _permit(CAROL_PK, 100e18, block.timestamp);

        vm.prank(carol);
        uint256 shares = vault.depositWithPermit(100e18, carol, block.timestamp, v, r, s);

        assertEq(shares, 100e18);
        assertEq(vault.getVotes(carol), 100e18);
        assertEq(lms.allowance(carol, address(vault)), 0);
    }

    function test_depositWithPermit_survivesAFrontRunPermit() public {
        address carol = vm.addr(CAROL_PK);
        lms.transfer(carol, 100e18);
        (uint8 v, bytes32 r, bytes32 s) = _permit(CAROL_PK, 100e18, block.timestamp);
        // Someone copies the signature out of the mempool and submits it first.
        lms.permit(carol, address(vault), 100e18, block.timestamp, v, r, s);

        vm.prank(carol);
        assertEq(vault.depositWithPermit(100e18, carol, block.timestamp, v, r, s), 100e18);
    }

    function test_depositWithPermit_withABadSignatureAndNoAllowance_reverts() public {
        address carol = vm.addr(CAROL_PK);
        lms.transfer(carol, 100e18);
        (uint8 v, bytes32 r, bytes32 s) = _permit(CAROL_PK, 1e18, block.timestamp); // signed for less

        vm.prank(carol);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(vault), 0, 100e18
            )
        );
        vault.depositWithPermit(100e18, carol, block.timestamp, v, r, s);
    }

    // --- Governance ----------------------------------------------------------

    function test_setCooldown_ownerOnlyAndBounded() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        vault.setCooldown(14 days);

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(StakedLms.CooldownOutOfRange.selector, uint64(1 hours)));
        vault.setCooldown(1 hours);
        vm.expectRevert(abi.encodeWithSelector(StakedLms.CooldownOutOfRange.selector, uint64(31 days)));
        vault.setCooldown(31 days);
        vault.setCooldown(14 days);
        vm.stopPrank();
        assertEq(vault.cooldown(), 14 days);
    }

    function test_setCooldown_leavesPendingRequestsAlone() public {
        vm.startPrank(alice);
        vault.deposit(100e18, alice);
        vault.requestUnstake(100e18);
        vm.stopPrank();
        uint256 requestedAt = block.timestamp;

        vm.prank(owner);
        vault.setCooldown(30 days);

        (, uint64 unlockAt) = vault.unstakeOf(alice);
        assertEq(unlockAt, requestedAt + COOLDOWN);
    }

    function _permit(uint256 pk, uint256 value, uint256 deadline)
        private
        view
        returns (uint8, bytes32, bytes32)
    {
        address holder = vm.addr(pk);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                holder,
                address(vault),
                value,
                lms.nonces(holder),
                deadline
            )
        );
        return vm.sign(pk, keccak256(abi.encodePacked(hex"1901", lms.DOMAIN_SEPARATOR(), structHash)));
    }
}
