// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The fee totals `GameEscrow` keeps per fee epoch, as a rewards
///         contract reads them. A total only grows while its epoch is the
///         current one, so it is final once the epoch has ended.
interface IFeeLedger {
    /// @notice Length of a fee epoch, in seconds.
    function FEE_EPOCH() external view returns (uint256);

    /// @notice Fees `player` paid in matches that settled during `epoch`.
    function feesPaid(address player, uint256 epoch) external view returns (uint256);

    /// @notice Fees every player paid in matches that settled during `epoch`.
    function epochFees(uint256 epoch) external view returns (uint256);
}
