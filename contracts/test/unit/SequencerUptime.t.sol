// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {MockSequencerUptimeFeed} from "../../src/mocks/MockSequencerUptimeFeed.sol";

/// @dev Nobody can veto while the L2 sequencer is down, so `finalize` waits
///      until it has been back up for an hour.
contract SequencerUptimeTest is Fixtures {
    MockSequencerUptimeFeed internal feed;
    bytes32 internal matchId;
    address[] internal ranking;

    function setUp() public override {
        super.setUp();
        vm.warp(1_000_000);
        feed = new MockSequencerUptimeFeed();
        feed.set(true, 1);
        vm.prank(owner);
        config.setSequencerUptimeFeed(address(feed));

        matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(1)));
        ranking = _rankingOf(matchId);
        _propose(matchId, ranking);
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
    }

    function test_finalizesWhileTheSequencerHasBeenUp() public {
        escrow.finalize(matchId, ranking);
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Settled));
    }

    function test_refusesWhileTheSequencerIsDown() public {
        feed.set(false, block.timestamp - 10 minutes);
        vm.expectRevert(GameEscrow.SequencerDown.selector);
        escrow.finalize(matchId, ranking);
    }

    function test_waitsOutTheGracePeriodAfterAnOutage() public {
        uint256 backUp = block.timestamp - 10 minutes;
        feed.set(true, backUp);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.SequencerGracePeriod.selector, backUp + 1 hours));
        escrow.finalize(matchId, ranking);

        vm.warp(backUp + 1 hours);
        escrow.finalize(matchId, ranking);
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Settled));
    }

    function test_noFeedMeansNoCheck() public {
        feed.set(false, block.timestamp);
        vm.prank(owner);
        config.setSequencerUptimeFeed(address(0));
        escrow.finalize(matchId, ranking);
    }
}
