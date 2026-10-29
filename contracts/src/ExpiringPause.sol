// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ExpiringPause
/// @notice An emergency stop that ends on its own unless governance keeps it.
///
/// @dev Two parties can stop play, on different terms:
///
///      - The guardian pauses at once, with no timelock delay, but only for
///        `GUARDIAN_PAUSE`. It can end its own pause early. Once a pause ends,
///        it cannot pause again for `GUARDIAN_COOLDOWN`, so it can never hold
///        play stopped by renewing a pause forever.
///      - Governance extends a pause, or starts one, with `extendPause`, and
///        ends one with `unpause`. Both go through the timelock.
///
///      A compromised guardian can therefore stop play for a week at a time,
///      with a week of play in between, until governance replaces it. Since
///      the deriving contract never pauses refunds or withdrawals, it can never
///      trap funds.
///
///      Events and errors follow OpenZeppelin's `Pausable`.
abstract contract ExpiringPause {
    /// @notice How long a guardian pause lasts.
    uint64 public constant GUARDIAN_PAUSE = 7 days;
    /// @notice How long after a pause ends before the guardian may pause again.
    uint64 public constant GUARDIAN_COOLDOWN = 7 days;

    /// @notice Play is paused while `block.timestamp < pausedUntil`. Also the
    ///         moment the last pause ended, once it has.
    uint64 public pausedUntil;

    event Paused(address account, uint64 until);
    event Unpaused(address account);

    error EnforcedPause();
    error ExpectedPause();
    error NotGuardian();
    error NotGovernance();
    error GuardianCooldown(uint64 availableAt);
    error PauseNotExtended(uint64 until, uint64 current);

    modifier whenNotPaused() {
        if (paused()) revert EnforcedPause();
        _;
    }

    /// @notice Whether play is paused right now.
    function paused() public view returns (bool) {
        return block.timestamp < pausedUntil;
    }

    /// @notice Pauses play for `GUARDIAN_PAUSE`. Guardian only.
    /// @dev Reverts while a pause is on, so it never shortens one governance extended.
    function pause() external {
        if (!_isGuardian(msg.sender)) revert NotGuardian();
        uint64 availableAt = pausedUntil == 0 ? 0 : pausedUntil + GUARDIAN_COOLDOWN;
        if (block.timestamp < availableAt) revert GuardianCooldown(availableAt);

        uint64 until = uint64(block.timestamp) + GUARDIAN_PAUSE;
        pausedUntil = until;
        emit Paused(msg.sender, until);
    }

    /// @notice Keeps play paused until `until`, or pauses it until then.
    /// @dev Governance only, so through the timelock.
    function extendPause(uint64 until) external {
        if (!_isGovernance(msg.sender)) revert NotGovernance();
        if (until <= block.timestamp || until <= pausedUntil) revert PauseNotExtended(until, pausedUntil);
        pausedUntil = until;
        emit Paused(msg.sender, until);
    }

    /// @notice Ends a pause now. Governance, or the guardian.
    /// @dev Starts the guardian's cooldown, as a pause that expires does.
    function unpause() external {
        if (!_isGuardian(msg.sender) && !_isGovernance(msg.sender)) revert NotGovernance();
        if (!paused()) revert ExpectedPause();
        pausedUntil = uint64(block.timestamp);
        emit Unpaused(msg.sender);
    }

    function _isGuardian(address account) internal view virtual returns (bool);

    function _isGovernance(address account) internal view virtual returns (bool);
}
