// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {MockMessenger} from "../../src/mocks/MockMessenger.sol";
import {ProtocolConfig} from "../../src/ProtocolConfig.sol";

contract GameEscrowTest is Fixtures {
    function test_createMatch_snapshotsTerms() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);

        assertEq(info.stake, STAKE);
        assertEq(info.feeBps, 500);
        assertEq(info.minSeats, 4);
        assertEq(info.maxSeats, 4);
        assertEq(uint8(info.status), uint8(GameEscrow.MatchStatus.Open));
        assertEq(info.rulesHash, config.rulesHash());
        assertEq(escrow.getPayoutSchedule(matchId)[0], 10_000);
    }

    function test_createMatch_rejectsStakeOutOfRange() public {
        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.StakeOutOfRange.selector, uint128(1)));
        escrow.createMatch(1, 4);
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

    function test_settle_creditsWinnerAndTreasury() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(0x51)));

        address[] memory ranking = _rankingOf(matchId);
        bytes32 historyRoot = keccak256("history");
        bytes memory sigs = _signResult(_twoAttestors(), matchId, 7, historyRoot, ranking);

        escrow.settle(matchId, 7, historyRoot, ranking, sigs);

        GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
        assertEq(uint8(info.status), uint8(GameEscrow.MatchStatus.Settled));
        assertEq(info.historyRoot, historyRoot);
        assertEq(escrow.getRanking(matchId)[0], ranking[0]);

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
        vm.expectRevert();
        escrow.settle(matchId, 3, historyRoot, ranking, bad);

        address[] memory shuffled = new address[](4);
        shuffled[0] = ranking[0];
        shuffled[1] = ranking[1];
        shuffled[2] = ranking[2];
        shuffled[3] = treasury; // not a seat
        bytes memory sigs = _signResult(_twoAttestors(), matchId, 3, historyRoot, shuffled);
        vm.expectRevert();
        escrow.settle(matchId, 3, historyRoot, shuffled, sigs);
    }

    function test_settle_rejectsSingleAttestorWhenThresholdIsTwo() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(3)));
        address[] memory ranking = _rankingOf(matchId);
        uint256[] memory one = new uint256[](1);
        one[0] = ATTESTOR_PK_A;
        bytes memory sigs = _signResult(one, matchId, 1, keccak256("r"), ranking);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.QuorumNotMet.selector, uint256(1), uint32(2)));
        escrow.settle(matchId, 1, keccak256("r"), ranking, sigs);
    }

    function test_withdraw_paysRecipient() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(4)));
        address[] memory ranking = _rankingOf(matchId);
        escrow.settle(matchId, 5, keccak256("h"), ranking, _signResult(_twoAttestors(), matchId, 5, keccak256("h"), ranking));

        uint256 before = players[0].balance;
        uint256 owed = escrow.withdrawable(ranking[0]);
        vm.prank(ranking[0]);
        uint256 paid = escrow.withdraw(ranking[0]);
        assertEq(paid, owed);
        assertEq(ranking[0].balance, before + owed);
        assertEq(escrow.withdrawable(ranking[0]), 0);
        assertEq(address(escrow).balance, escrow.totalOwed() + escrow.totalEscrowed());
    }

    function test_withdrawToChain_forwardsValue() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(5)));
        address[] memory ranking = _rankingOf(matchId);
        escrow.settle(matchId, 2, keccak256("h2"), ranking, _signResult(_twoAttestors(), matchId, 2, keccak256("h2"), ranking));

        uint256 owed = escrow.withdrawable(ranking[0]);
        vm.prank(ranking[0]);
        escrow.withdrawToChain(421_614);
        assertEq(escrow.withdrawable(ranking[0]), 0);
        assertEq(messenger.sentCount(), 1);
        MockMessenger.SentMessage memory sent = messenger.getSent(0);
        assertEq(sent.dstChainId, 421_614);
        assertEq(sent.value, owed);
        (address who, uint256 amount) = abi.decode(sent.payload, (address, uint256));
        assertEq(who, ranking[0]);
        assertEq(amount, owed);
    }

    function test_crossChainJoin_viaTrustedMessenger() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);

        vm.prank(players[0]);
        escrow.join{value: STAKE}(matchId);

        address remotePlayer = makeAddr("remote");
        bytes32 peer = config.peerFor(421_614);
        messenger.deliver{value: STAKE}(address(escrow), 421_614, peer, abi.encode(matchId, remotePlayer), STAKE);

        assertTrue(escrow.hasSeat(matchId, remotePlayer));
        assertEq(escrow.seatOrigin(matchId, remotePlayer), 421_614);
        assertEq(escrow.getSeats(matchId).length, 2);
    }

    function test_crossChainJoin_rejectsUntrustedMessengerAndPeer() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        bytes32 peer = config.peerFor(421_614);
        bytes memory payload = abi.encode(matchId, players[1]);

        vm.expectRevert(
            abi.encodeWithSelector(GameEscrow.UntrustedMessenger.selector, uint32(421_614), address(this))
        );
        escrow.receiveMessage{value: STAKE}(421_614, peer, payload);

        vm.prank(address(messenger));
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.UntrustedPeer.selector, uint32(421_614), bytes32(uint256(1))));
        escrow.receiveMessage{value: STAKE}(421_614, bytes32(uint256(1)), payload);
    }

    function test_pause_blocksJoinButNotWithdrawOrCancel() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(6)));
        address[] memory ranking = _rankingOf(matchId);
        escrow.settle(
            matchId, 1, keccak256("p"), ranking, _signResult(_twoAttestors(), matchId, 1, keccak256("p"), ranking)
        );

        vm.prank(owner);
        escrow.setPaused(true);

        vm.prank(players[0]);
        vm.expectRevert(GameEscrow.Paused.selector);
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
        bytes32 requestId = escrow.lockMatch(matchId);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.NotOracle.selector, address(this)));
        escrow.fulfillRandomness(requestId, bytes32(uint256(1)));
    }

    function test_governanceParamsChange_doesNotAffectOpenMatch() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);

        ProtocolConfig.Params memory next = config.getParams();
        next.feeBps = 100;
        vm.prank(owner);
        config.setParams(next);

        assertEq(escrow.getMatch(matchId).feeBps, 500);
    }
}
