// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {MatchMarket} from "../../src/MatchMarket.sol";

contract MatchMarketTest is Fixtures {
    function test_winnerMarketPaysOnlyWinnerTickets() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(9)));

        vm.prank(players[0]);
        market.place{value: 1 ether}(matchId, MatchMarket.Kind.Winner, players[0]);
        vm.prank(players[1]);
        market.place{value: 3 ether}(matchId, MatchMarket.Kind.Winner, players[1]);

        address[] memory ranking = _rankingOf(matchId);
        // seats are join order = players[0..3]
        escrow.settle(
            matchId, 4, keccak256("h"), ranking, _signResult(_twoAttestors(), matchId, 4, keccak256("h"), ranking)
        );

        market.settle(matchId, MatchMarket.Kind.Winner);

        address[] memory outcomes = new address[](1);
        outcomes[0] = players[0];
        uint256 before = players[0].balance;
        vm.prank(players[0]);
        uint256 paid = market.claim(matchId, MatchMarket.Kind.Winner, outcomes);
        assertEq(paid, 4 ether);
        assertEq(players[0].balance, before + 4 ether);

        outcomes[0] = players[1];
        vm.prank(players[1]);
        vm.expectRevert(MatchMarket.NothingToClaim.selector);
        market.claim(matchId, MatchMarket.Kind.Winner, outcomes);
    }

    function test_top3SplitsPotAmongWinningTickets() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(10)));

        vm.prank(players[0]);
        market.place{value: 1 ether}(matchId, MatchMarket.Kind.Top3, players[0]);
        vm.prank(players[1]);
        market.place{value: 1 ether}(matchId, MatchMarket.Kind.Top3, players[1]);
        vm.prank(players[2]);
        market.place{value: 1 ether}(matchId, MatchMarket.Kind.Top3, players[2]);
        vm.prank(players[3]);
        market.place{value: 1 ether}(matchId, MatchMarket.Kind.Top3, players[3]);

        address[] memory ranking = _rankingOf(matchId);
        escrow.settle(
            matchId, 3, keccak256("t"), ranking, _signResult(_twoAttestors(), matchId, 3, keccak256("t"), ranking)
        );
        market.settle(matchId, MatchMarket.Kind.Top3);

        // ranking is join order: 0,1,2 win; 3 loses. Winning stake = 3 ether, pot = 4.
        address[] memory outcomes = new address[](1);
        outcomes[0] = players[0];
        vm.prank(players[0]);
        uint256 paid = market.claim(matchId, MatchMarket.Kind.Top3, outcomes);
        assertEq(paid, (uint256(1 ether) * 4) / 3);
    }

    function test_abortRefundsWhenMatchCancelled() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        vm.prank(players[0]);
        escrow.join{value: STAKE}(matchId);

        vm.prank(players[1]);
        market.place{value: 2 ether}(matchId, MatchMarket.Kind.Winner, players[0]);

        vm.warp(block.timestamp + 1 hours);
        escrow.cancelMatch(matchId);
        market.abort(matchId, MatchMarket.Kind.Winner);

        address[] memory outcomes = new address[](1);
        outcomes[0] = players[0];
        uint256 before = players[1].balance;
        vm.prank(players[1]);
        uint256 refunded = market.claim(matchId, MatchMarket.Kind.Winner, outcomes);
        assertEq(refunded, 2 ether);
        assertEq(players[1].balance, before + 2 ether);
    }

    function test_cannotBetAfterSettlement() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(11)));
        address[] memory ranking = _rankingOf(matchId);
        escrow.settle(
            matchId, 1, keccak256("x"), ranking, _signResult(_twoAttestors(), matchId, 1, keccak256("x"), ranking)
        );
        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(MatchMarket.BettingClosed.selector, matchId));
        market.place{value: 1 ether}(matchId, MatchMarket.Kind.Winner, players[0]);
    }
}
