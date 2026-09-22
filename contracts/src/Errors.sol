// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Errors several contracts raise for the same reason.
///
/// @dev File-level rather than per-contract. A custom error's selector is
///      derived from its name and argument types alone, not from where it is
///      declared, so hoisting these changes no ABI and no revert data — every
///      caller and every off-chain decoder sees exactly what it saw before.
///
///      Only errors that were already byte-identical live here. Ones that share
///      a name but differ in arguments — `UntrustedMessenger`, `UnknownRequest`
///      — are deliberately left alone, because unifying those *would* change
///      selectors. They are recorded in `docs/TODO.md` §3.4.

/// @notice A zero address was supplied where a real one is required.
error ZeroAddress();

/// @notice A native-value transfer failed, usually a recipient that reverts.
error TransferFailed(address to, uint256 amount);

/// @notice Withdrawal attempted with an empty balance.
error NothingToWithdraw();
