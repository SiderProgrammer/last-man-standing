// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {NothingToWithdraw, TransferFailed} from "./Errors.sol";

/// @title PullPayable
/// @notice Credits balances that recipients come and collect.
///
/// @dev Both escrows owe money to players and neither may push it: a payout
///      that transfers inside settlement lets one reverting recipient block
///      the whole distribution, and settlement is the path that moves every
///      stake in the match. Crediting and then letting each account withdraw
///      separately makes one failing recipient their own problem.
///
///      `totalOwed` is what makes that auditable. The hub asserts
///      `address(this).balance == totalOwed + totalEscrowed` as a Foundry
///      invariant, which only holds because every credit and every withdrawal
///      goes through the two functions below.
///
///      Storage note: these variables linearise ahead of the deriving
///      contract's own, so inheriting shifts every slot after them. That is
///      safe here because both escrows are deployed with `new` and neither
///      sits behind a proxy. It would not be safe the day one does.
abstract contract PullPayable is ReentrancyGuard {
    /// @notice Withdrawable balance, credited by settlement and refunds.
    mapping(address account => uint256) public withdrawable;

    /// @notice Sum of every unwithdrawn balance.
    uint256 public totalOwed;

    event Withdrawn(address indexed account, address indexed to, uint256 amount);

    /// @notice Withdraws the caller's balance to `to`.
    function withdraw(address to) external nonReentrant returns (uint256 amount) {
        amount = withdrawable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        withdrawable[msg.sender] = 0;
        totalOwed -= amount;

        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed(to, amount);

        emit Withdrawn(msg.sender, to, amount);
    }

    /// @dev Credits without transferring. The recipient collects it themselves.
    function _credit(address account, uint256 amount) internal {
        withdrawable[account] += amount;
        totalOwed += amount;
    }

    /// @dev Clears a balance for a caller that is sending it somewhere other
    ///      than a plain transfer, such as across a bridge.
    function _takeBalance(address account) internal returns (uint256 amount) {
        amount = withdrawable[account];
        if (amount == 0) revert NothingToWithdraw();

        withdrawable[account] = 0;
        totalOwed -= amount;
    }
}
