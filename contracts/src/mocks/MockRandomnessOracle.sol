// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IRandomnessOracle, IRandomnessConsumer} from "../interfaces/IRandomnessOracle.sol";
import {UnknownRequest} from "../Errors.sol";

/// @notice Test double for the randomness oracle.
/// @dev Fulfilment is always a separate call, as with Chainlink VRF: request
///      now, callback later. That window is where the "oracle never answered"
///      cancellation path lives. Off-chain, `npm run dev:fork` plays the
///      oracle node, answering each request in a later block.
contract MockRandomnessOracle is IRandomnessOracle {
    struct Request {
        address consumer;
        bytes32 context;
        bool fulfilled;
    }

    mapping(bytes32 requestId => Request) public requests;
    uint256 public nonce;

    event RandomnessRequested(bytes32 indexed requestId, address indexed consumer, bytes32 context);

    error AlreadyFulfilled(bytes32 requestId);

    /// @inheritdoc IRandomnessOracle
    function requestRandomness(bytes32 context) external returns (bytes32 requestId) {
        requestId = keccak256(abi.encode(msg.sender, context, nonce++));
        requests[requestId] = Request({consumer: msg.sender, context: context, fulfilled: false});

        emit RandomnessRequested(requestId, msg.sender, context);
    }

    /// @notice Delivers a chosen value, so tests can pin a seed exactly.
    /// @dev Permissionless: this is a test double, and whoever calls it picks
    ///      the seed. Never deploy it where a stake is worth anything.
    function fulfill(bytes32 requestId, bytes32 randomness) external {
        _fulfill(requestId, randomness);
    }

    function _fulfill(bytes32 requestId, bytes32 randomness) private {
        Request storage request = requests[requestId];
        if (request.consumer == address(0)) revert UnknownRequest(requestId);
        if (request.fulfilled) revert AlreadyFulfilled(requestId);

        request.fulfilled = true;
        IRandomnessConsumer(request.consumer).fulfillRandomness(request.context, randomness);
    }
}
