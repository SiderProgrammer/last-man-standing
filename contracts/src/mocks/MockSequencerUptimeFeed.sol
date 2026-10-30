// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISequencerUptimeFeed} from "../interfaces/ISequencerUptimeFeed.sol";

/// @notice Test double for a Chainlink L2 sequencer uptime feed.
contract MockSequencerUptimeFeed is ISequencerUptimeFeed {
    int256 public answer;
    uint256 public startedAt;

    function set(bool up, uint256 since) external {
        answer = up ? int256(0) : int256(1);
        startedAt = since;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, startedAt, startedAt, 1);
    }
}
