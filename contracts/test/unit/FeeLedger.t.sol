// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {ProtocolConfig} from "../../src/ProtocolConfig.sol";

/// @dev The per-epoch fee totals `GameEscrow` keeps for play-mining. A fee
///      counts once its match settles, in the epoch it settles in.
contract FeeLedgerTest is Fixtures {
    /// @dev 5% of the fixtures' 1 ETH stake.
    uint256 private constant SEAT_FEE = 0.05 ether;
    uint256 private constant EPOCH = 7 days;

    function test_aSettledMatchCountsEverySeatsFee_inTheEpochItSettled() public {
        bytes32 matchId = _createAndFill(4);
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
    function test_joiningCountsNothing_soAnUnfillableLobbyEarnsNothing() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 8);
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
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(1)));
        vm.warp(EPOCH + 1);
        _settleAndFinalize(matchId);

        assertEq(escrow.feesPaid(players[0], 0), 0, "the week it was joined in is untouched");
        assertEq(escrow.feesPaid(players[0], 1), SEAT_FEE);
        assertEq(escrow.epochFees(1), 4 * SEAT_FEE);
    }

    function test_aVetoedResultCountsNothing() public {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(2)));
        _propose(matchId, _rankingOf(matchId));

        vm.prank(owner);
        escrow.veto(matchId);

        assertEq(escrow.epochFees(block.timestamp / EPOCH), 0);
    }

    function test_aCrossChainSeatCountsOnceItsMatchSettles() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        bytes32 peer = bytes32(uint256(uint160(address(0xBEEF))));
        vm.deal(address(messenger), STAKE);
        vm.prank(address(messenger));
        escrow.receiveMessage{value: STAKE}(421_614, peer, abi.encode(matchId, players[7]));
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

        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(1)));
        _settleAndFinalize(matchId);
        assertEq(escrow.epochFees(block.timestamp / EPOCH), 0);
    }
}
