// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {ZeroAddress} from "../Errors.sol";

/// @title LiquidityReserve
/// @notice Holds the LMS meant to seed a liquidity pool, so that it can do
///         nothing else.
///
/// @dev The liquidity share was the Safe's to hold. Held there, it could be
///      staked once the multisig phase ends, and 5% of the supply clears the
///      governor's 1% quorum floor alone. Held here, it cannot vote:
///
///        - this contract has no way to stake, delegate or approve;
///        - it pays out only to a recipient the owner (the timelock) has
///          approved, which is meant to be the pool;
///        - the vault, the Safe and the reserve itself can never be approved,
///          so the plain routes to staking it are closed even to a proposal.
///
///      The Safe or the timelock then sends LMS to an approved recipient.
///      Every approval waits out the timelock delay, in public.
contract LiquidityReserve is Ownable2Step {
    using SafeERC20 for IERC20;

    IERC20 public immutable lms;
    /// @notice May release to an approved recipient, as the timelock may.
    address public immutable safe;
    /// @notice `StakedLms`, which may never be a recipient.
    address public immutable vault;

    mapping(address recipient => bool) public isApproved;

    event RecipientSet(address indexed recipient, bool approved);
    event Released(address indexed to, uint256 amount, address indexed by);

    error NotAllowed(address caller);
    error RecipientNotApproved(address recipient);
    error CannotApprove(address recipient);

    constructor(IERC20 lms_, address safe_, address vault_, address owner_) Ownable(owner_) {
        if (address(lms_) == address(0) || safe_ == address(0) || vault_ == address(0)) revert ZeroAddress();
        lms = lms_;
        safe = safe_;
        vault = vault_;
    }

    /// @notice Approves, or with `false` withdraws approval of, a recipient.
    function setRecipient(address recipient, bool approved) external onlyOwner {
        if (recipient == address(0) || recipient == vault || recipient == safe || recipient == address(this)) revert CannotApprove(recipient);
        isApproved[recipient] = approved;
        emit RecipientSet(recipient, approved);
    }

    /// @notice Sends `amount` LMS to an approved recipient.
    function release(address to, uint256 amount) external {
        if (msg.sender != safe && msg.sender != owner()) revert NotAllowed(msg.sender);
        if (!isApproved[to]) revert RecipientNotApproved(to);
        lms.safeTransfer(to, amount);
        emit Released(to, amount, msg.sender);
    }
}
