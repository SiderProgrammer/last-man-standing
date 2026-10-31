// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Errors several contracts raise for the same reason.
///
/// @dev File-level rather than per-contract. A custom error's selector is
///      derived from its name and argument types alone, not from where it is
///      declared, so hoisting these changes no ABI and no revert data — every
///      caller and every off-chain decoder sees exactly what it saw before.
///
///      Every error that more than one contract raises lives here, with one
///      signature, so a name always means the same selector.

/// @notice A zero address was supplied where a real one is required.
error ZeroAddress();

/// @notice A native-value transfer failed, usually a recipient that reverts.
error TransferFailed(address to, uint256 amount);

/// @notice Withdrawal attempted with an empty balance.
error NothingToWithdraw();

/// @notice No match exists with this id.
error UnknownMatch(bytes32 matchId);

/// @notice A randomness callback named a request that is not pending. VRF
///         request ids are `uint256`; they are passed as `bytes32(id)`.
error UnknownRequest(bytes32 requestId);
