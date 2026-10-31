// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {ExpiringPause} from "../../src/ExpiringPause.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev Matchmade lobbies: opened by the config's matchmaker with a roster,
///      and joinable by that roster alone, whichever route the stake takes.
contract MatchmakingTest is Fixtures {
    function test_onlyTheMatchmakerOpensAMatchmadeLobby() public {
        address[] memory roster = _firstPlayers(4);
        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.NotMatchmaker.selector, players[0]));
        escrow.createMatchmade(STAKE, 4, roster);

        vm.expectEmit(false, false, false, true);
        emit GameEscrow.MatchRostered(bytes32(0), roster);
        bytes32 matchId = _createMatchmade(4, roster);
        assertTrue(escrow.getMatch(matchId).matchmade);
        assertTrue(escrow.rostered(matchId, players[3]));
        assertFalse(escrow.rostered(matchId, players[4]));
    }

    function test_aPrivateLobbyIsNotMatchmade() public {
        bytes32 matchId = _createAndFill(4);
        assertFalse(escrow.getMatch(matchId).matchmade);
    }

    function test_theRosterJoins_andNobodyElse() public {
        bytes32 matchId = _createMatchmade(4, _firstPlayers(4));
        vm.prank(players[0]);
        escrow.join{value: STAKE}(matchId);

        vm.prank(players[5]);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.NotRostered.selector, matchId, players[5]));
        escrow.join{value: STAKE}(matchId);
    }

    /// @dev `joinFor` seats the player named, not the payer: the roster is
    ///      checked against the seat.
    function test_payingForSomeoneOffTheRosterIsRefused() public {
        bytes32 matchId = _createMatchmade(4, _firstPlayers(4));
        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.NotRostered.selector, matchId, players[6]));
        escrow.joinFor{value: STAKE}(matchId, players[6]);

        vm.prank(players[6]);
        escrow.joinFor{value: STAKE}(matchId, players[1]);
        assertTrue(escrow.hasSeat(matchId, players[1]));
    }

    function test_aBridgedStakeForSomeoneOffTheRosterIsCreditedBack() public {
        bytes32 matchId = _createMatchmade(4, _firstPlayers(4));
        vm.deal(bridge, STAKE);
        vm.expectEmit(true, true, false, true);
        emit GameEscrow.JoinRefunded(matchId, players[7], STAKE, GameEscrow.JoinFailure.NotRostered);
        vm.prank(bridge);
        escrow.bridgeJoin{value: STAKE}(matchId, players[7], 421_614);

        assertFalse(escrow.hasSeat(matchId, players[7]));
        assertEq(escrow.withdrawable(players[7]), STAKE);
    }

    /// @dev More on the roster than seats: a no-show does not sink the lobby.
    function test_aRosterLongerThanTheLobbySeatsTheFirstToStake() public {
        bytes32 matchId = _createMatchmade(4, _firstPlayers(6));
        for (uint256 i = 1; i < 5; ++i) {
            vm.prank(players[i]);
            escrow.join{value: STAKE}(matchId);
        }
        vm.prank(players[5]);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.LobbyFull.selector, matchId));
        escrow.join{value: STAKE}(matchId);
    }

    function test_onlyTheOwnerNamesTheMatchmaker() public {
        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, players[0]));
        config.setMatchmaker(players[0]);

        vm.prank(owner);
        config.setMatchmaker(address(0));
        vm.prank(matchmaker);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.NotMatchmaker.selector, matchmaker));
        escrow.createMatchmade(STAKE, 4, _firstPlayers(4));
    }

    function test_aPauseStopsMatchmadeLobbiesToo() public {
        _pause();
        address[] memory roster = _firstPlayers(4);
        vm.prank(matchmaker);
        vm.expectRevert(ExpiringPause.EnforcedPause.selector);
        escrow.createMatchmade(STAKE, 4, roster);
    }
}
