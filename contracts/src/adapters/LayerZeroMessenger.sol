// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ICrossChainMessenger, ICrossChainReceiver} from "../interfaces/ICrossChainMessenger.sol";
import {ILayerZeroEndpoint, ILayerZeroReceiver} from "../interfaces/ILayerZeroEndpoint.sol";

/// @title LayerZeroMessenger
/// @notice Adapts LayerZero v2 send/receive to the protocol's messenger interface.
///
/// @dev Value-carrying joins rely on the caller attaching the stake as `msg.value`
///      on top of the LZ fee, and on `_options` encoding a native drop of that
///      stake on the destination. The options bytes are therefore part of the
///      send path, not of `ICrossChainMessenger.quote`'s three-argument form;
///      `quote` returns the LZ fee only, and `sendMessage` forwards `msg.value`
///      in full to the endpoint (fee + drop).
contract LayerZeroMessenger is Ownable, ICrossChainMessenger, ILayerZeroReceiver {
    ILayerZeroEndpoint public immutable endpoint;
    address public receiver;
    bytes public defaultOptions;

    event ReceiverSet(address indexed receiver);
    event OptionsSet(bytes options);

    error ZeroAddress();
    error NotEndpoint(address caller);
    error NoReceiver();

    constructor(address owner_, ILayerZeroEndpoint endpoint_, address receiver_, bytes memory options_)
        Ownable(owner_)
    {
        if (address(endpoint_) == address(0)) revert ZeroAddress();
        endpoint = endpoint_;
        _setReceiver(receiver_);
        defaultOptions = options_;
    }

    function setReceiver(address receiver_) external onlyOwner {
        _setReceiver(receiver_);
    }

    function setDefaultOptions(bytes calldata options_) external onlyOwner {
        defaultOptions = options_;
        emit OptionsSet(options_);
    }

    /// @inheritdoc ICrossChainMessenger
    function sendMessage(uint32 dstChainId, bytes32 dstReceiver, bytes calldata payload)
        external
        payable
        returns (bytes32 messageId)
    {
        ILayerZeroEndpoint.MessagingReceipt memory receipt = endpoint.send{value: msg.value}(
            ILayerZeroEndpoint.MessagingParams({
                dstEid: dstChainId,
                receiver: dstReceiver,
                message: abi.encode(msg.sender, payload),
                options: defaultOptions,
                payInLzToken: false
            }),
            msg.sender
        );
        messageId = receipt.guid;
    }

    /// @inheritdoc ICrossChainMessenger
    function quote(uint32 dstChainId, bytes32 dstReceiver, bytes calldata payload)
        external
        view
        returns (uint256 nativeFee)
    {
        (nativeFee,) = endpoint.quote(
            ILayerZeroEndpoint.MessagingParams({
                dstEid: dstChainId,
                receiver: dstReceiver,
                message: abi.encode(msg.sender, payload),
                options: defaultOptions,
                payInLzToken: false
            }),
            msg.sender
        );
    }

    /// @inheritdoc ILayerZeroReceiver
    function lzReceive(uint32 srcEid, bytes32 srcSender, bytes32, bytes calldata message)
        external
        payable
    {
        if (msg.sender != address(endpoint)) revert NotEndpoint(msg.sender);
        if (receiver == address(0)) revert NoReceiver();

        // Inner envelope is `(originalSender, payload)`. The trusted peer is
        // the remote messenger (`srcSender`), not the original user.
        (, bytes memory payload) = abi.decode(message, (address, bytes));
        ICrossChainReceiver(receiver).receiveMessage{value: msg.value}(srcEid, srcSender, payload);
    }

    function _setReceiver(address receiver_) private {
        receiver = receiver_;
        emit ReceiverSet(receiver_);
    }
}
