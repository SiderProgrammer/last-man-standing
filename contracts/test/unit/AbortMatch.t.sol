// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {Attest} from "../helpers/Attest.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {ProtocolConfig} from "../../src/ProtocolConfig.sol";

/// @dev A server that loses a live match — a restart drops the room — has the
///      quorum abort it so every stake comes back at once, instead of after
///      the settlement deadline.
///
///      Signatures are always built before `vm.expectRevert`: building them
///      makes external calls, and the cheatcode applies to the next one.
contract AbortMatchTest is Fixtures {
    function _abortSignatures(uint256[] memory pks, bytes32 matchId) internal view returns (bytes memory) {
        return Attest.signAscending(pks, _abortDigest(matchId));
    }

    function _abortDigest(bytes32 matchId) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(keccak256("MatchAbort(bytes32 matchId)"), matchId));
        return harness.toTypedDataHash(escrow.domainSeparator(), structHash);
    }

    function _one(uint256 pk) internal pure returns (uint256[] memory pks) {
        pks = new uint256[](1);
        pks[0] = pk;
    }

    /// @dev Who one packed `r ‖ s ‖ v` signature recovers to over `digest`.
    function _recover(bytes32 digest, bytes memory signature) internal pure returns (address) {
        (bytes32 r, bytes32 s) = abi.decode(signature, (bytes32, bytes32));
        return ecrecover(digest, uint8(signature[64]), r, s);
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
        emit GameEscrow.MatchCancelled(matchId, GameEscrow.CancelReason.AbortedByAttestors);
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

        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.QuorumNotMet.selector, uint256(1), uint32(2)));
        escrow.abortMatch(matchId, sigs);
    }

    /// @dev A match keeps the attestor set it locked under: removing a key
    ///      changes only the matches that lock afterwards.
    function test_aRemovedAttestorCountsOnlyForMatchesLockedBefore() public {
        bytes32 before = _liveMatch();
        vm.prank(owner);
        config.setAttestorSet(_attestors(attestorA, attestorC, makeAddr("new")), 2);
        bytes32 afterwards = _liveMatch();

        escrow.abortMatch(before, _abortSignatures(_twoAttestors(), before));
        assertEq(uint8(escrow.getMatch(before).status), uint8(GameEscrow.MatchStatus.Cancelled));

        bytes memory sigs = _abortSignatures(_twoAttestors(), afterwards);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.NotAnAttestor.selector, attestorB));
        escrow.abortMatch(afterwards, sigs);
    }

    /// @dev Signatures over one match recover to strangers against another.
    ///      They are ordered by what they recover to *against `matchId`*, so
    ///      they clear the ascending-signer check and the revert is about who
    ///      signed rather than an accident of address order.
    function test_anAbortIsForOneMatchOnly() public {
        bytes32 matchId = _liveMatch();
        bytes32 other = _createAndFill(4);
        _lockAndSeed(other, bytes32(uint256(0xAB1)));
        uint256[] memory pks = _twoAttestors();
        bytes memory first = _abortSignatures(_one(pks[0]), other);
        bytes memory second = _abortSignatures(_one(pks[1]), other);
        address a = _recover(_abortDigest(matchId), first);
        address b = _recover(_abortDigest(matchId), second);
        (bytes memory sigsForOther, address lowest) =
            a < b ? (bytes.concat(first, second), a) : (bytes.concat(second, first), b);

        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.NotAnAttestor.selector, lowest));
        escrow.abortMatch(matchId, sigsForOther);
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Live));
    }

    function test_onlyALiveMatchCanBeAborted() public {
        vm.prank(players[0]);
        bytes32 open = escrow.createMatch(STAKE, 4);
        bytes memory openSigs = _abortSignatures(_twoAttestors(), open);
        vm.expectRevert(
            abi.encodeWithSelector(
                GameEscrow.WrongStatus.selector,
                open,
                GameEscrow.MatchStatus.Live,
                GameEscrow.MatchStatus.Open
            )
        );
        escrow.abortMatch(open, openSigs);

        // Nor one that already has a result: that one has its own path.
        bytes32 settled = _liveMatch();
        _settleAndFinalize(settled);
        bytes memory settledSigs = _abortSignatures(_twoAttestors(), settled);
        vm.expectRevert(
            abi.encodeWithSelector(
                GameEscrow.WrongStatus.selector,
                settled,
                GameEscrow.MatchStatus.Live,
                GameEscrow.MatchStatus.Settled
            )
        );
        escrow.abortMatch(settled, settledSigs);
    }
}
