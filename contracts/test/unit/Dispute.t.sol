// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {ExpiringPause} from "../../src/ExpiringPause.sol";
import {DISPUTE_EXTENSION} from "../../src/Constants.sol";

/// @dev A seated player who finds the transcript does not support the result
///      disputes it: the payout waits `DISPUTE_EXTENSION` longer, and the
///      guardian vetoes or dismisses. If it does neither, the result finalises.
contract DisputeTest is Fixtures {
    address internal guardian;
    bytes32 internal constant EVIDENCE = keccak256("evidence");

    function setUp() public override {
        super.setUp();
        guardian = makeAddr("guardian");
        vm.prank(owner);
        config.setGuardian(guardian);
    }

    function _proposed() internal returns (bytes32 matchId, address[] memory ranking, uint40 deadline) {
        matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(0xD15)));
        ranking = _rankingOf(matchId);
        _propose(matchId, ranking);
        deadline = escrow.getMatch(matchId).deadline;
    }

    function test_aSeatedPlayerDisputesAndThePayoutWaits() public {
        (bytes32 matchId, address[] memory ranking, uint40 deadline) = _proposed();
        uint40 extended = deadline + uint40(DISPUTE_EXTENSION);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit GameEscrow.ResultDisputed(matchId, players[1], EVIDENCE, extended);
        vm.prank(players[1]);
        escrow.dispute(matchId, EVIDENCE);

        GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
        assertTrue(info.disputed);
        assertEq(info.deadline, extended);

        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.ChallengeWindowOpen.selector, extended));
        escrow.finalize(matchId, ranking);
    }

    /// @dev The liveness assumption: a silent guardian cannot hold a result forever.
    function test_aResultTheGuardianIgnoresFinalisesAfterTheExtension() public {
        (bytes32 matchId, address[] memory ranking, uint40 deadline) = _proposed();
        vm.prank(players[0]);
        escrow.dispute(matchId, EVIDENCE);

        vm.warp(uint256(deadline) + DISPUTE_EXTENSION);
        escrow.finalize(matchId, ranking);
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Settled));
    }

    function test_theGuardianCanVetoDuringTheExtension() public {
        (bytes32 matchId,, uint40 deadline) = _proposed();
        vm.prank(players[2]);
        escrow.dispute(matchId, EVIDENCE);

        // Past the challenge window it would have had, inside the extension.
        vm.warp(uint256(deadline) + 1 hours);
        vm.prank(guardian);
        escrow.veto(matchId);
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Cancelled));
        assertEq(escrow.withdrawable(players[2]), STAKE);
    }

    function test_anotherDisputeDoesNotExtendAgain() public {
        (bytes32 matchId,, uint40 deadline) = _proposed();
        vm.prank(players[0]);
        escrow.dispute(matchId, EVIDENCE);
        vm.prank(players[3]);
        escrow.dispute(matchId, keccak256("more evidence"));
        assertEq(escrow.getMatch(matchId).deadline, deadline + uint40(DISPUTE_EXTENSION));
    }

    function test_dismissingRestoresTheChallengeDeadline() public {
        (bytes32 matchId, address[] memory ranking, uint40 deadline) = _proposed();
        vm.prank(players[0]);
        escrow.dispute(matchId, EVIDENCE);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit GameEscrow.DisputeDismissed(matchId, guardian, deadline);
        vm.prank(guardian);
        escrow.dismissDispute(matchId);
        assertFalse(escrow.getMatch(matchId).disputed);
        assertEq(escrow.getMatch(matchId).deadline, deadline);

        // Another seat may still object before that deadline; the same one may not.
        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.AlreadyDisputed.selector, matchId, players[0]));
        escrow.dispute(matchId, EVIDENCE);
        vm.prank(players[1]);
        escrow.dispute(matchId, EVIDENCE);
        assertEq(escrow.getMatch(matchId).deadline, deadline + uint40(DISPUTE_EXTENSION));

        vm.prank(owner);
        escrow.dismissDispute(matchId);
        vm.warp(deadline);
        escrow.finalize(matchId, ranking);
    }

    /// @dev Dismissed after its own window has passed, a result may be paid at once.
    function test_aLateDismissalLetsTheResultFinaliseAtOnce() public {
        (bytes32 matchId, address[] memory ranking, uint40 deadline) = _proposed();
        vm.prank(players[0]);
        escrow.dispute(matchId, EVIDENCE);

        vm.warp(uint256(deadline) + 1 days);
        vm.prank(guardian);
        escrow.dismissDispute(matchId);
        assertEq(escrow.getMatch(matchId).deadline, block.timestamp);
        escrow.finalize(matchId, ranking);
    }

    function test_onlyASeatedPlayerMayDispute() public {
        (bytes32 matchId,,) = _proposed();
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.NotSeated.selector, matchId, stranger));
        escrow.dispute(matchId, EVIDENCE);
    }

    function test_aDisputeComesInsideTheChallengeWindow() public {
        (bytes32 matchId,, uint40 deadline) = _proposed();
        vm.warp(deadline);
        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.ChallengeWindowClosed.selector, deadline));
        escrow.dispute(matchId, EVIDENCE);
    }

    function test_onlyAProposedResultCanBeDisputed() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(0xD16)));
        vm.prank(players[0]);
        vm.expectRevert(
            abi.encodeWithSelector(
                GameEscrow.WrongStatus.selector,
                matchId,
                GameEscrow.MatchStatus.Proposed,
                GameEscrow.MatchStatus.Live
            )
        );
        escrow.dispute(matchId, EVIDENCE);
    }

    function test_onlyTheGuardianOrGovernanceDismisses() public {
        (bytes32 matchId,,) = _proposed();
        vm.prank(players[0]);
        escrow.dispute(matchId, EVIDENCE);
        vm.prank(players[0]);
        vm.expectRevert(ExpiringPause.NotGuardian.selector);
        escrow.dismissDispute(matchId);
    }

    function test_thereIsNothingToDismissWithoutADispute() public {
        (bytes32 matchId,,) = _proposed();
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.NotDisputed.selector, matchId));
        escrow.dismissDispute(matchId);
    }

    /// @dev A pause must never stop a player objecting in time.
    function test_aPauseDoesNotStopADispute() public {
        (bytes32 matchId,,) = _proposed();
        _pause();
        vm.prank(players[0]);
        escrow.dispute(matchId, EVIDENCE);
        assertTrue(escrow.getMatch(matchId).disputed);
    }
}
