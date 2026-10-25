// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Source of the per-match seed that every roll in the match is drawn from.
/// @dev Kept deliberately narrow so a Chainlink VRF v2.5 subscription, a
///      drand relay, or a test double can all sit behind it. The seed must be
///      unknowable to players and to the server until the match is locked,
///      otherwise a player could pick moves against known rolls.
interface IRandomnessOracle {
    /// @param context Caller-scoped identifier, in practice the match id.
    /// @return requestId Handle the oracle will fulfil against.
    function requestRandomness(bytes32 context) external returns (bytes32 requestId);
}

/// @notice Callback surface implemented by anything that requests randomness.
interface IRandomnessConsumer {
    /// @dev Implementations must reject calls from anyone but the configured oracle.
    function fulfillRandomness(bytes32 requestId, bytes32 randomness) external;
}
