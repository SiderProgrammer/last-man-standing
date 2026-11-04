// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";

/// @notice Reads `config/across.json`: the Across SpokePool and WETH on every
///         chain the protocol runs on, hub and spokes.
abstract contract AcrossBook is Script {
    /// @dev Both zero for a chain the file does not list, such as a local node.
    function _across(uint256 chainId) internal view returns (address spokePool, address weth) {
        // Relative, so the gas snapshot does not depend on where the repo is checked out.
        string memory json = vm.readFile("config/across.json");
        string memory key = string.concat(".chains.", vm.toString(chainId));
        if (!vm.keyExistsJson(json, key)) return (address(0), address(0));
        spokePool = vm.parseJsonAddress(json, string.concat(key, ".spokePool"));
        weth = vm.parseJsonAddress(json, string.concat(key, ".weth"));
    }
}
