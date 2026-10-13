// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ILayerZeroEndpoint, ILayerZeroReceiver, Origin} from "../interfaces/ILayerZeroEndpoint.sol";

/// @notice Test double for a LayerZero v2 endpoint.
/// @dev Prices a message the way the real one does in outline: a flat fee plus
///      the native value the executor options ask to deliver. `send` records
///      each message so a test can hand it to the destination with `deliver`.
contract MockLayerZeroEndpoint is ILayerZeroEndpoint {
    struct Sent {
        uint32 dstEid;
        bytes32 receiver;
        bytes message;
        bytes options;
        uint128 value;
    }

    uint256 public fee;
    uint64 public nonce;
    Sent[] private sent;

    error Underpaid(uint256 sent, uint256 required);

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function sentCount() external view returns (uint256) {
        return sent.length;
    }

    function getSent(uint256 index) external view returns (Sent memory) {
        return sent[index];
    }

    function send(MessagingParams calldata params, address)
        external
        payable
        returns (MessagingReceipt memory receipt)
    {
        uint128 value = deliveredValue(params.options);
        if (msg.value < fee + value) revert Underpaid(msg.value, fee + value);
        sent.push(Sent(params.dstEid, params.receiver, params.message, params.options, value));
        nonce += 1;
        receipt = MessagingReceipt({
            guid: keccak256(abi.encode(params.dstEid, params.receiver, params.message, nonce)),
            nonce: nonce,
            fee: MessagingFee({nativeFee: fee + value, lzTokenFee: 0})
        });
    }

    function quote(MessagingParams calldata params, address) external view returns (MessagingFee memory) {
        return MessagingFee({nativeFee: fee + deliveredValue(params.options), lzTokenFee: 0});
    }

    /// @notice Plays the destination endpoint: calls `lzReceive` with `value`.
    function deliver(address target, uint32 srcEid, bytes32 srcSender, bytes calldata message, uint256 value)
        external
        payable
    {
        ILayerZeroReceiver(target).lzReceive{value: value}(
            Origin({srcEid: srcEid, sender: srcSender, nonce: nonce}), bytes32(0), message, msg.sender, ""
        );
    }

    /// @dev Type-3 options holding one executor `lzReceive` option:
    ///      `uint16 type | uint8 worker | uint16 size | uint8 optionType | uint128 gas [| uint128 value]`.
    function deliveredValue(bytes calldata options) public pure returns (uint128 value) {
        if (options.length < 38) return 0;
        value = uint128(bytes16(options[22:38]));
    }
}
