// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICrossChainMessenger, ICrossChainReceiver} from "../interfaces/ICrossChainMessenger.sol";

/// @notice Test double for a value-carrying cross-chain transport.
/// @dev Both directions are modelled. `deliver` plays the part of the remote
///      chain calling into the hub, and `sendMessage` records what the hub
///      pushed outward so tests can assert on bridged withdrawals without a
///      second EVM instance.
contract MockMessenger is ICrossChainMessenger {
    struct SentMessage {
        uint32 dstChainId;
        bytes32 receiver;
        bytes payload;
        uint256 value;
    }

    SentMessage[] public sent;
    uint256 public fee;

    event MessageSent(bytes32 indexed messageId, uint32 indexed dstChainId, uint256 value);

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function sentCount() external view returns (uint256) {
        return sent.length;
    }

    function getSent(uint256 index) external view returns (SentMessage memory) {
        return sent[index];
    }

    /// @inheritdoc ICrossChainMessenger
    function sendMessage(uint32 dstChainId, bytes32 receiver, bytes calldata payload)
        external
        payable
        returns (bytes32 messageId)
    {
        sent.push(
            SentMessage({
                dstChainId: dstChainId,
                receiver: receiver,
                payload: payload,
                value: msg.value - fee
            })
        );
        messageId = keccak256(abi.encode(dstChainId, receiver, payload, sent.length));
        emit MessageSent(messageId, dstChainId, msg.value);
    }

    /// @inheritdoc ICrossChainMessenger
    function quote(uint32, bytes32, bytes calldata) external view returns (uint256) {
        return fee;
    }

    /// @notice Simulates inbound delivery from a remote chain.
    function deliver(
        address target,
        uint32 srcChainId,
        bytes32 srcSender,
        bytes calldata payload,
        uint256 value
    ) external payable {
        ICrossChainReceiver(target).receiveMessage{value: value}(srcChainId, srcSender, payload);
    }

    receive() external payable {}
}
