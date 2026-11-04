// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ZeroAddress} from "../Errors.sol";
import {BridgeJoinReceiver} from "../periphery/BridgeJoinReceiver.sol";
import {LiquidityReserve} from "./LiquidityReserve.sol";
import {RewardsDistributor} from "./RewardsDistributor.sol";
import {StakedLms} from "./StakedLms.sol";

/// @title MultisigPhase
/// @notice The Safe's powers over the timelock, held on its behalf until a
///         date fixed in this contract, and gone after it.
///
/// @dev This contract, not the Safe, holds the timelock's PROPOSER and
///      CANCELLER roles. It forwards `schedule`, `scheduleBatch` and `cancel`
///      from the Safe only, and only before `phaseEnd`. Once that has passed,
///      anyone may call `retire`, which renounces both roles for good.
///
///      So the Safe's veto ends on a date anyone can read here, not on a vote:
///      it cannot cancel its own removal, because nothing needs to be removed.
///
///      Timelock operations never expire and anyone may execute one, so a call
///      left waiting would otherwise outlive the phase. Everything scheduled
///      here must be ready by `phaseEnd`, and `retire` cancels whatever is still
///      pending. Until someone calls `retire`, a call that is ready can still be
///      executed, so it should be called as soon as the phase ends. An id the
///      governor later schedules with the same call and salt is cancelled too;
///      that needs the Safe to have predicted it, and the Safe could veto it
///      anyway until the phase ended.
///
///      Before `phaseEnd` the Safe proposes through the timelock like the
///      governor does, with the same delay. It cannot schedule anything that
///      would outlive the phase on its own:
///
///        - no call to the timelock itself, so it cannot grant itself a role,
///          make a new proposer or shorten the delay;
///        - no `transferOwnership` or `renounceOwnership`, on any target, so
///          everything the timelock owns stays the timelock's;
///        - nothing that moves LMS: no call to the token at all, so no
///          `transfer`, `approve` or stake of the treasury's LMS, and none of
///          the owner's ways to release LMS held elsewhere — `sweep`,
///          `sweepStray`, approving a `LiquidityReserve` recipient, or
///          `recover` of LMS. LMS is votes: the Safe holding or staking some
///          would keep it in governance after the phase.
///
///      ETH it may spend. That is the treasury's job in the phase, and ETH
///      buys no votes. So the Safe is trusted with the treasury's ETH until
///      `phaseEnd`; everything else it schedules can be undone by governance
///      afterwards.
///
///      The LMS checks match by selector, not target, as the ownership ones
///      do: a contract deployed later with the same functions is covered too,
///      and any other contract's `sweep(address)` is refused with them.
contract MultisigPhase {
    /// @notice Longest phase the constructor accepts.
    uint256 public constant MAX_PHASE = 2 * 365 days;

    TimelockController public immutable timelock;
    address public immutable safe;
    /// @notice The governance token, which the Safe may never move.
    address public immutable lms;
    /// @notice When the Safe's powers end.
    uint256 public immutable phaseEnd;

    /// @notice Every operation scheduled through here, in order.
    bytes32[] public scheduled;
    /// @notice How many of `scheduled` have been checked after the phase ended.
    uint256 public leftoversChecked;

    event Retired(uint256 at);

    error NotSafe(address caller);
    error PhaseOver(uint256 phaseEnd);
    error PhaseNotOver(uint256 phaseEnd);
    error InvalidPhaseEnd(uint256 phaseEnd);
    error ReadyAfterPhase(uint256 readyAt, uint256 phaseEnd);
    error ForbiddenCall(address target, bytes4 selector);

    constructor(TimelockController timelock_, address safe_, address lms_, uint256 phaseEnd_) {
        if (address(timelock_) == address(0) || safe_ == address(0) || lms_ == address(0)) {
            revert ZeroAddress();
        }
        if (phaseEnd_ <= block.timestamp || phaseEnd_ > block.timestamp + MAX_PHASE) {
            revert InvalidPhaseEnd(phaseEnd_);
        }
        timelock = timelock_;
        safe = safe_;
        lms = lms_;
        phaseEnd = phaseEnd_;
    }

    /// @dev The check is a function so its code is not copied into every
    ///      function the modifier guards.
    modifier onlySafeInPhase() {
        _onlySafeInPhase();
        _;
    }

    function _onlySafeInPhase() private view {
        if (msg.sender != safe) revert NotSafe(msg.sender);
        if (block.timestamp >= phaseEnd) revert PhaseOver(phaseEnd);
    }

    /// @notice Schedules one call through the timelock.
    function schedule(
        address target,
        uint256 value,
        bytes calldata data,
        bytes32 predecessor,
        bytes32 salt,
        uint256 delay
    ) external onlySafeInPhase {
        _checkReady(delay);
        _checkCall(target, data);
        scheduled.push(timelock.hashOperation(target, value, data, predecessor, salt));
        timelock.schedule(target, value, data, predecessor, salt, delay);
    }

    /// @notice Schedules a batch through the timelock.
    function scheduleBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata payloads,
        bytes32 predecessor,
        bytes32 salt,
        uint256 delay
    ) external onlySafeInPhase {
        _checkReady(delay);
        for (uint256 i = 0; i < targets.length; ++i) {
            _checkCall(targets[i], payloads[i]);
        }
        scheduled.push(timelock.hashOperationBatch(targets, values, payloads, predecessor, salt));
        timelock.scheduleBatch(targets, values, payloads, predecessor, salt, delay);
    }

    /// @notice Cancels a pending operation: the Safe's veto, governor
    ///         proposals included.
    function cancel(bytes32 id) external onlySafeInPhase {
        timelock.cancel(id);
    }

    /// @notice Cancels what is left of the next `count` operations scheduled
    ///         here, once the phase is over. Open to anyone.
    /// @dev Only needed if there are too many for `retire` to get through in
    ///      one transaction, so the Safe cannot block `retire` by scheduling
    ///      thousands of calls.
    function cancelLeftovers(uint256 count) external {
        if (block.timestamp < phaseEnd) revert PhaseNotOver(phaseEnd);
        _cancelLeftovers(count);
    }

    /// @notice Cancels what the Safe left pending and gives up both roles, once
    ///         the phase is over. Open to anyone.
    function retire() external {
        if (block.timestamp < phaseEnd) revert PhaseNotOver(phaseEnd);
        _cancelLeftovers(scheduled.length);
        timelock.renounceRole(timelock.PROPOSER_ROLE(), address(this));
        timelock.renounceRole(timelock.CANCELLER_ROLE(), address(this));
        emit Retired(block.timestamp);
    }

    /// @dev Governance can take the canceller role away early, and that must not
    ///      stop the phase retiring, so without the role nothing is cancelled.
    function _cancelLeftovers(uint256 count) private {
        uint256 next = leftoversChecked;
        uint256 remaining = scheduled.length - next;
        uint256 end = next + (count < remaining ? count : remaining);
        bool canCancel = timelock.hasRole(timelock.CANCELLER_ROLE(), address(this));
        for (; next < end; ++next) {
            bytes32 id = scheduled[next];
            if (canCancel && timelock.isOperationPending(id)) timelock.cancel(id);
        }
        leftoversChecked = next;
    }

    function _checkReady(uint256 delay) private view {
        uint256 readyAt = block.timestamp + delay;
        if (readyAt > phaseEnd) revert ReadyAfterPhase(readyAt, phaseEnd);
    }

    /// @dev The ways a call scheduled now could keep the Safe in charge after
    ///      `phaseEnd`; see the contract notes.
    function _checkCall(address target, bytes calldata data) private view {
        bytes4 selector = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
        if (
            target == address(timelock) || selector == Ownable.transferOwnership.selector
                || selector == Ownable.renounceOwnership.selector || _movesLms(target, selector, data)
        ) revert ForbiddenCall(target, selector);
    }

    function _movesLms(address target, bytes4 selector, bytes calldata data) private view returns (bool) {
        if (
            target == lms || selector == RewardsDistributor.sweep.selector
                || selector == StakedLms.sweepStray.selector
                || selector == LiquidityReserve.setRecipient.selector
        ) return true;
        // `recover(token, to, amount)` returns stray ETH and tokens; only LMS is refused.
        return selector == BridgeJoinReceiver.recover.selector && data.length >= 36
            && abi.decode(data[4:36], (address)) == lms;
    }
}
