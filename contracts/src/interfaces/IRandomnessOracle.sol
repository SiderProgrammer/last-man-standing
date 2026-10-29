// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Source of the per-match seed that every roll in the match is drawn from.
/// @dev Kept deliberately narrow so a Chainlink VRF v2.5 subscription, a
///      drand relay, or a test double can all sit behind it. The seed must be
///      unknowable to players and to the server until the match is locked,
///      otherwise a player could pick moves against known rolls.
interface IRandomnessOracle {
    /// @param context Caller-scoped identifier, in practice the match id. The
    ///        oracle hands it back with the answer.
    /// @return requestId The oracle's own handle, for logs.
    function requestRandomness(bytes32 context) external returns (bytes32 requestId);
}

/// @notice Callback surface implemented by anything that requests randomness.
interface IRandomnessConsumer {
    /// @dev Implementations must reject calls from anyone but the oracle they
    ///      asked. `context` is what the request passed in, so a consumer needs
    ///      no record of the request to know what it answers.
    function fulfillRandomness(bytes32 context, bytes32 randomness) external;
}
