// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVrfCoordinator, IVrfConsumer} from "../interfaces/IVrfCoordinator.sol";
import {UnknownRequest} from "../Errors.sol";

/// @notice Test double for a Chainlink VRF v2.5 coordinator.
contract MockVrfCoordinator is IVrfCoordinator {
    mapping(uint256 requestId => address consumer) public consumers;
    uint256 public nonce;

    function requestRandomWords(bytes32, uint256, uint16, uint32, uint32)
        external
        returns (uint256 requestId)
    {
        requestId = ++nonce;
        consumers[requestId] = msg.sender;
    }

    function fulfill(uint256 requestId, uint256 word) external {
        address consumer = consumers[requestId];
        if (consumer == address(0)) revert UnknownRequest(bytes32(requestId));
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        IVrfConsumer(consumer).rawFulfillRandomWords(requestId, words);
    }
}
