// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ZeroAddress} from "../Errors.sol";

/// @title MultisigPhase
/// @notice The Safe's powers over the timelock, held on its behalf until a
///         date fixed in this contract, and gone after it.
///
/// @dev This contract, not the Safe, holds the timelock's PROPOSER and
///      CANCELLER roles. It forwards `schedule`, `scheduleBatch` and `cancel`
///      from the Safe only, and only before `PHASE_END`. Once that has passed,
///      anyone may call `retire`, which renounces both roles for good.
///
///      So the Safe's veto ends on a date anyone can read here, not on a vote:
///      it cannot cancel its own removal, because nothing needs to be removed.
///
///      Before `PHASE_END` the Safe proposes through the timelock like the
///      governor does, with the same delay. It cannot schedule anything that
///      would outlive the phase on its own:
///
///        - no call to the timelock itself, so it cannot grant itself a role,
///          make a new proposer or shorten the delay;
///        - no `transferOwnership` or `renounceOwnership`, on any target, so
///          everything the timelock owns stays the timelock's.
///
///      Everything else it schedules can be undone by governance afterwards.
contract MultisigPhase {
    /// @notice Longest phase the constructor accepts.
    uint256 public constant MAX_PHASE = 2 * 365 days;

    TimelockController public immutable TIMELOCK;
    address public immutable SAFE;
    /// @notice When the Safe's powers end.
    uint256 public immutable PHASE_END;

    event Retired(uint256 at);

    error NotSafe(address caller);
    error PhaseOver(uint256 phaseEnd);
    error PhaseNotOver(uint256 phaseEnd);
    error InvalidPhaseEnd(uint256 phaseEnd);
    error ForbiddenCall(address target, bytes4 selector);

    constructor(TimelockController timelock, address safe, uint256 phaseEnd) {
        if (address(timelock) == address(0) || safe == address(0)) revert ZeroAddress();
        if (phaseEnd <= block.timestamp || phaseEnd > block.timestamp + MAX_PHASE) {
            revert InvalidPhaseEnd(phaseEnd);
        }
        TIMELOCK = timelock;
        SAFE = safe;
        PHASE_END = phaseEnd;
    }

    modifier onlySafeInPhase() {
        if (msg.sender != SAFE) revert NotSafe(msg.sender);
        if (block.timestamp >= PHASE_END) revert PhaseOver(PHASE_END);
        _;
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
        _checkCall(target, data);
        TIMELOCK.schedule(target, value, data, predecessor, salt, delay);
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
        for (uint256 i = 0; i < targets.length; ++i) {
            _checkCall(targets[i], payloads[i]);
        }
        TIMELOCK.scheduleBatch(targets, values, payloads, predecessor, salt, delay);
    }

    /// @notice Cancels a pending operation: the Safe's veto, governor
    ///         proposals included.
    function cancel(bytes32 id) external onlySafeInPhase {
        TIMELOCK.cancel(id);
    }

    /// @notice Gives up both roles once the phase is over. Open to anyone.
    function retire() external {
        if (block.timestamp < PHASE_END) revert PhaseNotOver(PHASE_END);
        TIMELOCK.renounceRole(TIMELOCK.PROPOSER_ROLE(), address(this));
        TIMELOCK.renounceRole(TIMELOCK.CANCELLER_ROLE(), address(this));
        emit Retired(block.timestamp);
    }

    /// @dev The two ways a call scheduled now could keep the Safe in charge
    ///      after `PHASE_END`; see the contract notes.
    function _checkCall(address target, bytes calldata data) private view {
        bytes4 selector = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
        if (
            target == address(TIMELOCK) || selector == Ownable.transferOwnership.selector
                || selector == Ownable.renounceOwnership.selector
        ) revert ForbiddenCall(target, selector);
    }
}
