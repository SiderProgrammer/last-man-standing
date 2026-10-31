// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

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
///
///      The reentrancy lock lives in EIP-1153 transient storage rather than in
///      a storage slot: it only has to exist for the length of one call, and a
///      transient slot costs ~100 gas per access instead of a cold SSTORE.
abstract contract PullPayable is ReentrancyGuardTransient {
    /// @notice Withdrawable balance, credited by settlement and refunds.
    mapping(address account => uint256) public withdrawable;

    /// @notice Sum of every unwithdrawn balance.
    uint256 public totalOwed;

    /// @notice Smallest balance `withdrawFor` pays out.
    /// @dev Whoever calls `withdrawFor` for someone else pays the gas, so
    ///      dust would let anyone drain a relayer that pays it. About 300 times
    ///      the gas of the call on Base, and below any refund or prize at the
    ///      minimum stake. `withdraw` has no minimum, so no balance is stuck.
    uint256 public constant MIN_WITHDRAW_FOR = 0.0001 ether;

    event Withdrawn(address indexed account, address indexed to, uint256 amount);

    error BelowMinimumWithdrawal(uint256 amount, uint256 minimum);

    /// @notice Withdraws the caller's balance to `to`.
    function withdraw(address to) external nonReentrant returns (uint256 amount) {
        amount = _payOut(msg.sender, to);
    }

    /// @notice Pays `account`'s balance to `account` itself.
    /// @dev Permissionless, because the recipient is never the caller's choice:
    ///      the worst anyone can do is pay a player early. That is what a
    ///      session's gasless withdrawal calls, and it means a session key never
    ///      needs `withdraw`, whose free `to` would let a leaked key send the
    ///      whole balance anywhere.
    function withdrawFor(address account) external nonReentrant returns (uint256 amount) {
        uint256 owed = withdrawable[account];
        if (owed != 0 && owed < MIN_WITHDRAW_FOR) revert BelowMinimumWithdrawal(owed, MIN_WITHDRAW_FOR);
        amount = _payOut(account, account);
    }

    function _payOut(address account, address to) internal returns (uint256 amount) {
        amount = withdrawable[account];
        if (amount == 0) revert NothingToWithdraw();

        withdrawable[account] = 0;
        totalOwed -= amount;

        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed(to, amount);

        emit Withdrawn(account, to, amount);
    }

    /// @dev Credits without transferring. The recipient collects it themselves.
    function _credit(address account, uint256 amount) internal {
        withdrawable[account] += amount;
        totalOwed += amount;
    }
}
