// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {ProtocolConfig} from "../../src/ProtocolConfig.sol";

/// @dev The per-epoch fee totals `GameEscrow` keeps for play-mining. A fee
///      counts once its match settles, in the epoch it settles in, and only in
///      a matchmade lobby.
contract FeeLedgerTest is Fixtures {
    /// @dev 5% of the fixtures' 1 ETH stake.
    uint256 private constant SEAT_FEE = 0.05 ether;
    uint256 private constant EPOCH = 7 days;

    function test_aSettledMatchCountsEverySeatsFee_inTheEpochItSettled() public {
        bytes32 matchId = _createMatchmadeAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(1)));
        _settleAndFinalize(matchId);

        uint256 epoch = block.timestamp / EPOCH;
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(escrow.feesPaid(players[i], epoch), SEAT_FEE);
        }
        assertEq(escrow.epochFees(epoch), 4 * SEAT_FEE);
    }

    /// @dev The exploit counting at join allowed: join a lobby that can never
    ///      fill, collect rewards on the fee, cancel for a full refund.
    /// @dev Anyone can open a private lobby and fill it with their own
    ///      wallets, so its fees must earn nothing.
    function test_aPrivateLobbyCountsNothing_evenSettled() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(1)));
        _settleAndFinalize(matchId);

        assertEq(escrow.feesPaid(players[0], block.timestamp / EPOCH), 0);
        assertEq(escrow.epochFees(block.timestamp / EPOCH), 0);
    }

    function test_joiningCountsNothing_soAnUnfillableLobbyEarnsNothing() public {
        bytes32 matchId = _createMatchmade(8, _firstPlayers(8));
        for (uint256 i = 0; i < 3; ++i) {
            vm.prank(players[i]);
            escrow.join{value: STAKE}(matchId);
        }

        uint256 epoch = block.timestamp / EPOCH;
        assertEq(escrow.feesPaid(players[0], epoch), 0);
        assertEq(escrow.epochFees(epoch), 0);

        vm.warp(block.timestamp + 1 hours);
        escrow.cancelMatch(matchId);
        assertEq(escrow.epochFees(epoch), 0);
    }

    function test_aMatchSettledInALaterWeekCountsInThatWeek() public {
        vm.warp(EPOCH - 30 minutes);
        bytes32 matchId = _createMatchmadeAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(1)));
        vm.warp(EPOCH + 1);
        _settleAndFinalize(matchId);

        assertEq(escrow.feesPaid(players[0], 0), 0, "the week it was joined in is untouched");
        assertEq(escrow.feesPaid(players[0], 1), SEAT_FEE);
        assertEq(escrow.epochFees(1), 4 * SEAT_FEE);
    }

    function test_aVetoedResultCountsNothing() public {
        bytes32 matchId = _createMatchmadeAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(2)));
        _propose(matchId, _rankingOf(matchId));

        vm.prank(owner);
        escrow.veto(matchId);

        assertEq(escrow.epochFees(block.timestamp / EPOCH), 0);
    }

    function test_aCrossChainSeatCountsOnceItsMatchSettles() public {
        address[] memory roster = _firstPlayers(4);
        roster[0] = players[7];
        bytes32 matchId = _createMatchmade(4, roster);
        vm.deal(bridge, STAKE);
        vm.prank(bridge);
        escrow.bridgeJoin{value: STAKE}(matchId, players[7], 421_614);
        for (uint256 i = 1; i < 4; ++i) {
            vm.prank(players[i]);
            escrow.join{value: STAKE}(matchId);
        }
        _lockAndSeed(matchId, bytes32(uint256(3)));
        _settleAndFinalize(matchId);

        assertEq(escrow.feesPaid(players[7], block.timestamp / EPOCH), SEAT_FEE);
    }

    function test_noFee_countsNothing() public {
        ProtocolConfig.Params memory params = config.getParams();
        params.feeBps = 0;
        vm.prank(owner);
        config.setParams(params);

        bytes32 matchId = _createMatchmadeAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(1)));
        _settleAndFinalize(matchId);
        assertEq(escrow.epochFees(block.timestamp / EPOCH), 0);
    }
}
