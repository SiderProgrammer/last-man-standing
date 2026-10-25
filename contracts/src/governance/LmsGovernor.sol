// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {
    GovernorCountingSimple
} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {
    GovernorVotesQuorumFraction
} from "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import {
    GovernorTimelockControl
} from "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title LmsGovernor
/// @notice Token governance: sLMS holders propose and vote; passed proposals
///         go through the protocol's existing `TimelockController`.
///
/// @dev Stock OpenZeppelin, plus one thing — a minimum quorum:
///
///        sLMS votes --> LmsGovernor --proposes--> TimelockController --owns--> ProtocolConfig,
///                                                          ^                    StakedLms, FeeRouter
///                                                          |
///                                             Safe: canceller only (veto)
///
///      Voting power is read from `StakedLms`, never from plain LMS, and at the
///      proposal's snapshot, so tokens bought or staked after a proposal is
///      made cannot vote on it. The clock follows the token: timestamps.
///
///      **Minimum quorum.** OpenZeppelin's quorum is a fraction of the *staked*
///      supply, so while little is staked it is tiny: with 2M LMS staked, 4% is
///      80k sLMS — less than the proposal threshold, so one proposer could pass
///      anything alone. `quorum` is therefore the larger of that fraction and
///      `quorumFloor`, a fixed number of votes. The floor is checkpointed like
///      the fraction is, so changing it never moves the goalposts of a vote
///      already under way, and it is capped at 10% of the LMS supply, so a
///      proposal cannot raise it out of reach of everyone who could stake.
///
///      The Safe keeps the timelock's canceller role and can veto anything the
///      governor queues. That is a training-wheels period, not a permanent
///      feature: governance can end it with a proposal that calls
///      `timelock.revokeRole(CANCELLER_ROLE, safe)`.
contract LmsGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    using Checkpoints for Checkpoints.Trace208;

    /// @dev The floor may be at most this share of the LMS supply, in percent.
    uint256 public constant MAX_QUORUM_FLOOR_PERCENT = 10;

    Checkpoints.Trace208 private _quorumFloorHistory;

    event QuorumFloorUpdated(uint256 oldQuorumFloor, uint256 newQuorumFloor);

    error QuorumFloorTooHigh(uint256 quorumFloor, uint256 max);

    constructor(
        IVotes token_,
        TimelockController timelock_,
        uint48 votingDelay_,
        uint32 votingPeriod_,
        uint256 proposalThreshold_,
        uint256 quorumPercent_,
        uint256 quorumFloor_
    )
        Governor("LMS Governor")
        GovernorSettings(votingDelay_, votingPeriod_, proposalThreshold_)
        GovernorVotes(token_)
        GovernorVotesQuorumFraction(quorumPercent_)
        GovernorTimelockControl(timelock_)
    {
        _updateQuorumFloor(quorumFloor_);
    }

    // ------------------------------------------------------------ quorum floor

    /// @notice The minimum quorum now, in votes.
    function quorumFloor() public view returns (uint256) {
        return _quorumFloorHistory.latest();
    }

    /// @notice The minimum quorum at `timepoint`, in votes.
    function quorumFloor(uint256 timepoint) public view returns (uint256) {
        return _quorumFloorHistory.upperLookupRecent(SafeCast.toUint48(timepoint));
    }

    /// @notice The most `quorumFloor` may be set to: 10% of the LMS supply.
    function maxQuorumFloor() public view returns (uint256) {
        IERC20 lms = IERC20(IERC4626(address(token())).asset());
        return (lms.totalSupply() * MAX_QUORUM_FLOOR_PERCENT) / 100;
    }

    /// @notice Changes the minimum quorum. Only through a proposal.
    function setQuorumFloor(uint256 newQuorumFloor) external onlyGovernance {
        _updateQuorumFloor(newQuorumFloor);
    }

    function _updateQuorumFloor(uint256 newQuorumFloor) private {
        uint256 max = maxQuorumFloor();
        if (newQuorumFloor > max) revert QuorumFloorTooHigh(newQuorumFloor, max);
        uint256 old = _quorumFloorHistory.latest();
        _quorumFloorHistory.push(clock(), SafeCast.toUint208(newQuorumFloor));
        emit QuorumFloorUpdated(old, newQuorumFloor);
    }

    function votingDelay() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingDelay();
    }

    function votingPeriod() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingPeriod();
    }

    function quorum(uint256 timepoint)
        public
        view
        override(Governor, GovernorVotesQuorumFraction)
        returns (uint256)
    {
        return Math.max(super.quorum(timepoint), quorumFloor(timepoint));
    }

    function proposalThreshold() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.proposalThreshold();
    }

    function state(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (ProposalState)
    {
        return super.state(proposalId);
    }

    function proposalNeedsQueuing(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (bool)
    {
        return super.proposalNeedsQueuing(proposalId);
    }

    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    function _executor() internal view override(Governor, GovernorTimelockControl) returns (address) {
        return super._executor();
    }
}
