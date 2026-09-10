// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal Chainlink VRF v2.5 coordinator surface used by the adapter.
/// @dev Kept local so the repo does not have to vendor the full VRF package.
interface IVrfCoordinator {
    function requestRandomWords(
        bytes32 keyHash,
        uint256 subId,
        uint16 requestConfirmations,
        uint32 callbackGasLimit,
        uint32 numWords
    ) external returns (uint256 requestId);
}

/// @notice Callback the coordinator uses to deliver words to a consumer.
interface IVrfConsumer {
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}
