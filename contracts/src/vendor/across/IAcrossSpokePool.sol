// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// The part of Across's SpokePool this protocol calls, from across-protocol/contracts
// v5.0.27 (7445f72de17900544605c7e6706c5fb3b3784738), contracts/spoke-pools/SpokePool.sol.
// Signatures copied unchanged; the full interface is not vendored.
//
// What the pinned source does, which BridgeJoinReceiver and SpokeRouter rely on:
//   - `depositV3` with `inputToken` the wrapped native token and `msg.value == inputAmount`
//     wraps the ETH itself. `outputToken` must not be zero.
//   - `quoteTimestamp` must lie within `depositQuoteTimeBuffer` before now, and
//     `fillDeadline` no later than `fillDeadlineBuffer` after now.
//   - A fill whose output token is the wrapped native token sends native ETH to an EOA or
//     a 7702-delegated account, and the wrapped token to any other contract.
//   - With a non-empty message and a contract recipient, the fill then calls
//     `handleV3AcrossMessage(outputToken, amount, relayer, message)` on it. A revert there
//     reverts the fill: the deposit stays unfilled and, after `fillDeadline`, is refunded
//     to `depositor` on the origin chain, in the wrapped token.
interface IAcrossSpokePool {
    function depositV3(
        address depositor,
        address recipient,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 destinationChainId,
        address exclusiveRelayer,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        uint32 exclusivityParameter,
        bytes calldata message
    ) external payable;

    function wrappedNativeToken() external view returns (address);

    function depositQuoteTimeBuffer() external view returns (uint32);

    function fillDeadlineBuffer() external view returns (uint32);
}
