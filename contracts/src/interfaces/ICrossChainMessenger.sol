// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Transport abstraction for hub/spoke messaging between chains.
/// @dev The hub chain owns match state and escrowed value; spoke chains hold
///      local stakes and forward joins. Modelled on LayerZero v2's send/lzReceive
///      shape but transport-agnostic, so the adapter can be swapped without
///      touching game logic.
interface ICrossChainMessenger {
    /// @param dstChainId Destination chain, in the transport's own id space.
    /// @param receiver Contract on the destination chain that will be called.
    /// @param payload Opaque application message.
    function sendMessage(uint32 dstChainId, bytes32 receiver, bytes calldata payload)
        external
        payable
        returns (bytes32 messageId);

    /// @notice Transport fee quote for `sendMessage` with the same arguments.
    function quote(uint32 dstChainId, bytes32 receiver, bytes calldata payload)
        external
        view
        returns (uint256 nativeFee);
}

/// @notice Delivery surface on the receiving chain.
interface ICrossChainReceiver {
    /// @dev Implementations must authenticate the caller as the trusted
    ///      messenger and `srcSender` as the trusted peer for `srcChainId`.
    ///      Both checks are required: a trusted transport still delivers
    ///      messages from untrusted senders.
    ///      Payable because a value-carrying transport delivers the bridged
    ///      stake together with the message.
    function receiveMessage(uint32 srcChainId, bytes32 srcSender, bytes calldata payload)
        external
        payable;
}
