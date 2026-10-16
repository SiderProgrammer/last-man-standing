// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";

/// @dev A proposed result waits out the challenge window, during which the
///      guardian — or governance — may throw it out and refund every stake.
contract VetoTest is Fixtures {
    address internal guardian;

    function setUp() public override {
        super.setUp();
        guardian = makeAddr("guardian");
        vm.prank(owner);
        config.setGuardian(guardian);
    }

    function _proposed() internal returns (bytes32 matchId, address[] memory ranking) {
        matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(0x7E70)));
        ranking = _rankingOf(matchId);
        _propose(matchId, ranking);
    }

    function test_theGuardianVetoesAProposedResultAndEveryoneIsRefunded() public {
        (bytes32 matchId,) = _proposed();

        vm.expectEmit(true, true, false, true, address(escrow));
        emit GameEscrow.ResultVetoed(matchId, guardian);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit GameEscrow.MatchCancelled(matchId, "result vetoed");
        vm.prank(guardian);
        escrow.veto(matchId);

        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Cancelled));
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(escrow.withdrawable(players[i]), STAKE);
        }
        // No fee on a voided match.
        assertEq(escrow.withdrawable(treasury), 0);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(address(escrow).balance, escrow.totalOwed());
    }

    function test_aVetoedResultCanNeverBeFinalized() public {
        (bytes32 matchId, address[] memory ranking) = _proposed();
        vm.prank(guardian);
        escrow.veto(matchId);

        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        vm.expectRevert(
            abi.encodeWithSelector(
                GameEscrow.WrongStatus.selector,
                matchId,
                GameEscrow.MatchStatus.Proposed,
                GameEscrow.MatchStatus.Cancelled
            )
        );
        escrow.finalize(matchId, ranking);
    }

    function test_governanceMayVetoToo() public {
        (bytes32 matchId,) = _proposed();
        vm.prank(owner);
        escrow.veto(matchId);
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Cancelled));
    }

    function test_nobodyElseMayVeto() public {
        (bytes32 matchId,) = _proposed();
        // Not a player, not an attestor.
        vm.prank(players[1]);
        vm.expectRevert(GameEscrow.NotGuardian.selector);
        escrow.veto(matchId);
        vm.prank(attestorA);
        vm.expectRevert(GameEscrow.NotGuardian.selector);
        escrow.veto(matchId);
    }

    function test_theWindowClosesTheVeto() public {
        (bytes32 matchId, address[] memory ranking) = _proposed();
        uint64 deadline = escrow.getMatch(matchId).challengeDeadline;
        vm.warp(deadline);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.ChallengeWindowClosed.selector, deadline));
        escrow.veto(matchId);

        escrow.finalize(matchId, ranking);
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Settled));
    }

    function test_onlyAProposedResultCanBeVetoed() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(0x7E71)));
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(
                GameEscrow.WrongStatus.selector, matchId, GameEscrow.MatchStatus.Proposed, GameEscrow.MatchStatus.Live
            )
        );
        escrow.veto(matchId);
    }

    /// @dev A pause stops new play, never the veto that undoes a bad result.
    function test_aVetoWorksWhilePaused() public {
        (bytes32 matchId,) = _proposed();
        vm.startPrank(guardian);
        escrow.pause();
        escrow.veto(matchId);
        vm.stopPrank();
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Cancelled));
    }

    function test_finalizeNeedsTheProposedRanking() public {
        (bytes32 matchId, address[] memory ranking) = _proposed();
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        (ranking[0], ranking[1]) = (ranking[1], ranking[0]);
        vm.expectRevert(GameEscrow.RankingMismatch.selector);
        escrow.finalize(matchId, ranking);
    }
}
