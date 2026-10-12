// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {LmsToken} from "../../src/governance/LmsToken.sol";
import {StakedLms} from "../../src/governance/StakedLms.sol";

contract StakedLmsTest is Test {
    uint64 private constant COOLDOWN = 7 days;

    address private owner;
    address private alice;
    address private bob;
    address private dead = address(0xdEaD);

    LmsToken private lms;
    StakedLms private vault;

    function setUp() public {
        owner = makeAddr("owner");
        alice = makeAddr("alice");
        bob = makeAddr("bob");

        lms = new LmsToken(address(this), 1_000_000e18);
        vault = new StakedLms(lms, owner, COOLDOWN);

        // The seed `Deploy` makes before anyone else can deposit.
        lms.approve(address(vault), type(uint256).max);
        vault.deposit(1e18, dead);

        lms.transfer(alice, 1_000e18);
        lms.transfer(bob, 1_000e18);
        vm.prank(alice);
        lms.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        lms.approve(address(vault), type(uint256).max);
    }

    // --- Votes -------------------------------------------------------------

    function test_deposit_selfDelegatesSoStakingAloneVotes() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(100e18, alice);

        assertEq(shares, 100e18);
        assertEq(vault.delegates(alice), alice);
        assertEq(vault.getVotes(alice), 100e18);
        assertEq(lms.balanceOf(alice), 900e18, "plain LMS has no votes to speak of");
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

    // --- depositWithPermit --------------------------------------------------------

    uint256 private constant CAROL_PK = 0xCA401;

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
        uint256 shares = vault.depositWithPermit(100e18, carol, block.timestamp, v, r, s);

        assertEq(shares, 100e18);
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

    // --- Yield -------------------------------------------------------------

    function test_donation_raisesShareValue() public {
        vm.prank(alice);
        vault.deposit(99e18, alice);
        // 100 LMS staked in total, 100 shares. Fees buy 50 LMS into the vault.
        lms.transfer(address(vault), 50e18);

        assertEq(vault.totalAssets(), 150e18);
        assertApproxEqAbs(vault.convertToAssets(99e18), 148.5e18, 1);

        // A later depositor buys in at the new price and gets fewer shares.
        vm.prank(bob);
        uint256 shares = vault.deposit(150e18, bob);
        assertApproxEqAbs(shares, 100e18, 1);
    }

    // --- Unstake -----------------------------------------------------------

    function test_requestUnstake_burnsSharesAndLocksAssetsAtCurrentPrice() public {
        vm.prank(alice);
        vault.deposit(99e18, alice);
        lms.transfer(address(vault), 100e18); // 200 LMS over 100 shares

        vm.prank(alice);
        uint256 assets = vault.requestUnstake(99e18);

        assertApproxEqAbs(assets, 198e18, 2);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(vault.totalUnstaking(), assets);
        (uint128 pending, uint64 unlockAt) = vault.unstakeOf(alice);
        assertEq(pending, assets);
        assertEq(unlockAt, block.timestamp + COOLDOWN);

        // Fees that arrive during the cooldown go to whoever stayed.
        lms.transfer(address(vault), 10e18);
        (pending,) = vault.unstakeOf(alice);
        assertEq(pending, assets, "locked amount does not grow");
        assertApproxEqAbs(vault.totalAssets(), 12e18, 1, "dead seed's 2 LMS + the new 10");
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
        (uint128 pending,) = vault.unstakeOf(alice);
        assertEq(pending, 0);
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

    // --- Accounting ------------------------------------------------------------

    /// forge-config: default.fuzz.runs = 256
    function testFuzz_vaultAlwaysHoldsWhatItOwes(uint96 a, uint96 b, uint96 fee, uint96 out) public {
        a = uint96(bound(a, 1, 1_000e18));
        b = uint96(bound(b, 1, 1_000e18));
        fee = uint96(bound(fee, 0, 1_000e18));

        vm.prank(alice);
        uint256 sharesA = vault.deposit(a, alice);
        vm.prank(bob);
        vault.deposit(b, bob);
        lms.transfer(address(vault), fee);

        out = uint96(bound(out, 1, sharesA));
        vm.prank(alice);
        vault.requestUnstake(out);

        assertEq(lms.balanceOf(address(vault)), vault.totalAssets() + vault.totalUnstaking());
        // Whoever stays can still redeem everything left, rounding in the vault's favour.
        assertLe(vault.convertToAssets(vault.totalSupply()), vault.totalAssets());
    }
}
