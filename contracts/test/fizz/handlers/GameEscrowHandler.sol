// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";
import {SEQUENCER_GRACE_PERIOD} from "../../../src/Constants.sol";

/// @notice Handles the interaction with GameEscrow: the match lifecycle.
abstract contract GameEscrowHandler is Properties {
    bytes32 private constant FIZZ_ROOT = keccak256("fizz-history");
    bytes32 private constant FIZZ_TRANSCRIPT = keccak256("fizz-transcript");

    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    function escrow_createMatch_clamped(uint256 actorSeed, uint256 stake, uint256 maxSeats) public {
        _useActor(actorSeed);
        (uint128 clampedStake, uint16 clampedSeats) = _lobbyTerms(stake, maxSeats);
        escrow_createMatch(clampedStake, clampedSeats);
    }

    /// @dev The smallest and largest lobby the config allows, at the smallest
    ///      stake: where a fee rounds down the most.
    function escrow_createMatch_minStake_clamped(uint256 actorSeed, bool largest) public {
        _useActor(actorSeed);
        ProtocolConfig.Params memory params = config.getParams();
        escrow_createMatch(params.minStake, largest ? params.maxSeats : params.minSeats);
    }

    /// @dev A roster of the actors `mask` picks, at least four of them.
    function escrow_createMatchmade_clamped(uint256 mask, uint256 stake, uint256 maxSeats) public {
        (uint128 clampedStake, uint16 clampedSeats) = _lobbyTerms(stake, maxSeats);
        escrow_createMatchmade(clampedStake, clampedSeats, _roster(mask));
    }

    function escrow_join_clamped(uint256 actorSeed, uint256 matchSeed) public {
        _useActor(actorSeed);
        bytes32 matchId = _joinableMatch(matchSeed, actor);
        if (matchId == bytes32(0)) return;
        _joinOwnStake(matchId);
    }

    /// @dev A second seat for a player already seated, which must be refused.
    function escrow_join_alreadySeated_clamped(uint256 matchSeed, uint256 seatSeed) public {
        bytes32 matchId = _matchInStatus(matchSeed, GameEscrow.MatchStatus.Open);
        if (matchId == bytes32(0)) return;
        address[] memory seats = escrow.getSeats(matchId);
        if (seats.length == 0) return;
        actor = seats[seatSeed % seats.length];
        _joinOwnStake(matchId);
    }

    function escrow_joinFor_clamped(uint256 payerSeed, uint256 playerSeed, uint256 matchSeed) public {
        address player = actors[playerSeed % actors.length];
        bytes32 matchId = _joinableMatch(matchSeed, player);
        if (matchId == bytes32(0)) return;
        _useActor(payerSeed);
        uint256 stake = escrow.getMatch(matchId).stake;
        _fund(actor, stake);
        escrow_joinFor(matchId, player, stake);
    }

    function escrow_joinWithLms_clamped(uint256 actorSeed, uint256 matchSeed, uint256 lmsIn) public {
        _useActor(actorSeed);
        bytes32 matchId = _joinableMatch(matchSeed, actor);
        if (matchId == bytes32(0)) return;
        uint256 balance = lms.balanceOf(actor);
        if (balance == 0) return;
        _joinPayingLms(matchId, clampBetween(lmsIn, 1, balance));
    }

    /// @dev Near zero: little enough LMS that the discount rounds to nothing or next to it.
    function escrow_joinWithLms_smallLms_clamped(uint256 actorSeed, uint256 matchSeed, uint256 lmsIn) public {
        _useActor(actorSeed);
        bytes32 matchId = _joinableMatch(matchSeed, actor);
        if (matchId == bytes32(0)) return;
        _joinPayingLms(matchId, clampBetween(lmsIn, 1, 1e6));
    }

    /// @dev Takes seats in one existing lobby, by a mix of routes.
    function escrow_fillLobby_clamped(uint256 matchSeed, uint256 actorSeed, uint256 routes, uint256 lmsIn)
        public
    {
        bytes32 matchId = _matchInStatus(matchSeed, GameEscrow.MatchStatus.Open);
        if (matchId == bytes32(0)) return;
        _seatActors(matchId, actorSeed, actors.length, routes, lmsIn);
    }

    /// @dev Opens a lobby and fills it in one call, so a sequence reaches the
    ///      states after a lobby far more often.
    function escrow_openAndFill_clamped(
        uint256 stake,
        uint256 maxSeats,
        uint256 actorSeed,
        uint256 routes,
        uint256 lmsIn
    ) public {
        _useActor(actorSeed);
        (uint128 clampedStake, uint16 clampedSeats) = _lobbyTerms(stake, maxSeats);
        escrow_createMatch(clampedStake, clampedSeats);
        _seatActors(matchIds[matchIds.length - 1], actorSeed, clampedSeats, routes, lmsIn);
    }

    /// @dev As above for a matchmade lobby, the only kind that earns play-mining.
    function escrow_openMatchmadeAndFill_clamped(
        uint256 stake,
        uint256 maxSeats,
        uint256 mask,
        uint256 routes,
        uint256 lmsIn
    ) public {
        (uint128 clampedStake, uint16 clampedSeats) = _lobbyTerms(stake, maxSeats);
        escrow_createMatchmade(clampedStake, clampedSeats, _roster(mask));
        _seatActors(matchIds[matchIds.length - 1], mask, clampedSeats, routes, lmsIn);
    }

    function escrow_lockMatch_clamped(uint256 actorSeed, uint256 matchSeed) public {
        _useActor(actorSeed);
        bytes32 matchId = _lockable(matchSeed);
        if (matchId == bytes32(0)) return;
        escrow_lockMatch(matchId);
    }

    /// @dev Locks a lobby and has the VRF node answer in the same call.
    function escrow_lockAndSeed_clamped(uint256 actorSeed, uint256 matchSeed, uint256 word) public {
        _useActor(actorSeed);
        bytes32 matchId = _lockable(matchSeed);
        if (matchId == bytes32(0)) return;
        escrow_lockMatch(matchId);
        coordinator.fulfill(vrfRequestIds[vrfRequestIds.length - 1], word);
    }

    function escrow_settle_clamped(uint256 actorSeed, uint256 matchSeed, uint256 rankingSeed, uint256 rounds)
        public
    {
        _useActor(actorSeed);
        bytes32 matchId = _matchInStatus(matchSeed, GameEscrow.MatchStatus.Live);
        if (matchId == bytes32(0)) return;
        _settleAs(
            matchId,
            _shuffled(escrow.getSeats(matchId), rankingSeed),
            clampBetween(rounds, 1, type(uint16).max)
        );
    }

    /// @dev Type boundary: `rounds` is stored in a uint16 and passed as a uint32.
    function escrow_settle_roundsBoundary_clamped(uint256 actorSeed, uint256 matchSeed, bool overMax) public {
        _useActor(actorSeed);
        bytes32 matchId = _matchInStatus(matchSeed, GameEscrow.MatchStatus.Live);
        if (matchId == bytes32(0)) return;
        _settleAs(matchId, escrow.getSeats(matchId), uint256(type(uint16).max) + (overMax ? 1 : 0));
    }

    /// @dev A quorum signing something that is not a permutation of the seats.
    function escrow_settle_badRanking_clamped(uint256 matchSeed, uint256 rankingSeed, uint8 mode) public {
        bytes32 matchId = _matchInStatus(matchSeed, GameEscrow.MatchStatus.Live);
        if (matchId == bytes32(0)) return;
        address[] memory seats = _shuffled(escrow.getSeats(matchId), rankingSeed);
        mode = uint8(mode % 3);
        if (mode == 0) {
            // A seat twice.
            seats[0] = seats[seats.length - 1];
        } else if (mode == 1) {
            // Someone who never staked.
            seats[0] = outsider;
        } else {
            // A seat short.
            assembly ("memory-safe") {
                mstore(seats, sub(mload(seats), 1))
            }
        }
        // Signed by a real quorum, so only the seat-set check can refuse it.
        uint32 version = escrow.getMatch(matchId).attestorSetVersion;
        bytes memory signatures =
            _signQuorum(version, _resultDigest(matchId, 1, FIZZ_ROOT, FIZZ_TRANSCRIPT, seats));
        property_forgedResultRejected(
            actor,
            matchId,
            1,
            FIZZ_ROOT,
            FIZZ_TRANSCRIPT,
            seats,
            signatures,
            "SP-07: settle accepted a ranking that is not the seat set"
        );
    }

    /// @dev A result that differs from what the quorum signed in one field, or a signature set
    ///      that is not a valid quorum. Every mode must be refused.
    function escrow_settle_tampered_clamped(
        uint256 actorSeed,
        uint256 matchSeed,
        uint256 rankingSeed,
        uint8 mode
    ) public {
        _useActor(actorSeed);
        bytes32 matchId = _matchInStatus(matchSeed, GameEscrow.MatchStatus.Live);
        if (matchId == bytes32(0)) return;
        _tampered(matchId, rankingSeed, uint8(mode % 9));
    }

    function escrow_finalize_clamped(uint256 actorSeed, uint256 matchSeed) public {
        _useActor(actorSeed);
        uint256 count = matchIds.length;
        for (uint256 i = 0; i < count; ++i) {
            bytes32 matchId = matchIds[(matchSeed % count + i) % count];
            GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
            if (info.status == GameEscrow.MatchStatus.Proposed && block.timestamp >= info.deadline) {
                property_permutedFinalizeRejected(actor, matchId, proposedRanking[matchId]);
                escrow_finalize(matchId, proposedRanking[matchId]);
                return;
            }
        }
    }

    function escrow_dispute_clamped(uint256 matchSeed, uint256 seatSeed, bytes32 evidenceHash) public {
        bytes32 matchId = _matchInStatus(matchSeed, GameEscrow.MatchStatus.Proposed);
        if (matchId == bytes32(0)) return;
        address[] memory seats = escrow.getSeats(matchId);
        actor = seats[seatSeed % seats.length];
        escrow_dispute(matchId, evidenceHash);
    }

    function escrow_cancelMatch_clamped(uint256 actorSeed, uint256 matchSeed) public {
        _useActor(actorSeed);
        uint256 count = matchIds.length;
        for (uint256 i = 0; i < count; ++i) {
            bytes32 matchId = matchIds[(matchSeed % count + i) % count];
            if (_cancellable(matchId)) {
                escrow_cancelMatch(matchId);
                return;
            }
        }
    }

    function escrow_abortMatch_clamped(uint256 actorSeed, uint256 matchSeed) public {
        _useActor(actorSeed);
        bytes32 matchId = _matchInStatus(matchSeed, GameEscrow.MatchStatus.Live);
        if (matchId == bytes32(0)) return;
        uint32 version = escrow.getMatch(matchId).attestorSetVersion;
        escrow_abortMatch(matchId, _signQuorum(version, _abortDigest(matchId)));
    }

    function escrow_withdraw_clamped(uint256 actorSeed, uint256 toSeed) public {
        _useActor(actorSeed);
        if (escrow.withdrawable(actor) == 0) return;
        escrow_withdraw(actors[toSeed % actors.length]);
    }

    function escrow_withdrawFor_clamped(uint256 actorSeed) public {
        _useActor(actorSeed);
        if (escrow.withdrawable(actor) == 0) return;
        escrow_withdrawFor(actor);
    }

    /// @dev ETH forced in, as a selfdestruct or a coinbase payment would.
    function escrow_donateETH(uint256 amount) public {
        amount = clampBetween(amount, 1, 10 ether);
        _forceSend(address(escrow), amount);
        ghosts.donatedEscrowEth += amount;
    }

    function escrow_secondary(uint8 selector, uint256 matchSeed, uint256 until, bool byGuardian) public {
        selector = uint8(selector % 5);
        if (selector == 0) {
            _escrow_veto(_matchInStatus(matchSeed, GameEscrow.MatchStatus.Proposed), byGuardian);
        } else if (selector == 1) {
            _escrow_dismissDispute(_matchInStatus(matchSeed, GameEscrow.MatchStatus.Proposed), byGuardian);
        } else if (selector == 2) {
            _escrow_pause();
        } else if (selector == 3) {
            _escrow_unpause(byGuardian);
        } else {
            _escrow_extendPause(uint64(clampBetween(until, block.timestamp + 1, block.timestamp + 7 days)));
        }
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function escrow_createMatch(uint128 stake, uint16 maxSeats) public asActor {
        SpPre memory p = _spPre(address(0));
        uint256 nonce = escrow.matchNonce();
        uint32 termsBefore = escrow.termsCount();
        bytes32 id = escrow.createMatch(stake, maxSeats);
        matchIds.push(id);
        property_createSnapshotsConfig(p, id, nonce, termsBefore, stake, maxSeats, false);
        _afterCall();
    }

    function escrow_createMatchmade(uint128 stake, uint16 maxSeats, address[] memory roster)
        public
        asMatchmaker
    {
        SpPre memory p = _spPre(address(0));
        uint256 nonce = escrow.matchNonce();
        uint32 termsBefore = escrow.termsCount();
        bytes32 id = escrow.createMatchmade(stake, maxSeats, roster);
        matchIds.push(id);
        for (uint256 i = 0; i < roster.length; ++i) {
            _noteAddr(roster[i]);
        }
        property_createSnapshotsConfig(p, id, nonce, termsBefore, stake, maxSeats, true);
        _afterCall();
    }

    function escrow_join(bytes32 matchId, uint256 value) public asActor {
        SpPre memory p = _spPre(address(0));
        SpMatch memory m = _spMatch(matchId);
        escrow.join{value: value}(matchId);
        property_joinSeatAccounting(p, m, matchId, actor, value, 0);
        _afterCall();
    }

    function escrow_joinFor(bytes32 matchId, address player, uint256 value) public asActor {
        _noteAddr(player);
        SpPre memory p = _spPre(address(0));
        SpMatch memory m = _spMatch(matchId);
        escrow.joinFor{value: value}(matchId, player);
        property_joinSeatAccounting(p, m, matchId, player, value, 0);
        _afterCall();
    }

    function escrow_joinWithLms(bytes32 matchId, uint256 lmsIn, uint256 value) public asActor {
        SpPre memory p = _spPre(address(0));
        SpMatch memory m = _spMatch(matchId);
        (uint256 quotedDiscount, uint256 quotedLms) = escrow.quoteLmsDiscount(matchId, lmsIn);
        uint256 rate = config.lmsPerEthDiscount();
        escrow.joinWithLms{value: value}(matchId, lmsIn);
        property_joinSeatAccounting(p, m, matchId, actor, value, quotedLms);
        property_lmsDiscountBounds(m, matchId, actor, lmsIn, quotedDiscount, quotedLms, rate);
        _afterCall();
    }

    function escrow_lockMatch(bytes32 matchId) public asActor {
        SpPre memory p = _spPre(address(0));
        SpMatch memory m = _spMatch(matchId);
        vrfRequestIds.push(uint256(escrow.lockMatch(matchId)));
        property_lockSnapshotsConfig(p, m, matchId);
        _afterCall();
    }

    function escrow_settle(
        bytes32 matchId,
        uint32 rounds,
        bytes32 historyRoot,
        bytes32 transcriptHash,
        address[] memory ranking,
        bytes memory signatures
    ) public asActor {
        SpPre memory p = _spPre(address(0));
        escrow.settle(matchId, rounds, historyRoot, transcriptHash, ranking, signatures);
        proposedRanking[matchId] = ranking;
        ghosts.originalDeadline[matchId] = escrow.getMatch(matchId).deadline;
        property_settleProposes(p, matchId, rounds, ranking);
        _afterCall();
    }

    function escrow_finalize(bytes32 matchId, address[] memory ranking) public asActor {
        SpMatch memory m = _spMatch(matchId);
        SpPre memory p = _spPre(m.terms.treasury);
        try escrow.finalize(matchId, ranking) {}
        catch (bytes memory reason) {
            _spExitFailed(reason, "SP-14: finalize was refused with EnforcedPause");
        }
        _trackFeeEpoch();
        ghosts.burnedLms += m.discLms;
        property_finalizeConserves(p, m, matchId);
        property_finalizePayouts(p, m, ranking);
        property_finalizeFeeLedger(p, m, ranking);
        _afterCall();
    }

    function escrow_dispute(bytes32 matchId, bytes32 evidenceHash) public asActor {
        GameEscrow.MatchInfo memory before_ = escrow.getMatch(matchId);
        try escrow.dispute(matchId, evidenceHash) {}
        catch (bytes memory reason) {
            _spExitFailed(reason, "SP-14: dispute was refused with EnforcedPause");
        }
        property_disputeTransitions(before_, matchId, actor);
        ghosts.disputedBy[matchId][actor] = true;
        _afterCall();
    }

    function escrow_cancelMatch(bytes32 matchId) public asActor {
        SpPre memory p = _spPre(address(0));
        SpMatch memory m = _spMatch(matchId);
        try escrow.cancelMatch(matchId) {}
        catch (bytes memory reason) {
            _spExitFailed(reason, "SP-14: cancelMatch was refused with EnforcedPause");
        }
        property_refundExact(p, m, matchId);
        _afterCall();
    }

    function escrow_abortMatch(bytes32 matchId, bytes memory signatures) public asActor {
        SpPre memory p = _spPre(address(0));
        SpMatch memory m = _spMatch(matchId);
        try escrow.abortMatch(matchId, signatures) {}
        catch (bytes memory reason) {
            _spExitFailed(reason, "SP-14: abortMatch was refused with EnforcedPause");
        }
        property_refundExact(p, m, matchId);
        _afterCall();
    }

    function escrow_withdraw(address to) public asActor {
        _noteAddr(to);
        SpPre memory p = _spPre(address(0));
        uint256 amount = escrow.withdrawable(actor);
        uint256 toBalance = to.balance;
        uint256 got;
        try escrow.withdraw(to) returns (uint256 paid) {
            got = paid;
        } catch (bytes memory reason) {
            _spExitFailed(reason, "SP-14: withdraw was refused with EnforcedPause");
        }
        property_withdrawExact(p, actor, to, amount, got, toBalance);
        _afterCall();
    }

    function escrow_withdrawFor(address account) public asActor {
        _noteAddr(account);
        SpPre memory p = _spPre(address(0));
        uint256 amount = escrow.withdrawable(account);
        uint256 toBalance = account.balance;
        uint256 got;
        try escrow.withdrawFor(account) returns (uint256 paid) {
            got = paid;
        } catch (bytes memory reason) {
            _spExitFailed(reason, "SP-14: withdrawFor was refused with EnforcedPause");
        }
        property_withdrawExact(p, account, account, amount, got, toBalance);
        _afterCall();
    }

    function _escrow_veto(bytes32 matchId, bool byGuardian) internal {
        SpPre memory p = _spPre(address(0));
        SpMatch memory m = _spMatch(matchId);
        vm.startPrank(byGuardian ? config.guardian() : address(timelock));
        try escrow.veto(matchId) {}
        catch (bytes memory reason) {
            vm.stopPrank();
            _spExitFailed(reason, "SP-14: veto was refused with EnforcedPause");
        }
        vm.stopPrank();
        property_refundExact(p, m, matchId);
        _afterCall();
    }

    function _escrow_dismissDispute(bytes32 matchId, bool byGuardian) internal {
        GameEscrow.MatchInfo memory before_ = escrow.getMatch(matchId);
        vm.startPrank(byGuardian ? config.guardian() : address(timelock));
        try escrow.dismissDispute(matchId) {}
        catch (bytes memory reason) {
            vm.stopPrank();
            _spExitFailed(reason, "SP-14: dismissDispute was refused with EnforcedPause");
        }
        vm.stopPrank();
        property_dismissTransitions(before_, matchId);
        _afterCall();
    }

    function _escrow_pause() internal {
        uint64 untilBefore = escrow.pausedUntil();
        vm.startPrank(config.guardian());
        escrow.pause();
        vm.stopPrank();
        ghosts.lastGuardianPauseAt = uint64(block.timestamp);
        property_guardianPause(untilBefore);
        _afterCall();
    }

    function _escrow_unpause(bool byGuardian) internal {
        bool governanceBefore = escrow.pausedByGovernance();
        vm.startPrank(byGuardian ? config.guardian() : address(timelock));
        escrow.unpause();
        vm.stopPrank();
        property_unpause(byGuardian, governanceBefore);
        _afterCall();
    }

    function _escrow_extendPause(uint64 until) internal asTimelock {
        uint64 untilBefore = escrow.pausedUntil();
        escrow.extendPause(until);
        property_extendPause(untilBefore, until);
        _afterCall();
    }

    // ―――――――――――――――――――――――― Probes ―――――――――――――――――――――――――――

    /// @dev Tries to leave every match by cancelling and finalising it. Each attempt must succeed
    ///      exactly when the contract says it is allowed, also while paused (SP-12, SP-14). Then
    ///      every actor holding a balance withdraws to itself, which must always work (SP-13).
    function adversary_exitEveryMatch(uint256 actorSeed, uint256 matchSeed) public {
        _useActor(actorSeed);
        uint256 count = matchIds.length;
        uint256 visit = count > 24 ? 24 : count;
        for (uint256 i = 0; i < visit; ++i) {
            _probeExit(matchIds[(matchSeed % count + i) % count]);
        }
        for (uint256 i = 0; i < actors.length; ++i) {
            if (escrow.withdrawable(actors[i]) == 0) continue;
            vm.prank(actors[i]);
            try escrow.withdraw(actors[i]) {}
            catch (bytes memory reason) {
                t(!_isPauseRevert(reason), "SP-14: withdraw was refused with EnforcedPause");
                t(false, "SP-13: withdraw(self) reverted for an actor holding a balance");
            }
        }
        _afterCall();
    }

    /// @dev Every privileged function, called by an address with no role.
    function adversary_accessMatrix(uint256 seed) public {
        bytes32 id = matchIds.length == 0 ? bytes32(0) : matchIds[seed % matchIds.length];
        property_accessControlMatrix(id);
    }

    function _isPauseRevert(bytes memory reason) private pure returns (bool) {
        return reason.length >= 4 && bytes4(reason) == bytes4(keccak256("EnforcedPause()"));
    }

    function _probeExit(bytes32 id) private {
        bool eligible = _cancellable(id);
        vm.prank(actor);
        try escrow.cancelMatch(id) {
            t(eligible, "SP-12: cancelMatch succeeded when it was not allowed");
        } catch (bytes memory reason) {
            t(!_isPauseRevert(reason), "SP-14: cancelMatch was refused with EnforcedPause");
            t(!eligible, "SP-12: an eligible cancelMatch reverted");
        }

        GameEscrow.MatchInfo memory info = escrow.getMatch(id);
        address[] memory ranking = proposedRanking[id];
        address feed = config.sequencerUptimeFeed();
        if (feed != address(0) && feed != address(sequencerFeed)) return;
        bool healthy = feed == address(0)
            || (sequencerFeed.answer() == 0
                && block.timestamp >= sequencerFeed.startedAt() + SEQUENCER_GRACE_PERIOD);
        bool due = info.status == GameEscrow.MatchStatus.Proposed && block.timestamp >= info.deadline
            && ranking.length != 0;
        SpMatch memory m = _spMatch(id);
        vm.prank(actor);
        try escrow.finalize(id, ranking) {
            t(due && healthy, "SP-12: finalize succeeded when it was not allowed");
            _trackFeeEpoch();
            ghosts.burnedLms += m.discLms;
        } catch (bytes memory reason) {
            t(!_isPauseRevert(reason), "SP-14: finalize was refused with EnforcedPause");
            t(!(due && healthy), "SP-12: an eligible finalize reverted");
        }
    }

    function _head(bytes memory b, uint256 n) private pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i = 0; i < n; ++i) {
            out[i] = b[i];
        }
    }

    function _tampered(bytes32 matchId, uint256 rankingSeed, uint8 mode) private {
        uint32 version = escrow.getMatch(matchId).attestorSetVersion;
        address[] memory seats = _shuffled(escrow.getSeats(matchId), rankingSeed);
        bytes32 root = FIZZ_ROOT;
        bytes32 transcript = FIZZ_TRANSCRIPT;
        uint32 rounds = 3;
        bytes memory signatures =
            _signQuorum(version, _resultDigest(matchId, rounds, root, transcript, seats));
        if (signatures.length < 65) return;
        address[] memory submitted = seats;

        if (mode == 0) {
            rounds += 1;
        } else if (mode == 1) {
            root = keccak256(abi.encode(root));
        } else if (mode == 2) {
            transcript = keccak256(abi.encode(transcript));
        } else if (mode == 3) {
            submitted = new address[](seats.length);
            for (uint256 i = 0; i < seats.length; ++i) {
                submitted[i] = seats[i];
            }
            (submitted[0], submitted[1]) = (submitted[1], submitted[0]);
        } else if (mode == 4) {
            signatures = _head(signatures, signatures.length - 65);
        } else if (mode == 5) {
            bytes memory first = _head(signatures, 65);
            signatures = bytes.concat(first, first);
        } else if (mode == 6) {
            if (signatures.length < 130) return;
            bytes memory first = _head(signatures, 65);
            bytes memory both = _head(signatures, 130);
            bytes memory second = new bytes(65);
            for (uint256 i = 0; i < 65; ++i) {
                second[i] = both[65 + i];
            }
            signatures = bytes.concat(second, first);
        } else if (mode == 7) {
            bool found;
            for (uint256 i = 0; i < ATTESTOR_COUNT && !found; ++i) {
                if (config.isAttestorAt(version, attestorPool[i])) continue;
                found = true;
                signatures = _sign(attestorKeys[i], _resultDigest(matchId, rounds, root, transcript, seats));
            }
            if (!found) return;
        } else {
            signatures = _signQuorum(
                version, _resultDigest(bytes32(uint256(matchId) ^ 1), rounds, root, transcript, seats)
            );
        }
        property_forgedResultRejected(
            actor,
            matchId,
            rounds,
            root,
            transcript,
            submitted,
            signatures,
            "SP-07: a tampered result was accepted"
        );
    }

    // ――――――――――――――――――――――――― Private ――――――――――――――――――――――――――

    function _lobbyTerms(uint256 stake, uint256 maxSeats) private returns (uint128, uint16) {
        ProtocolConfig.Params memory params = config.getParams();
        return (
            uint128(clampBetween(stake, uint256(params.minStake), uint256(params.maxStake))),
            uint16(clampBetween(maxSeats, uint256(params.minSeats), uint256(params.maxSeats)))
        );
    }

    function _roster(uint256 mask) private view returns (address[] memory roster) {
        mask = (mask % (1 << actors.length)) | 0x0f;
        roster = new address[](actors.length);
        uint256 count;
        for (uint256 i = 0; i < actors.length; ++i) {
            if (mask & (1 << i) != 0) roster[count++] = actors[i];
        }
        assembly ("memory-safe") {
            mstore(roster, count)
        }
    }

    function _joinOwnStake(bytes32 matchId) private {
        uint256 stake = escrow.getMatch(matchId).stake;
        _fund(actor, stake);
        escrow_join(matchId, stake);
    }

    /// @dev Pays what `quoteLmsDiscount` says is due. Without a discount, joins plainly.
    function _joinPayingLms(bytes32 matchId, uint256 lmsIn) private {
        (uint256 discount, uint256 lmsUsed) = escrow.quoteLmsDiscount(matchId, lmsIn);
        if (discount == 0 || lms.balanceOf(actor) < lmsUsed) {
            _joinOwnStake(matchId);
            return;
        }
        uint256 due = escrow.getMatch(matchId).stake - discount;
        _fund(actor, due);
        escrow_joinWithLms(matchId, lmsIn, due);
    }

    /// @dev Up to `wanted` seats, each by the route the next byte of `routes` picks.
    function _seatActors(bytes32 matchId, uint256 actorSeed, uint256 wanted, uint256 routes, uint256 lmsIn)
        private
    {
        uint256 total = actors.length;
        uint256 seated;
        for (uint256 i = 0; i < total && seated < wanted; ++i) {
            address player = actors[(actorSeed % total + i) % total];
            if (!_canSeat(matchId, player)) continue;
            uint256 route = (routes >> (8 * seated)) % 3;
            actor = player;
            if (route == 0) {
                _joinOwnStake(matchId);
            } else if (route == 1) {
                actor = actors[(actorSeed % total + i + 1) % total];
                uint256 stake = escrow.getMatch(matchId).stake;
                _fund(actor, stake);
                escrow_joinFor(matchId, player, stake);
            } else {
                _joinPayingLms(matchId, lmsIn);
            }
            ++seated;
        }
    }

    function _lockable(uint256 matchSeed) private view returns (bytes32) {
        uint256 count = matchIds.length;
        for (uint256 i = 0; i < count; ++i) {
            bytes32 matchId = matchIds[(matchSeed % count + i) % count];
            GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
            if (info.status != GameEscrow.MatchStatus.Open) continue;
            bool ready = info.seatCount == info.maxSeats || block.timestamp >= info.joinDeadline;
            if (ready && info.seatCount >= escrow.getMatchTerms(matchId).minSeats) return matchId;
        }
        return bytes32(0);
    }

    function _settleAs(bytes32 matchId, address[] memory ranking, uint256 rounds) private {
        uint32 version = escrow.getMatch(matchId).attestorSetVersion;
        bytes memory signatures =
            _signQuorum(version, _resultDigest(matchId, uint32(rounds), FIZZ_ROOT, FIZZ_TRANSCRIPT, ranking));
        escrow_settle(matchId, uint32(rounds), FIZZ_ROOT, FIZZ_TRANSCRIPT, ranking, signatures);
    }

    /// @dev Mirrors the deadlines `cancelMatch` checks.
    function _cancellable(bytes32 matchId) private view returns (bool) {
        GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
        if (info.status == GameEscrow.MatchStatus.Open) {
            GameEscrow.Terms memory terms = escrow.getMatchTerms(matchId);
            uint256 cancellableAt = info.joinDeadline;
            if (info.seatCount >= terms.minSeats) cancellableAt += 10 minutes;
            return block.timestamp >= cancellableAt;
        }
        if (info.status == GameEscrow.MatchStatus.Pending || info.status == GameEscrow.MatchStatus.Live) {
            return block.timestamp >= info.deadline;
        }
        return false;
    }
}
