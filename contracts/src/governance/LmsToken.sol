// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

import {ZeroAddress} from "../Errors.sol";

/// @title LmsToken
/// @notice The protocol token. Holding it does nothing on its own: voting
///         power and the fee share both come from staking it in `StakedLms`.
///
/// @dev Fixed supply, minted once to `recipient`, with no owner and no mint
///      function, so nobody can dilute stakers after launch. How the supply is
///      distributed — liquidity, grants, the treasury — is decided by
///      whoever receives it, not by this contract.
///
///      `ERC20Permit` lets a holder approve the vault and stake in one
///      transaction through `permit`.
contract LmsToken is ERC20, ERC20Permit {
    constructor(address recipient, uint256 supply)
        ERC20("Last Man Standing", "LMS")
        ERC20Permit("Last Man Standing")
    {
        if (recipient == address(0)) revert ZeroAddress();
        _mint(recipient, supply);
    }
}
