// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {StakedLms} from "./StakedLms.sol";
import {ZeroAddress} from "../Errors.sol";

/// @title LmsFaucet
/// @notice Testnet only: gives each wallet one scoop of LMS, part of it
///         already staked, so staking, voting and the fee discount can be
///         tried at once rather than after months of play-mining.
///
/// @dev `Deploy` never deploys it on Base mainnet. Elsewhere it holds a share
///      of the supply taken from the timelock's, and pays it out one scoop
///      per address:
///
///        - `liquidAmount` LMS to the address itself, for the fee discount;
///        - `stakedAmount` staked for it with `StakedLms.depositFor`, so the
///          sLMS, its votes and its share of fees are the address's at once.
///
///      Anyone may call `drip`, for any address, and pay the gas: the game
///      server does it for wallets that sign in. Each address is paid once,
///      however often it is asked for. It has no owner: what is left when
///      the deploy is retired stays here.
contract LmsFaucet {
    using SafeERC20 for IERC20;

    IERC20 public immutable lms;
    StakedLms public immutable vault;
    /// @notice LMS each address is sent.
    uint256 public immutable liquidAmount;
    /// @notice LMS staked for each address, as sLMS.
    uint256 public immutable stakedAmount;

    /// @notice Whether `account` has had its scoop.
    mapping(address account => bool) public dripped;

    event Dripped(address indexed to, uint256 liquid, uint256 staked, address indexed by);

    error AlreadyDripped(address to);
    error FaucetEmpty(uint256 balance, uint256 scoop);
    error CannotDrip(address to);
    error EmptyScoop();
    error WrongVault(address vault);

    constructor(IERC20 lms_, StakedLms vault_, uint256 liquidAmount_, uint256 stakedAmount_) {
        if (address(lms_) == address(0) || address(vault_) == address(0)) revert ZeroAddress();
        if (address(vault_.underlying()) != address(lms_)) revert WrongVault(address(vault_));
        if (liquidAmount_ + stakedAmount_ == 0) revert EmptyScoop();
        lms = lms_;
        vault = vault_;
        liquidAmount = liquidAmount_;
        stakedAmount = stakedAmount_;
        // The vault pulls only what `drip` stakes, since only this contract
        // calls `depositFor` on its own behalf.
        lms_.forceApprove(address(vault_), type(uint256).max);
    }

    /// @notice LMS one address gets, liquid and staked together.
    function scoop() public view returns (uint256) {
        return liquidAmount + stakedAmount;
    }

    /// @notice How many more addresses can be paid.
    function scoopsLeft() external view returns (uint256) {
        return lms.balanceOf(address(this)) / scoop();
    }

    /// @notice Sends `to` its scoop: `liquidAmount` LMS, and `stakedAmount`
    ///         staked for it. Reverts if `to` already had one.
    function drip(address to) external {
        if (to == address(0)) revert ZeroAddress();
        if (to == address(this) || to == address(vault)) revert CannotDrip(to);
        if (dripped[to]) revert AlreadyDripped(to);
        uint256 balance = lms.balanceOf(address(this));
        if (balance < scoop()) revert FaucetEmpty(balance, scoop());

        dripped[to] = true;
        if (liquidAmount != 0) lms.safeTransfer(to, liquidAmount);
        if (stakedAmount != 0) vault.depositFor(to, stakedAmount);
        emit Dripped(to, liquidAmount, stakedAmount, msg.sender);
    }
}
