// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {ISequencerUptimeFeed} from "../../src/interfaces/ISequencerUptimeFeed.sol";
import {SEQUENCER_GRACE_PERIOD} from "../../src/Constants.sol";

/// @dev The rest of Chainlink's `AggregatorV3Interface`, which only this test reads.
interface IAggregatorRounds is ISequencerUptimeFeed {
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80 roundId_, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @dev `finalize` against Chainlink's real L2 sequencer uptime feed on Base,
///      the one `Deploy` sets there. This proves the escrow reads the deployed
///      feed's answer and `startedAt` the way the feed reports them; the unit
///      suite runs against `MockSequencerUptimeFeed` and cannot.
///
///      The grace check is run against the feed's own last restart: the round
///      before the latest says the sequencer was down, so the latest round's
///      `startedAt` is when it came back.
///
///      Opt-in, because it needs an RPC: `BASE_RPC_URL=… forge test --match-path test/fork/*`.
///      Skipped otherwise.
contract SequencerFeedForkTest is Fixtures {
    IAggregatorRounds private constant FEED = IAggregatorRounds(0xBCF85224fc0756B9Fa45aA7892530B47e10b6433);

    function setUp() public override {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        super.setUp();
        vm.prank(owner);
        config.setSequencerUptimeFeed(address(FEED));
    }

    function test_fork_aResultFinalisesWhileTheSequencerIsUp() public {
        (, int256 answer, uint256 startedAt,,) = FEED.latestRoundData();
        assertEq(answer, 0, "sequencer up");
        assertLe(startedAt + SEQUENCER_GRACE_PERIOD, block.timestamp, "past the grace");

        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, keccak256("seed"));
        _settleAndFinalize(matchId);
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Settled));
    }

    /// @dev A result whose challenge window closed just after the last
    ///      restart waits out the grace period from that restart.
    function test_fork_aResultWaitsOutTheGraceAfterTheLastRestart() public {
        (uint80 roundId, int256 answer, uint256 backUp,,) = FEED.latestRoundData();
        assertEq(answer, 0);
        (, int256 before,,,) = FEED.getRoundData(roundId - 1);
        assertEq(before, 1, "the round before is an outage");

        // Proposed before the outage, so its window closes ten minutes after it.
        vm.warp(backUp + 10 minutes - CHALLENGE_WINDOW);
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, keccak256("seed"));
        address[] memory ranking = _rankingOf(matchId);
        _propose(matchId, ranking);

        vm.warp(backUp + 10 minutes);
        vm.expectRevert(
            abi.encodeWithSelector(GameEscrow.SequencerGracePeriod.selector, backUp + SEQUENCER_GRACE_PERIOD)
        );
        escrow.finalize(matchId, ranking);

        vm.warp(backUp + SEQUENCER_GRACE_PERIOD);
        escrow.finalize(matchId, ranking);
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Settled));
    }
}
