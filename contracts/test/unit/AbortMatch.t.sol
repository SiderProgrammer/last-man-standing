// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {Attest} from "../helpers/Attest.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";

/// @dev A server that loses a live match — a restart drops the room — has the
///      quorum abort it so every stake comes back at once, instead of after
///      the settlement deadline.
///
///      Signatures are always built before `vm.expectRevert`: building them
///      makes external calls, and the cheatcode applies to the next one.
contract AbortMatchTest is Fixtures {
    function _abortSignatures(uint256[] memory pks, bytes32 matchId) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(keccak256("MatchAbort(bytes32 matchId)"), matchId));
        return Attest.signAscending(pks, harness.toTypedDataHash(escrow.domainSeparator(), structHash));
    }

    function _liveMatch() internal returns (bytes32 matchId) {
        matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(0xAB0)));
    }

    function test_aQuorumAbortsALiveMatchAndEveryoneIsRefundedAtOnce() public {
        bytes32 matchId = _liveMatch();
        // Well before the settlement deadline, when `cancelMatch` would refuse.
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.CannotCancelYet.selector, matchId));
        escrow.cancelMatch(matchId);

        bytes memory sigs = _abortSignatures(_twoAttestors(), matchId);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit GameEscrow.MatchCancelled(matchId, "aborted by attestors");
        escrow.abortMatch(matchId, sigs);

        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Cancelled));
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(escrow.withdrawable(players[i]), STAKE);
        }
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(address(escrow).balance, escrow.totalOwed());
    }

    function test_oneAttestorIsNotAQuorum() public {
        bytes32 matchId = _liveMatch();
        uint256[] memory one = new uint256[](1);
        one[0] = ATTESTOR_PK_A;
        bytes memory sigs = _abortSignatures(one, matchId);

        vm.expectRevert(abi.encodeWithSelector(GameEscrow.QuorumNotMet.selector, uint256(1), uint32(2)));
        escrow.abortMatch(matchId, sigs);
    }

    function test_anUnbondedSignerDoesNotCount() public {
        bytes32 matchId = _liveMatch();
        vm.prank(attestorB);
        bonds.requestUnbond();
        bytes memory sigs = _abortSignatures(_twoAttestors(), matchId);

        vm.expectRevert(abi.encodeWithSelector(GameEscrow.NotAnAttestor.selector, attestorB));
        escrow.abortMatch(matchId, sigs);
    }

    /// @dev Signatures over one match recover to strangers against another.
    function test_anAbortIsForOneMatchOnly() public {
        bytes32 matchId = _liveMatch();
        bytes32 other = _createAndFill(4);
        _lockAndSeed(other, bytes32(uint256(0xAB1)));
        bytes memory sigsForOther = _abortSignatures(_twoAttestors(), other);

        vm.expectRevert();
        escrow.abortMatch(matchId, sigsForOther);
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Live));
    }

    function test_onlyALiveMatchCanBeAborted() public {
        vm.prank(players[0]);
        bytes32 open = escrow.createMatch(STAKE, 4);
        bytes memory openSigs = _abortSignatures(_twoAttestors(), open);
        vm.expectRevert(
            abi.encodeWithSelector(
                GameEscrow.WrongStatus.selector, open, GameEscrow.MatchStatus.Live, GameEscrow.MatchStatus.Open
            )
        );
        escrow.abortMatch(open, openSigs);

        // Nor one that already has a result: that one has its own path.
        bytes32 settled = _liveMatch();
        _settleAndFinalize(settled);
        bytes memory settledSigs = _abortSignatures(_twoAttestors(), settled);
        vm.expectRevert(
            abi.encodeWithSelector(
                GameEscrow.WrongStatus.selector, settled, GameEscrow.MatchStatus.Live, GameEscrow.MatchStatus.Settled
            )
        );
        escrow.abortMatch(settled, settledSigs);
    }
}
