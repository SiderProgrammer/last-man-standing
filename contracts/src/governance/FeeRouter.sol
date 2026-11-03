// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {PullPayable} from "../PullPayable.sol";
import {BPS_DENOMINATOR} from "../Constants.sol";
import {NothingToWithdraw, TransferFailed, ZeroAddress} from "../Errors.sol";
import {StakedLms} from "./StakedLms.sol";

/// @title FeeRouter
/// @notice Splits protocol fees between stakers and the treasury.
///
/// @dev Set as the escrow's `treasury`, so settlement credits every match fee
///      here. `harvest` — open to anyone — pulls the credited ETH out of the
///      escrow and passes `stakerBps` of it to `StakedLms`, which shares it
///      across stakers, and the rest to `treasury`.
///
///      Nothing is swapped and nothing is priced, so there is no trade to
///      sandwich and no one to trust with the timing: anyone may harvest at any
///      moment, and the only effect is that fees reach their recipients sooner.
///
///      Holds no ETH between transactions. It arrives only from the escrow, and
///      leaves in the same call; `harvest` splits whatever balance it finds,
///      so nothing that arrived another way can stay.
contract FeeRouter is Ownable2Step, ReentrancyGuardTransient {
    PullPayable public immutable escrow;
    StakedLms public immutable vault;

    /// @notice Receives the part of each harvest that does not go to stakers.
    address public treasury;
    /// @notice Share of harvested fees paid to stakers, in basis points.
    uint16 public stakerBps;

    event Harvested(uint256 amount, uint256 toStakers, uint256 toTreasury);
    event TreasuryUpdated(address indexed previous, address indexed current);
    event StakerBpsUpdated(uint16 previous, uint16 current);

    error InvalidBps(uint16 bps);
    error UnexpectedSender(address sender);

    constructor(PullPayable escrow_, StakedLms vault_, address owner_, address treasury_, uint16 stakerBps_)
        Ownable(owner_)
    {
        if (address(escrow_) == address(0) || address(vault_) == address(0)) revert ZeroAddress();
        escrow = escrow_;
        vault = vault_;
        _setTreasury(treasury_);
        _setStakerBps(stakerBps_);
    }

    /// @notice Pulls every fee credited by the escrow and splits it.
    /// @dev Splits the whole balance, not just what this call pulled: should
    ///      fees ever reach here outside a harvest, the next one passes them on
    ///      rather than leaving them stuck. Reverts with `NothingToWithdraw`
    ///      when there is nothing to split.
    function harvest() external nonReentrant returns (uint256 amount) {
        if (escrow.withdrawable(address(this)) != 0) escrow.withdraw(address(this));
        amount = address(this).balance;
        if (amount == 0) revert NothingToWithdraw();

        uint256 toStakers = (amount * stakerBps) / BPS_DENOMINATOR;
        uint256 toTreasury = amount - toStakers;

        if (toStakers != 0) vault.depositRewards{value: toStakers}();
        if (toTreasury != 0) {
            (bool ok,) = treasury.call{value: toTreasury}("");
            if (!ok) revert TransferFailed(treasury, toTreasury);
        }

        emit Harvested(amount, toStakers, toTreasury);
    }

    function setTreasury(address treasury_) external onlyOwner {
        _setTreasury(treasury_);
    }

    /// @dev Applies from the next harvest.
    function setStakerBps(uint16 stakerBps_) external onlyOwner {
        _setStakerBps(stakerBps_);
    }

    function _setTreasury(address treasury_) private {
        if (treasury_ == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, treasury_);
        treasury = treasury_;
    }

    function _setStakerBps(uint16 stakerBps_) private {
        if (stakerBps_ > BPS_DENOMINATOR) revert InvalidBps(stakerBps_);
        emit StakerBpsUpdated(stakerBps, stakerBps_);
        stakerBps = stakerBps_;
    }

    /// @dev Fees arrive from the escrow's `withdraw`. Nothing else pays in.
    receive() external payable {
        if (msg.sender != address(escrow)) revert UnexpectedSender(msg.sender);
    }
}
