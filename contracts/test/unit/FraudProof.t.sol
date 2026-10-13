// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {HonestMatch} from "../helpers/HonestMatch.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {MatchVerifier} from "../../src/MatchVerifier.sol";
import {AttestorBonds} from "../../src/AttestorBonds.sol";
import {HashLib} from "../../src/libraries/HashLib.sol";
import {KernelLib} from "../../src/libraries/KernelLib.sol";

/// @dev The whole path: a result is proposed with its rounds, sits open to
///      challenge, and is either finalised or thrown out with its signers slashed.
contract FraudProofTest is Fixtures {
    address internal challenger;

    function setUp() public override {
        super.setUp();
        challenger = makeAddr("challenger");
    }

    function _liveMatch() internal returns (bytes32 matchId) {
        matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(0xF00D)));
    }

    function _signers() internal view returns (address[] memory signers) {
        signers = new address[](2);
        // Ascending, as `recoverAscending` returns them.
        (signers[0], signers[1]) = attestorA < attestorB ? (attestorA, attestorB) : (attestorB, attestorA);
    }

    /// @dev Re-roots a doctored log, as a dishonest quorum signing it would.
    function _reroot(bytes32 matchId, HonestMatch.Played memory played) internal view {
        bytes32 root = HashLib.historySeed(matchId, HashLib.hashRules(HashLib.defaultRules()), escrow.getMatch(matchId).seed);
        for (uint256 r = 0; r < played.rounds.length; ++r) {
            // forge-lint: disable-next-line(unsafe-typecast)
            root = HashLib.chainHistory(root, KernelLib.hashRound(uint32(r + 1), played.rounds[r]));
        }
        played.root = root;
    }

    function _challenge(bytes32 matchId, HonestMatch.Played memory played) internal {
        vm.prank(challenger);
        escrow.challenge(matchId, HashLib.defaultRules(), HonestMatch.log(played), _signers());
    }

    // --- An honest result ----------------------------------------------------

    function test_anHonestResultCannotBeChallenged() public {
        bytes32 matchId = _liveMatch();
        (HonestMatch.Played memory played, address[] memory ranking) = _honest(matchId);
        _propose(matchId, played, ranking);

        vm.prank(challenger);
        vm.expectRevert(GameEscrow.NoFraud.selector);
        escrow.challenge(matchId, HashLib.defaultRules(), HonestMatch.log(played), _signers());

        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        escrow.finalize(matchId, ranking);
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Settled));
    }

    function test_aResultWithoutItsRoundsIsRefused() public {
        bytes32 matchId = _liveMatch();
        (HonestMatch.Played memory played, address[] memory ranking) = _honest(matchId);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 rounds = uint32(played.rounds.length);
        bytes32 madeUp = keccak256("a root nobody can open");
        bytes memory sigs = _signResult(_twoAttestors(), matchId, rounds, madeUp, ranking);

        // Signed, but its rounds were never published: no challenge could ever
        // be built, so it is not accepted in the first place.
        vm.expectRevert(GameEscrow.LogMismatch.selector);
        escrow.settle(matchId, rounds, madeUp, ranking, sigs, HonestMatch.log(played));
    }

    // --- Fraud ---------------------------------------------------------------

    function test_aRankingTheRoundsDidNotProduceIsThrownOutAndSlashed() public {
        bytes32 matchId = _liveMatch();
        (HonestMatch.Played memory played, address[] memory ranking) = _honest(matchId);
        // The quorum pays the last-placed seat instead of the winner.
        (ranking[0], ranking[3]) = (ranking[3], ranking[0]);
        _propose(matchId, played, ranking);

        uint256 treasuryBefore = bonds.withdrawable(treasury);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit GameEscrow.FraudProven(matchId, challenger, MatchVerifier.Verdict.Valid, 0);
        _challenge(matchId, played);

        // Both signers lose their whole bond; the challenger takes 20%.
        assertEq(bonds.bondOf(attestorA), 0);
        assertEq(bonds.bondOf(attestorB), 0);
        assertEq(bonds.bondOf(attestorC), BOND, "a non-signer keeps its bond");
        assertEq(bonds.withdrawable(challenger), (2 * BOND * 2_000) / 10_000);
        assertEq(bonds.withdrawable(treasury) - treasuryBefore, 2 * BOND - (2 * BOND * 2_000) / 10_000);
        assertFalse(bonds.isActive(attestorA));

        // Every stake comes back; nothing is paid on the fraudulent ranking.
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Cancelled));
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(escrow.withdrawable(players[i]), STAKE);
        }
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(address(escrow).balance, escrow.totalOwed());

        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        vm.expectRevert(
            abi.encodeWithSelector(
                GameEscrow.WrongStatus.selector, matchId, GameEscrow.MatchStatus.Proposed, GameEscrow.MatchStatus.Cancelled
            )
        );
        escrow.finalize(matchId, ranking);
    }

    function test_aRoundWithAFabricatedOutcomeIsThrownOut() public {
        bytes32 matchId = _liveMatch();
        (HonestMatch.Played memory played,) = _honest(matchId);

        // The quorum keeps seat 0 alive a little longer than the storm allows,
        // then signs a root over its own version of events.
        played.rounds[0].hpAfter[0] += 7;
        _reroot(matchId, played);
        address[] memory ranking = escrow.getSeats(matchId);
        _propose(matchId, played, ranking);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit GameEscrow.FraudProven(matchId, challenger, MatchVerifier.Verdict.InvalidRound, 1);
        _challenge(matchId, played);
        assertEq(bonds.bondOf(attestorA), 0);
    }

    function test_aMatchStoppedEarlyIsThrownOut() public {
        bytes32 matchId = _liveMatch();
        (HonestMatch.Played memory played,) = _honest(matchId);
        assertGt(played.rounds.length, 1);
        KernelLib.Round[] memory cut = new KernelLib.Round[](1);
        cut[0] = played.rounds[0];
        played.rounds = cut;
        _reroot(matchId, played);
        _propose(matchId, played, escrow.getSeats(matchId));

        vm.expectEmit(true, true, false, true, address(escrow));
        emit GameEscrow.FraudProven(matchId, challenger, MatchVerifier.Verdict.WrongEnding, 1);
        _challenge(matchId, played);
    }

    // --- The rules of challenging -------------------------------------------

    function test_challengesNeedTheRightRulesSignersAndRounds() public {
        bytes32 matchId = _liveMatch();
        (HonestMatch.Played memory played, address[] memory ranking) = _honest(matchId);
        (ranking[0], ranking[1]) = (ranking[1], ranking[0]);
        _propose(matchId, played, ranking);

        HashLib.Rules memory otherRules = HashLib.defaultRules();
        otherRules.attackDamage += 1;
        vm.expectRevert(GameEscrow.RulesMismatch.selector);
        escrow.challenge(matchId, otherRules, HonestMatch.log(played), _signers());

        address[] memory wrongSigners = new address[](1);
        wrongSigners[0] = attestorC;
        vm.expectRevert(GameEscrow.SignersMismatch.selector);
        escrow.challenge(matchId, HashLib.defaultRules(), HonestMatch.log(played), wrongSigners);

        played.rounds[0].hpAfter[0] += 1;
        vm.expectRevert(GameEscrow.NotTheSignedRounds.selector);
        escrow.challenge(matchId, HashLib.defaultRules(), HonestMatch.log(played), _signers());
    }

    function test_theWindowCloses() public {
        bytes32 matchId = _liveMatch();
        (HonestMatch.Played memory played, address[] memory ranking) = _honest(matchId);
        (ranking[0], ranking[1]) = (ranking[1], ranking[0]);
        _propose(matchId, played, ranking);
        uint64 deadline = escrow.getMatch(matchId).challengeDeadline;

        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.ChallengeWindowClosed.selector, deadline));
        _challenge(matchId, played);
    }

    function test_aPauseHoldsNeitherAChallengeNorAFinalisedPayout() public {
        bytes32 matchId = _liveMatch();
        (HonestMatch.Played memory played, address[] memory ranking) = _honest(matchId);
        address[] memory forged = new address[](4);
        (forged[0], forged[1], forged[2], forged[3]) = (ranking[1], ranking[0], ranking[2], ranking[3]);
        _propose(matchId, played, forged);

        vm.prank(owner);
        escrow.pause();
        _challenge(matchId, played);
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Cancelled));
    }

    // --- Bonds and the quorum ------------------------------------------------

    function test_anUnbondingAttestorNoLongerCounts() public {
        bytes32 matchId = _liveMatch();
        (HonestMatch.Played memory played, address[] memory ranking) = _honest(matchId);
        vm.prank(attestorB);
        bonds.requestUnbond();

        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 rounds = uint32(played.rounds.length);
        bytes memory sigs = _signResult(_twoAttestors(), matchId, rounds, played.root, ranking);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.NotAnAttestor.selector, attestorB));
        escrow.settle(matchId, rounds, played.root, ranking, sigs, HonestMatch.log(played));
    }

    function test_onlyTheEscrowMaySlash() public {
        vm.expectRevert(abi.encodeWithSelector(AttestorBonds.NotSlasher.selector, address(this)));
        bonds.slash(attestorA, address(this));
    }
}
