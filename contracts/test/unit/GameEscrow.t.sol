// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {ExpiringPause} from "../../src/ExpiringPause.sol";
import {ProtocolConfig} from "../../src/ProtocolConfig.sol";
import {PullPayable} from "../../src/PullPayable.sol";
import {IRandomnessOracle, IRandomnessConsumer} from "../../src/interfaces/IRandomnessOracle.sol";
import {NothingToWithdraw, TransferFailed, ZeroAddress} from "../../src/Errors.sol";

contract GameEscrowTest is Fixtures {
    function test_createMatch_snapshotsTerms() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
        GameEscrow.Terms memory terms = escrow.getMatchTerms(matchId);

        assertEq(info.stake, STAKE);
        assertEq(info.maxSeats, 4);
        assertEq(uint8(info.status), uint8(GameEscrow.MatchStatus.Open));
        assertEq(info.joinDeadline, block.timestamp + 1 hours);
        assertEq(terms.feeBps, 500);
        assertEq(terms.minSeats, 4);
        assertEq(terms.treasury, treasury);
        assertEq(terms.rulesHash, config.rulesHash());
        assertEq(terms.challengeWindow, CHALLENGE_WINDOW);
        assertEq(escrow.getPayoutSchedule(matchId)[0], 10_000);
    }

    /// @dev Lobbies on the same terms share one stored record; a governance
    ///      change makes the next lobby store a new one.
    function test_createMatch_sharesTermsUntilTheyChange() public {
        vm.startPrank(players[0]);
        bytes32 first = escrow.createMatch(STAKE, 4);
        bytes32 second = escrow.createMatch(STAKE * 2, 6);
        vm.stopPrank();
        assertEq(escrow.getMatch(first).termsId, 1);
        assertEq(escrow.getMatch(second).termsId, 1);
        assertEq(escrow.termsCount(), 1);

        ProtocolConfig.Params memory next = config.getParams();
        next.feeBps = 100;
        vm.prank(owner);
        config.setParams(next);

        vm.prank(players[0]);
        bytes32 third = escrow.createMatch(STAKE, 4);
        assertEq(escrow.getMatch(third).termsId, 2);
        assertEq(escrow.getMatchTerms(third).feeBps, 100);
        assertEq(escrow.getMatchTerms(first).feeBps, 500);
    }

    function test_createMatch_rejectsStakeOutOfRange() public {
        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.StakeOutOfRange.selector, uint128(1)));
        escrow.createMatch(1, 4);
    }

    function test_createMatch_rejectsSeatsOutOfRange() public {
        vm.startPrank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.SeatsOutOfRange.selector, uint16(3)));
        escrow.createMatch(STAKE, 3);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.SeatsOutOfRange.selector, uint16(9)));
        escrow.createMatch(STAKE, 9);
        vm.stopPrank();
    }

    function test_join_rejectsAClosedWindowOrALockedLobby() public {
        vm.prank(players[0]);
        bytes32 late = escrow.createMatch(STAKE, 4);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.JoinWindowClosed.selector, late));
        escrow.join{value: STAKE}(late);

        bytes32 locked = _createAndFill(4);
        escrow.lockMatch(locked);
        vm.prank(players[4]);
        vm.expectRevert(
            abi.encodeWithSelector(
                GameEscrow.WrongStatus.selector,
                locked,
                GameEscrow.MatchStatus.Open,
                GameEscrow.MatchStatus.Pending
            )
        );
        escrow.join{value: STAKE}(locked);
    }

    function test_join_andLockFullLobby() public {
        bytes32 matchId = _createAndFill(4);
        assertEq(escrow.getSeats(matchId).length, 4);
        assertEq(escrow.totalEscrowed(), 4 * STAKE);
        assertEq(address(escrow).balance, 4 * STAKE);

        bytes32 seed = _lockAndSeed(matchId, bytes32(uint256(0xC0DE)));
        GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
        assertEq(uint8(info.status), uint8(GameEscrow.MatchStatus.Live));
        assertEq(info.seed, seed);
        assertTrue(info.seed != bytes32(0));
    }

    function test_join_rejectsDuplicateAndWrongStake() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);

        vm.prank(players[1]);
        escrow.join{value: STAKE}(matchId);

        vm.prank(players[1]);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.AlreadyJoined.selector, matchId, players[1]));
        escrow.join{value: STAKE}(matchId);

        vm.prank(players[2]);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.IncorrectStake.selector, STAKE / 2, STAKE));
        escrow.join{value: STAKE / 2}(matchId);
    }

    function test_joinFor_seatsPlayerNotPayer_andRefundsPlayer() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        address payer = makeAddr("payer");
        vm.deal(payer, STAKE);

        vm.prank(payer);
        escrow.joinFor{value: STAKE}(matchId, players[1]);

        assertTrue(escrow.hasSeat(matchId, players[1]));
        assertFalse(escrow.hasSeat(matchId, payer));
        assertEq(escrow.seatOrigin(matchId, players[1]), 0);
        assertEq(escrow.totalEscrowed(), STAKE);

        vm.prank(players[1]);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.AlreadyJoined.selector, matchId, players[1]));
        escrow.join{value: STAKE}(matchId);

        vm.warp(block.timestamp + 1 hours);
        escrow.cancelMatch(matchId);
        assertEq(escrow.withdrawable(players[1]), STAKE);
        assertEq(escrow.withdrawable(payer), 0);
    }

    function test_joinFor_rejectsZeroPlayerWrongStakeAndPause() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);

        vm.expectRevert(ZeroAddress.selector);
        escrow.joinFor{value: STAKE}(matchId, address(0));

        vm.expectRevert(abi.encodeWithSelector(GameEscrow.IncorrectStake.selector, STAKE / 2, STAKE));
        escrow.joinFor{value: STAKE / 2}(matchId, players[1]);

        _pause();
        vm.expectRevert(ExpiringPause.EnforcedPause.selector);
        escrow.joinFor{value: STAKE}(matchId, players[1]);
    }

    function test_lockMatch_rejectsUnderfilledBeforeDeadline() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 6);
        for (uint256 i = 0; i < 4; ++i) {
            vm.prank(players[i]);
            escrow.join{value: STAKE}(matchId);
        }
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.LobbyNotReady.selector, matchId));
        escrow.lockMatch(matchId);
    }

    function test_lockMatch_allowsQuorateLobbyAfterDeadline() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 6);
        for (uint256 i = 0; i < 4; ++i) {
            vm.prank(players[i]);
            escrow.join{value: STAKE}(matchId);
        }
        vm.warp(block.timestamp + 1 hours);
        _lockAndSeed(matchId, bytes32(uint256(1)));
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Live));
    }

    function test_cancel_expiredUnderfilledLobbyRefunds() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        vm.prank(players[0]);
        escrow.join{value: STAKE}(matchId);
        vm.prank(players[1]);
        escrow.join{value: STAKE}(matchId);

        vm.expectRevert(abi.encodeWithSelector(GameEscrow.CannotCancelYet.selector, matchId));
        escrow.cancelMatch(matchId);

        vm.warp(block.timestamp + 1 hours);
        escrow.cancelMatch(matchId);

        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Cancelled));
        assertEq(escrow.withdrawable(players[0]), STAKE);
        assertEq(escrow.withdrawable(players[1]), STAKE);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(escrow.totalOwed(), 2 * STAKE);
        assertEq(address(escrow).balance, escrow.totalOwed() + escrow.totalEscrowed());
    }

    /// @dev A lobby that reached `minSeats` should start, so past its join
    ///      deadline it can only be locked for a grace period. Otherwise a
    ///      seated player could race the lock with a cancel.
    function test_cancel_aQuorateLobbyWaitsOutTheLockGrace() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 6);
        for (uint256 i = 0; i < 4; ++i) {
            vm.prank(players[i]);
            escrow.join{value: STAKE}(matchId);
        }
        uint40 joinDeadline = escrow.getMatch(matchId).joinDeadline;

        vm.warp(joinDeadline + 10 minutes - 1);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.CannotCancelYet.selector, matchId));
        escrow.cancelMatch(matchId);

        vm.warp(joinDeadline + 10 minutes);
        escrow.cancelMatch(matchId);
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Cancelled));
    }

    function test_cancel_aLockedLobbyWaitsOutTheRandomnessTimeout() public {
        bytes32 matchId = _createAndFill(4);
        escrow.lockMatch(matchId);
        uint40 deadline = escrow.getMatch(matchId).deadline;
        assertEq(deadline, block.timestamp + 1 hours);

        vm.warp(deadline - 1);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.CannotCancelYet.selector, matchId));
        escrow.cancelMatch(matchId);

        vm.warp(deadline);
        escrow.cancelMatch(matchId);
        assertEq(escrow.withdrawable(players[0]), STAKE);
    }

    function test_lockMatch_rejectsAnExpiredLobbyShortOfSeats() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 6);
        for (uint256 i = 0; i < 3; ++i) {
            vm.prank(players[i]);
            escrow.join{value: STAKE}(matchId);
        }
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.NotEnoughPlayers.selector, uint16(3), uint16(4)));
        escrow.lockMatch(matchId);
    }

    function test_settle_rejectsAMatchNotLive_andAnOutOfRangeRoundCount() public {
        bytes32 matchId = _createAndFill(4);
        address[] memory ranking = _rankingOf(matchId);
        bytes memory early = _signResult(_twoAttestors(), matchId, ROUNDS, HISTORY_ROOT, ranking);
        vm.expectRevert(
            abi.encodeWithSelector(
                GameEscrow.WrongStatus.selector,
                matchId,
                GameEscrow.MatchStatus.Live,
                GameEscrow.MatchStatus.Open
            )
        );
        escrow.settle(matchId, ROUNDS, HISTORY_ROOT, TRANSCRIPT_HASH, ranking, early);

        _lockAndSeed(matchId, bytes32(uint256(6)));
        uint32 tooMany = uint32(type(uint16).max) + 1;
        bytes memory none = _signResult(_twoAttestors(), matchId, 0, HISTORY_ROOT, ranking);
        bytes memory over = _signResult(_twoAttestors(), matchId, tooMany, HISTORY_ROOT, ranking);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.RoundsOutOfRange.selector, uint32(0)));
        escrow.settle(matchId, 0, HISTORY_ROOT, TRANSCRIPT_HASH, ranking, none);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.RoundsOutOfRange.selector, tooMany));
        escrow.settle(matchId, tooMany, HISTORY_ROOT, TRANSCRIPT_HASH, ranking, over);
    }

    /// @dev A ranking missing a seat, or naming one twice, is not the seat set.
    function test_settle_rejectsAShortRankingOrARepeatedSeat() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(7)));
        address[] memory seats = _rankingOf(matchId);

        address[] memory short = new address[](3);
        (short[0], short[1], short[2]) = (seats[0], seats[1], seats[2]);
        bytes memory shortSigs = _signResult(_twoAttestors(), matchId, ROUNDS, HISTORY_ROOT, short);
        vm.expectRevert(GameEscrow.NotAPermutation.selector);
        escrow.settle(matchId, ROUNDS, HISTORY_ROOT, TRANSCRIPT_HASH, short, shortSigs);

        address[] memory repeated = new address[](4);
        (repeated[0], repeated[1], repeated[2], repeated[3]) = (seats[0], seats[1], seats[2], seats[0]);
        bytes memory repeatedSigs = _signResult(_twoAttestors(), matchId, ROUNDS, HISTORY_ROOT, repeated);
        vm.expectRevert(GameEscrow.NotAPermutation.selector);
        escrow.settle(matchId, ROUNDS, HISTORY_ROOT, TRANSCRIPT_HASH, repeated, repeatedSigs);
    }

    /// @dev A position the schedule pays nothing is skipped, not credited zero,
    ///      and the pool is still fully assigned.
    function test_finalize_skipsAPositionWithNoShare() public {
        uint16[] memory schedule = new uint16[](2);
        (schedule[0], schedule[1]) = (10_000, 0);
        vm.prank(owner);
        config.setPayoutSchedule(schedule);

        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(8)));
        address[] memory ranking = _settleAndFinalize(matchId);

        uint256 pool = 4 * STAKE;
        uint256 fee = (pool * 500) / 10_000;
        assertEq(escrow.withdrawable(ranking[0]), pool - fee);
        assertEq(escrow.withdrawable(ranking[1]), 0);
        assertEq(escrow.withdrawable(treasury), fee);
    }

    function test_settle_creditsWinnerAndTreasury() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(0x51)));

        address[] memory ranking = _rankingOf(matchId);
        _propose(matchId, ranking);
        GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
        assertEq(uint8(info.status), uint8(GameEscrow.MatchStatus.Proposed));
        assertEq(info.deadline, block.timestamp + CHALLENGE_WINDOW);
        // Nothing is paid while the result can still be vetoed.
        assertEq(escrow.withdrawable(ranking[0]), 0);

        vm.expectRevert(abi.encodeWithSelector(GameEscrow.ChallengeWindowOpen.selector, info.deadline));
        escrow.finalize(matchId, ranking);
        vm.warp(info.deadline);
        escrow.finalize(matchId, ranking);

        info = escrow.getMatch(matchId);
        assertEq(uint8(info.status), uint8(GameEscrow.MatchStatus.Settled));
        assertEq(info.historyRoot, HISTORY_ROOT);
        assertEq(info.rounds, ROUNDS);

        uint256 pool = 4 * STAKE;
        uint256 fee = (pool * 500) / 10_000;
        uint256 prize = pool - fee;

        assertEq(escrow.withdrawable(ranking[0]), prize);
        assertEq(escrow.withdrawable(treasury), fee);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(escrow.totalOwed(), pool);
        assertEq(address(escrow).balance, pool);
    }

    function test_settle_rejectsUnknownSignerAndBadPermutation() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(2)));

        address[] memory ranking = _rankingOf(matchId);
        bytes32 historyRoot = keccak256("root");

        uint256[] memory stranger = new uint256[](2);
        stranger[0] = 0xDEAD;
        stranger[1] = ATTESTOR_PK_A;
        // One real attestor is not enough, and 0xDEAD is not an attestor.
        bytes memory bad = _signResult(stranger, matchId, 3, historyRoot, ranking);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.NotAnAttestor.selector, vm.addr(0xDEAD)));
        escrow.settle(matchId, 3, historyRoot, TRANSCRIPT_HASH, ranking, bad);

        address[] memory shuffled = new address[](4);
        shuffled[0] = ranking[0];
        shuffled[1] = ranking[1];
        shuffled[2] = ranking[2];
        shuffled[3] = treasury; // not a seat
        bytes memory sigs = _signResult(_twoAttestors(), matchId, 3, historyRoot, shuffled);
        vm.expectRevert(GameEscrow.NotAPermutation.selector);
        escrow.settle(matchId, 3, historyRoot, TRANSCRIPT_HASH, shuffled, sigs);
    }

    function test_settle_storesAndEmitsTheTranscriptHash() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(4)));
        address[] memory ranking = _rankingOf(matchId);

        vm.expectEmit(true, true, false, false, address(escrow));
        emit GameEscrow.ResultProposed(matchId, HISTORY_ROOT, ROUNDS, TRANSCRIPT_HASH, ranking, 0);
        _propose(matchId, ranking);
        assertEq(escrow.getMatch(matchId).transcriptHash, TRANSCRIPT_HASH);
    }

    /// @dev The attestors sign over the transcript hash: a relayer cannot
    ///      swap in a different transcript under their signatures.
    function test_settle_rejectsATranscriptHashTheQuorumDidNotSign() public {
        // One signature, so it recovers to one stranger rather than to two
        // that may come out in either order.
        vm.prank(owner);
        config.setAttestorSet(_attestors(attestorA, attestorB, attestorC), 1);
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(5)));
        address[] memory ranking = _rankingOf(matchId);
        uint256[] memory one = new uint256[](1);
        one[0] = ATTESTOR_PK_A;
        bytes memory sigs = _signResult(one, matchId, ROUNDS, HISTORY_ROOT, ranking);

        vm.expectPartialRevert(ProtocolConfig.NotAnAttestor.selector);
        escrow.settle(matchId, ROUNDS, HISTORY_ROOT, keccak256("another transcript"), ranking, sigs);
        escrow.settle(matchId, ROUNDS, HISTORY_ROOT, TRANSCRIPT_HASH, ranking, sigs);
    }

    function test_settle_rejectsSingleAttestorWhenThresholdIsTwo() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(3)));
        address[] memory ranking = _rankingOf(matchId);
        uint256[] memory one = new uint256[](1);
        one[0] = ATTESTOR_PK_A;
        bytes memory sigs = _signResult(one, matchId, 1, keccak256("r"), ranking);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.QuorumNotMet.selector, uint256(1), uint32(2)));
        escrow.settle(matchId, 1, keccak256("r"), TRANSCRIPT_HASH, ranking, sigs);
    }

    function test_withdraw_paysRecipient() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(4)));
        address[] memory ranking = _settleAndFinalize(matchId);

        uint256 before = players[0].balance;
        uint256 owed = escrow.withdrawable(ranking[0]);
        vm.prank(ranking[0]);
        uint256 paid = escrow.withdraw(ranking[0]);
        assertEq(paid, owed);
        assertEq(ranking[0].balance, before + owed);
        assertEq(escrow.withdrawable(ranking[0]), 0);
        assertEq(address(escrow).balance, escrow.totalOwed() + escrow.totalEscrowed());
    }

    /// @dev The balance stays credited when the recipient refuses the ETH.
    function test_withdraw_revertsWhenTheRecipientRefuses() public {
        bytes32 matchId = _createAndFill(4);
        vm.warp(block.timestamp + 1 hours + 10 minutes);
        escrow.cancelMatch(matchId);

        // The config has no way to take ETH.
        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(TransferFailed.selector, address(config), STAKE));
        escrow.withdraw(address(config));
        assertEq(escrow.withdrawable(players[0]), STAKE);
    }

    function test_withdrawFor_paysTheAccountNotTheCaller() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(4)));
        address[] memory ranking = _settleAndFinalize(matchId);

        address relayer = makeAddr("relayer");
        uint256 before = ranking[0].balance;
        uint256 owed = escrow.withdrawable(ranking[0]);
        vm.prank(relayer);
        uint256 paid = escrow.withdrawFor(ranking[0]);

        assertEq(paid, owed);
        assertEq(ranking[0].balance, before + owed);
        assertEq(relayer.balance, 0);
        assertEq(escrow.withdrawable(ranking[0]), 0);
        assertEq(address(escrow).balance, escrow.totalOwed() + escrow.totalEscrowed());
    }

    /// @dev Dust is the player's own to withdraw: whoever calls `withdrawFor`
    ///      pays its gas, so it refuses a balance below the minimum.
    function test_withdrawFor_refusesDust_butWithdrawPaysIt() public {
        address dusty = makeAddr("dusty");
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        uint256 dust = escrow.MIN_WITHDRAW_FOR() - 1;
        // A bridged join below the stake is credited back as is.
        _bridgeJoin(matchId, dusty, dust);
        assertEq(escrow.withdrawable(dusty), dust);

        vm.expectRevert(abi.encodeWithSelector(PullPayable.BelowMinimumWithdrawal.selector, dust, dust + 1));
        escrow.withdrawFor(dusty);

        vm.prank(dusty);
        assertEq(escrow.withdraw(dusty), dust);
    }

    function test_withdrawFor_revertsOnEmptyBalance() public {
        vm.expectRevert(NothingToWithdraw.selector);
        escrow.withdrawFor(players[0]);
    }

    // --- Bridged joins that cannot seat are refunded, never reverted ---

    /// @dev What `BridgeJoinReceiver` does once a fill lands.
    function _bridgeJoin(bytes32 matchId, address player, uint256 value) internal {
        vm.deal(bridge, bridge.balance + value);
        vm.prank(bridge);
        escrow.bridgeJoin{value: value}(matchId, player, 421_614);
    }

    /// @dev Delivers a bridged join and checks it was refunded for `reason`
    ///      rather than seated or reverted.
    function _assertRefunded(bytes32 matchId, address player, uint256 value, GameEscrow.JoinFailure reason)
        internal
    {
        uint256 owedBefore = escrow.withdrawable(player);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit GameEscrow.JoinRefunded(matchId, player, value, reason);
        _bridgeJoin(matchId, player, value);

        assertEq(escrow.withdrawable(player), owedBefore + value);
        assertEq(address(escrow).balance, escrow.totalOwed() + escrow.totalEscrowed());
    }

    function test_crossChainJoin_refundsALockedLobby() public {
        bytes32 matchId = _createAndFill(4);
        escrow.lockMatch(matchId);
        _assertRefunded(matchId, makeAddr("late"), STAKE, GameEscrow.JoinFailure.NotOpen);
    }

    function test_crossChainJoin_refundsALobbyThatFilledInFlight() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        for (uint256 i = 0; i < 4; ++i) {
            vm.prank(players[i]);
            escrow.join{value: STAKE}(matchId);
        }
        // Full but not yet locked: still Open, with no seat left.
        _assertRefunded(matchId, makeAddr("late"), STAKE, GameEscrow.JoinFailure.LobbyFull);
        assertFalse(escrow.hasSeat(matchId, makeAddr("late")));
    }

    function test_crossChainJoin_refundsTooLittle() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        _assertRefunded(matchId, makeAddr("remote"), STAKE / 2, GameEscrow.JoinFailure.StakeTooLow);
    }

    /// @dev A fill may carry more than the stake: the seat takes the stake and
    ///      the player is credited the rest.
    function test_crossChainJoin_seatsAndCreditsTheExtra() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        address remote = makeAddr("remote");
        _bridgeJoin(matchId, remote, STAKE + 0.3 ether);

        assertTrue(escrow.hasSeat(matchId, remote));
        assertEq(escrow.withdrawable(remote), 0.3 ether);
        assertEq(escrow.totalEscrowed(), STAKE);
        assertEq(address(escrow).balance, escrow.totalOwed() + escrow.totalEscrowed());
    }

    function test_crossChainJoin_refundsADuplicateSeat() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        vm.prank(players[1]);
        escrow.join{value: STAKE}(matchId);
        _assertRefunded(matchId, players[1], STAKE, GameEscrow.JoinFailure.AlreadyJoined);
    }

    function test_crossChainJoin_refundsAnUnknownMatchOrClosedWindow() public {
        _assertRefunded(keccak256("nope"), makeAddr("remote"), STAKE, GameEscrow.JoinFailure.UnknownMatch);

        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        vm.warp(block.timestamp + 2 hours);
        _assertRefunded(matchId, makeAddr("remote"), STAKE, GameEscrow.JoinFailure.WindowClosed);
    }

    function test_crossChainJoin_refundsWhilePaused() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        _pause();
        _assertRefunded(matchId, makeAddr("remote"), STAKE, GameEscrow.JoinFailure.Paused);

        // The refund is an ordinary balance: withdrawable even while paused.
        address remote = makeAddr("remote");
        escrow.withdrawFor(remote);
        assertEq(remote.balance, STAKE);
    }

    function test_crossChainJoin_viaTheBridgeReceiver() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);

        vm.prank(players[0]);
        escrow.join{value: STAKE}(matchId);

        address remotePlayer = makeAddr("remote");
        vm.expectEmit(true, true, false, true, address(escrow));
        emit GameEscrow.PlayerJoined(matchId, remotePlayer, 1, 421_614);
        _bridgeJoin(matchId, remotePlayer, STAKE);

        assertTrue(escrow.hasSeat(matchId, remotePlayer));
        assertEq(escrow.seatOrigin(matchId, remotePlayer), 421_614);
        assertEq(escrow.getSeats(matchId).length, 2);
    }

    function test_crossChainJoin_onlyFromTheBridgeReceiver() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);

        vm.deal(address(this), STAKE);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.NotBridgeReceiver.selector, address(this)));
        escrow.bridgeJoin{value: STAKE}(matchId, players[1], 421_614);

        // Turned off: nobody is the receiver.
        vm.prank(owner);
        config.setBridgeReceiver(address(0));
        vm.deal(bridge, STAKE);
        vm.prank(bridge);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.NotBridgeReceiver.selector, bridge));
        escrow.bridgeJoin{value: STAKE}(matchId, players[1], 421_614);
    }

    /// @dev Crediting the zero address would lose the stake, so that is the
    ///      one case that reverts past the caller check. The receiver never
    ///      sends it.
    function test_crossChainJoin_refusesTheZeroPlayer() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        vm.deal(bridge, STAKE);
        vm.prank(bridge);
        vm.expectRevert(ZeroAddress.selector);
        escrow.bridgeJoin{value: STAKE}(matchId, address(0), 421_614);
    }

    function test_pause_blocksJoinButNotWithdrawOrCancel() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(6)));
        address[] memory ranking = _settleAndFinalize(matchId);

        _pause();

        vm.prank(players[0]);
        vm.expectRevert(ExpiringPause.EnforcedPause.selector);
        escrow.createMatch(STAKE, 4);

        vm.prank(ranking[0]);
        escrow.withdraw(ranking[0]);
        assertEq(escrow.withdrawable(ranking[0]), 0);
    }

    function test_cancel_liveMatchAfterDeadline() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(7)));

        vm.expectRevert(abi.encodeWithSelector(GameEscrow.CannotCancelYet.selector, matchId));
        escrow.cancelMatch(matchId);

        vm.warp(block.timestamp + 2 hours);
        escrow.cancelMatch(matchId);
        assertEq(escrow.withdrawable(players[0]), STAKE);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(address(escrow).balance, escrow.totalOwed());
    }

    function test_fulfillRandomness_rejectsNonOracle() public {
        bytes32 matchId = _createAndFill(4);
        escrow.lockMatch(matchId);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.NotOracle.selector, address(this)));
        escrow.fulfillRandomness(matchId, bytes32(uint256(1)));
    }

    /// @dev The request is complete before the oracle is called, so an oracle
    ///      that answers inside `requestRandomness` seeds the match.
    function test_lockMatch_acceptsAnAnswerInsideTheRequest() public {
        bytes32 matchId = _createAndFill(4);
        InstantOracle instant = new InstantOracle();
        vm.prank(owner);
        config.setRandomnessOracle(address(instant));

        escrow.lockMatch(matchId);
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Live));
    }

    /// @dev The oracle a match asked is the one that answers it, even after
    ///      governance points new matches at another.
    function test_fulfillRandomness_comesFromTheOracleTheMatchAsked() public {
        bytes32 matchId = _createAndFill(4);
        bytes32 requestId = escrow.lockMatch(matchId);

        InstantOracle replacement = new InstantOracle();
        vm.prank(owner);
        config.setRandomnessOracle(address(replacement));

        vm.prank(address(replacement));
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.NotOracle.selector, address(replacement)));
        escrow.fulfillRandomness(matchId, bytes32(uint256(1)));

        oracle.fulfill(requestId, bytes32(uint256(1)));
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Live));
        assertEq(escrow.getMatch(matchId).oracle, address(oracle));
    }

    function test_fulfillRandomness_rejectsASecondAnswer() public {
        bytes32 matchId = _createAndFill(4);
        bytes32 requestId = escrow.lockMatch(matchId);
        oracle.fulfill(requestId, bytes32(uint256(1)));

        vm.prank(address(oracle));
        vm.expectRevert(
            abi.encodeWithSelector(
                GameEscrow.WrongStatus.selector,
                matchId,
                GameEscrow.MatchStatus.Pending,
                GameEscrow.MatchStatus.Live
            )
        );
        escrow.fulfillRandomness(matchId, bytes32(uint256(2)));
    }

    function test_governanceParamsChange_doesNotAffectOpenMatch() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);

        ProtocolConfig.Params memory next = config.getParams();
        next.feeBps = 100;
        vm.prank(owner);
        config.setParams(next);

        assertEq(escrow.getMatchTerms(matchId).feeBps, 500);
    }
}

/// @dev Answers inside `requestRandomness`, before the caller sees a request id.
contract InstantOracle is IRandomnessOracle {
    function requestRandomness(bytes32 context) external returns (bytes32) {
        IRandomnessConsumer(msg.sender).fulfillRandomness(context, keccak256("instant"));
        return context;
    }
}
