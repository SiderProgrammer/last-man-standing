// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VRFV2PlusClient} from "../vendor/chainlink/VRFV2PlusClient.sol";
import {UnknownRequest} from "../Errors.sol";

interface IVrfCallback {
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}

/// @notice Test double for a Chainlink VRF v2.5 coordinator: the request half
///         of `IVRFCoordinatorV2Plus`, and a `fulfill` that plays the node.
contract MockVrfCoordinator {
    mapping(uint256 requestId => address consumer) public consumers;
    uint256 public nonce;
    /// @notice The last request, as the coordinator received it.
    VRFV2PlusClient.RandomWordsRequest public lastRequest;

    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req)
        external
        returns (uint256 requestId)
    {
        requestId = ++nonce;
        consumers[requestId] = msg.sender;
        lastRequest = req;
    }

    function fulfill(uint256 requestId, uint256 word) external {
        address consumer = consumers[requestId];
        if (consumer == address(0)) revert UnknownRequest(bytes32(requestId));
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        IVrfCallback(consumer).rawFulfillRandomWords(requestId, words);
    }
}
