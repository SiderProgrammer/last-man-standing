// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Fixtures} from "../helpers/Fixtures.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {ProtocolConfig} from "../../src/ProtocolConfig.sol";
import {ExpiringPause} from "../../src/ExpiringPause.sol";
import {LmsToken} from "../../src/governance/LmsToken.sol";

/// @dev Paying part of a seat's fee in LMS: held against the seat, burned
///      when the match settles, refunded when it does not.
contract LmsDiscountTest is Fixtures {
    /// @dev 20,000 LMS buys 1 ETH off a fee.
    uint256 private constant RATE = 20_000e18;
    /// @dev 5% of the 1 ETH stake, and the most of it LMS may pay: half.
    uint256 private constant FEE = 0.05 ether;
    uint256 private constant MAX_OFF = 0.025 ether;
    /// @dev What buys `MAX_OFF`.
    uint256 private constant MAX_LMS = 500e18;
    uint256 private constant CAROL_PK = 0xCA401;

    LmsToken private lms;

    function setUp() public override {
        super.setUp();
        lms = new LmsToken(address(this), 1_000_000e18);
        vm.startPrank(owner);
        config.setLmsToken(address(lms));
        config.setLmsPerEthDiscount(RATE);
        vm.stopPrank();

        for (uint256 i = 0; i < players.length; ++i) {
            lms.transfer(players[i], 10_000e18);
            vm.prank(players[i]);
            lms.approve(address(escrow), type(uint256).max);
        }
    }

    // --- Quote and join ------------------------------------------------------

    function test_quote_paysForWhatItBuys_upToHalfTheFee() public {
        bytes32 matchId = _create();
        (uint256 off, uint256 used) = escrow.quoteLmsDiscount(matchId, 100e18);
        assertEq(off, 0.005 ether);
        assertEq(used, 100e18);

        (off, used) = escrow.quoteLmsDiscount(matchId, 2_000e18);
        assertEq(off, MAX_OFF, "capped at half the fee");
        assertEq(used, MAX_LMS, "and only what buys that is used");
    }

    function test_join_stakesLessEth_andHoldsTheLms() public {
        bytes32 matchId = _create();
        vm.prank(players[0]);
        escrow.joinWithLms{value: STAKE - MAX_OFF}(matchId, 2_000e18);

        assertEq(lms.balanceOf(players[0]), 10_000e18 - MAX_LMS);
        assertEq(lms.balanceOf(address(escrow)), MAX_LMS);
        assertEq(escrow.totalLmsEscrowed(), MAX_LMS);
        assertEq(escrow.totalEscrowed(), STAKE - MAX_OFF);
        GameEscrow.Discount memory seat = escrow.getSeatDiscount(matchId, players[0]);
        assertEq(seat.eth, MAX_OFF);
        assertEq(seat.lms, MAX_LMS);
        assertTrue(escrow.hasSeat(matchId, players[0]));
    }

    function test_join_wantsTheStakeLessTheDiscount() public {
        bytes32 matchId = _create();
        vm.prank(players[0]);
        vm.expectRevert(
            abi.encodeWithSelector(GameEscrow.IncorrectStake.selector, STAKE, uint128(STAKE - MAX_OFF))
        );
        escrow.joinWithLms{value: STAKE}(matchId, MAX_LMS);
    }

    function test_join_refusedWhileOff_orForNothing() public {
        bytes32 matchId = _create();
        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.NoDiscount.selector, 0));
        escrow.joinWithLms{value: STAKE}(matchId, 0);

        vm.prank(owner);
        config.setLmsPerEthDiscount(0);
        vm.prank(players[0]);
        vm.expectRevert(GameEscrow.DiscountOff.selector);
        escrow.joinWithLms{value: STAKE - MAX_OFF}(matchId, MAX_LMS);
    }

    function test_join_isPaused_likeAnyJoin() public {
        bytes32 matchId = _create();
        _pause();
        vm.prank(players[0]);
        vm.expectRevert(ExpiringPause.EnforcedPause.selector);
        escrow.joinWithLms{value: STAKE - MAX_OFF}(matchId, MAX_LMS);
    }

    function test_joinWithPermit_takesTheAllowanceFromASignature() public {
        address carol = vm.addr(CAROL_PK);
        vm.deal(carol, 10 ether);
        lms.transfer(carol, MAX_LMS);
        bytes32 matchId = _create();
        (uint8 v, bytes32 r, bytes32 s) = _permit(CAROL_PK, MAX_LMS, block.timestamp);

        vm.prank(carol);
        escrow.joinWithLmsPermit{value: STAKE - MAX_OFF}(matchId, MAX_LMS, block.timestamp, v, r, s);
        assertEq(lms.balanceOf(carol), 0);
        assertTrue(escrow.hasSeat(matchId, carol));
    }

    // --- Settled: burned -------------------------------------------------------

    /// @dev Players 0 and 1 pay half their fee in LMS; 2 and 3 pay in ETH.
    ///      The winner's prize is what it would have been without discounts;
    ///      the treasury's cut is smaller by them, and the LMS is burned.
    function test_finalize_burnsTheLms_theTreasuryTakesLess_andPrizesAreUnchanged() public {
        bytes32 matchId = _fillHalfDiscounted();
        uint256 supply = lms.totalSupply();
        _lockAndSeed(matchId, bytes32(uint256(1)));
        address[] memory ranking = _settleAndFinalize(matchId);

        assertEq(lms.totalSupply(), supply - 2 * MAX_LMS, "burned");
        assertEq(lms.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalLmsEscrowed(), 0);

        assertEq(escrow.withdrawable(ranking[0]), 4 * STAKE - 4 * FEE, "the whole pool less the full fees");
        assertEq(escrow.withdrawable(treasury), 4 * FEE - 2 * MAX_OFF, "less the two discounts");
        assertEq(address(escrow).balance, escrow.totalOwed() + escrow.totalEscrowed(), "solvent");
    }

    /// @dev Play-mining counts what a seat paid in ETH.
    function test_finalize_recordsNetFees() public {
        bytes32 matchId = _fillHalfDiscounted();
        _lockAndSeed(matchId, bytes32(uint256(1)));
        _settleAndFinalize(matchId);

        uint256 epoch = block.timestamp / escrow.FEE_EPOCH();
        assertEq(escrow.feesPaid(players[0], epoch), FEE - MAX_OFF);
        assertEq(escrow.feesPaid(players[3], epoch), FEE);
        assertEq(escrow.epochFees(epoch), 4 * FEE - 2 * MAX_OFF);
    }

    // --- Not settled: refunded ---------------------------------------------------

    function test_cancel_refundsWhatEachSeatPaid_ethAndLms() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 8);
        vm.prank(players[0]);
        escrow.joinWithLms{value: STAKE - MAX_OFF}(matchId, MAX_LMS);
        vm.prank(players[1]);
        escrow.join{value: STAKE}(matchId);

        vm.warp(block.timestamp + 1 hours);
        escrow.cancelMatch(matchId);

        assertEq(escrow.withdrawable(players[0]), STAKE - MAX_OFF);
        assertEq(lms.balanceOf(players[0]), 10_000e18, "the LMS is back");
        assertEq(escrow.withdrawable(players[1]), STAKE);
        assertEq(escrow.totalLmsEscrowed(), 0);
        assertEq(address(escrow).balance, escrow.totalOwed() + escrow.totalEscrowed());
    }

    function test_veto_refundsTheLmsToo() public {
        bytes32 matchId = _fillHalfDiscounted();
        uint256 supply = lms.totalSupply();
        _lockAndSeed(matchId, bytes32(uint256(1)));
        _propose(matchId, _rankingOf(matchId));

        vm.prank(owner);
        escrow.veto(matchId);
        assertEq(lms.balanceOf(players[0]), 10_000e18);
        assertEq(lms.balanceOf(players[1]), 10_000e18);
        assertEq(lms.totalSupply(), supply, "nothing burned");
        assertEq(escrow.withdrawable(players[0]), STAKE - MAX_OFF);
        assertEq(escrow.withdrawable(players[3]), STAKE);
    }

    // --- Config ------------------------------------------------------------------

    function test_config_tokenIsSetOnce_byTheOwner() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.LmsTokenAlreadySet.selector, address(lms)));
        config.setLmsToken(address(1));

        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, players[0]));
        config.setLmsPerEthDiscount(1);
    }

    /// @dev A rate change reaches seats taken after it, not before.
    function test_aRateChangeLeavesSeatsAlreadyTaken() public {
        bytes32 matchId = _create();
        vm.prank(players[0]);
        escrow.joinWithLms{value: STAKE - 0.005 ether}(matchId, 100e18);
        vm.prank(owner);
        config.setLmsPerEthDiscount(RATE / 2);

        assertEq(escrow.getSeatDiscount(matchId, players[0]).eth, 0.005 ether);
        (uint256 off,) = escrow.quoteLmsDiscount(matchId, 100e18);
        assertEq(off, 0.01 ether);
    }

    // --- Helpers -------------------------------------------------------------------

    function _create() private returns (bytes32 matchId) {
        vm.prank(players[0]);
        matchId = escrow.createMatch(STAKE, 4);
    }

    function _fillHalfDiscounted() private returns (bytes32 matchId) {
        matchId = _create();
        for (uint256 i = 0; i < 4; ++i) {
            vm.prank(players[i]);
            if (i < 2) escrow.joinWithLms{value: STAKE - MAX_OFF}(matchId, MAX_LMS);
            else escrow.join{value: STAKE}(matchId);
        }
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
                address(escrow),
                value,
                lms.nonces(holder),
                deadline
            )
        );
        return vm.sign(pk, keccak256(abi.encodePacked(hex"1901", lms.DOMAIN_SEPARATOR(), structHash)));
    }
}
