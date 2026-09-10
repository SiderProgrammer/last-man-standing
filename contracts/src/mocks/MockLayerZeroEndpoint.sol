// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ILayerZeroEndpoint, ILayerZeroReceiver} from "../interfaces/ILayerZeroEndpoint.sol";

/// @notice Test double for a LayerZero v2 endpoint.
contract MockLayerZeroEndpoint is ILayerZeroEndpoint {
    uint256 public fee;
    uint64 public nonce;

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function send(MessagingParams calldata params, address)
        external
        payable
        returns (MessagingReceipt memory receipt)
    {
        nonce += 1;
        receipt = MessagingReceipt({
            guid: keccak256(abi.encode(params.dstEid, params.receiver, params.message, nonce)),
            nonce: nonce,
            nativeFee: fee,
            lzTokenFee: 0
        });
    }

    function quote(MessagingParams calldata, address) external view returns (uint256, uint256) {
        return (fee, 0);
    }

    function deliver(
        address target,
        uint32 srcEid,
        bytes32 srcSender,
        bytes calldata message,
        uint256 value
    ) external payable {
        ILayerZeroReceiver(target).lzReceive{value: value}(srcEid, srcSender, bytes32(0), message);
    }
}
