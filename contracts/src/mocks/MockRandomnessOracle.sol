// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IRandomnessOracle, IRandomnessConsumer} from "../interfaces/IRandomnessOracle.sol";

/// @notice Test double for the randomness oracle.
/// @dev Fulfilment is manual by default so tests can exercise the window
///      between locking a lobby and receiving a seed, which is exactly where
///      the "oracle never answered" cancellation path lives. A Chainlink VRF
///      adapter behaves the same way: request now, callback later.
contract MockRandomnessOracle is IRandomnessOracle {
    struct Request {
        address consumer;
        bytes32 context;
        bool fulfilled;
    }

    mapping(bytes32 requestId => Request) public requests;
    uint256 public nonce;

    /// @notice When true, a request is fulfilled inside the same transaction.
    bool public autoFulfill;

    event RandomnessRequested(bytes32 indexed requestId, address indexed consumer, bytes32 context);

    error UnknownRequest(bytes32 requestId);
    error AlreadyFulfilled(bytes32 requestId);

    function setAutoFulfill(bool enabled) external {
        autoFulfill = enabled;
    }

    /// @inheritdoc IRandomnessOracle
    function requestRandomness(bytes32 context) external returns (bytes32 requestId) {
        requestId = keccak256(abi.encode(msg.sender, context, nonce++));
        requests[requestId] = Request({consumer: msg.sender, context: context, fulfilled: false});

        emit RandomnessRequested(requestId, msg.sender, context);

        if (autoFulfill) {
            _fulfill(requestId, keccak256(abi.encode(requestId, block.prevrandao)));
        }
    }

    /// @notice Delivers a chosen value, so tests can pin a seed exactly.
    function fulfill(bytes32 requestId, bytes32 randomness) external {
        _fulfill(requestId, randomness);
    }

    function _fulfill(bytes32 requestId, bytes32 randomness) private {
        Request storage request = requests[requestId];
        if (request.consumer == address(0)) revert UnknownRequest(requestId);
        if (request.fulfilled) revert AlreadyFulfilled(requestId);

        request.fulfilled = true;
        IRandomnessConsumer(request.consumer).fulfillRandomness(requestId, randomness);
    }
}
