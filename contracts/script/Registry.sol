// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

/// @notice Writes `deployments/<chainId>.json`: every address a deploy
///         created, and the first block to scan for their events.
/// @dev The server reads the file for its defaults, so one deploy configures
///      it without copying addresses into `.env`. Written on a broadcast only:
///      a dry run's addresses were never deployed, and a test must not touch
///      the files.
///
///      ```json
///      { "chainId": 84532, "deployBlock": 123, "contracts": { "escrow": "0x…", … } }
///      ```
///
///      `deployBlock` is the head when the script started, so no contract the
///      file names is older than it: a safe place to start reading logs.
abstract contract Registry is Script {
    /// @dev The `contracts` object as serialised so far.
    string private _contracts = "{}";

    /// @dev Skips a zero address: an optional contract this deploy did not create.
    function _entry(string memory name, address at) internal {
        if (at != address(0)) _contracts = vm.serializeAddress("registry.contracts", name, at);
    }

    /// @dev Call after every `_entry`.
    function _registry(uint256 deployBlock) internal returns (string memory json) {
        string memory root = "registry";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "deployBlock", deployBlock);
        json = vm.serializeString(root, "contracts", _contracts);
    }

    function _record(string memory json) internal {
        bool broadcast = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)
            || vm.isContext(VmSafe.ForgeContext.ScriptResume);
        if (!broadcast) return;
        string memory dir = string.concat(vm.projectRoot(), "/deployments");
        vm.createDir(dir, true);
        vm.writeJson(json, string.concat(dir, "/", vm.toString(block.chainid), ".json"));
    }
}
