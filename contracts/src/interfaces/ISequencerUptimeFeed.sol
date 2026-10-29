// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The part of Chainlink's `AggregatorV3Interface` an L2 sequencer
///         uptime feed is read through.
/// @dev `answer` is 0 while the sequencer is up and 1 while it is down.
///      `startedAt` is when it last changed.
interface ISequencerUptimeFeed {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
