// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal LayerZero v2 endpoint surface used by the messenger adapter.
interface ILayerZeroEndpoint {
    struct MessagingParams {
        uint32 dstEid;
        bytes32 receiver;
        bytes message;
        bytes options;
        bool payInLzToken;
    }

    struct MessagingReceipt {
        bytes32 guid;
        uint64 nonce;
        uint256 nativeFee;
        uint256 lzTokenFee;
    }

    function send(MessagingParams calldata params, address refundAddress)
        external
        payable
        returns (MessagingReceipt memory);

    function quote(MessagingParams calldata params, address sender)
        external
        view
        returns (uint256 nativeFee, uint256 lzTokenFee);
}

/// @notice LayerZero v2 receive path. The adapter translates this into `ICrossChainReceiver`.
interface ILayerZeroReceiver {
    function lzReceive(
        uint32 srcEid,
        bytes32 srcSender,
        bytes32 guid,
        bytes calldata message
    ) external payable;
}
