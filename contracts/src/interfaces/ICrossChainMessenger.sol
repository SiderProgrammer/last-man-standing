// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Transport abstraction for hub/spoke messaging between chains.
/// @dev The hub chain owns match state and escrowed value; spoke chains forward
///      joins. Transport-agnostic, so the adapter can be swapped without
///      touching game logic.
///
///      Chain ids here are EVM chain ids. An adapter whose transport has its own
///      id space (LayerZero's endpoint ids) translates at its boundary, so the
///      escrow, its seat records and every client see one id space only.
interface ICrossChainMessenger {
    /// @notice Sends `payload` to `receiver` on `dstChainId`, delivering
    ///         `deliverValue` of the destination's native token with it.
    /// @dev `msg.value` must be at least `quote(...)` for the same arguments.
    ///      The value is delivered exactly; there is no "whatever was left".
    /// @param receiver Application contract on the destination chain.
    function sendMessage(uint32 dstChainId, bytes32 receiver, bytes calldata payload, uint128 deliverValue)
        external
        payable
        returns (bytes32 messageId);

    /// @notice Total `msg.value` that `sendMessage` needs: the transport fee
    ///         plus whatever it charges to deliver `deliverValue`.
    function quote(uint32 dstChainId, bytes32 receiver, bytes calldata payload, uint128 deliverValue)
        external
        view
        returns (uint256 nativeFee);
}

/// @notice Delivery surface on the receiving chain.
interface ICrossChainReceiver {
    /// @dev Implementations must authenticate the caller as the trusted
    ///      messenger and `srcSender` as the trusted peer for `srcChainId`.
    ///      `srcSender` is the *application* that sent the message — the
    ///      messenger authenticates its remote counterpart itself and passes
    ///      on who called it — so a trusted transport carrying a message from
    ///      some other contract on the remote chain fails the peer check.
    ///      Payable because a value-carrying transport delivers the bridged
    ///      stake together with the message.
    function receiveMessage(uint32 srcChainId, bytes32 srcSender, bytes calldata payload)
        external
        payable;
}
