// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// The canonical WETH9's wrap and unwrap, as Across's WETH9Interface declares them.
interface IWETH9 is IERC20 {
    function deposit() external payable;

    function withdraw(uint256 wad) external;
}
