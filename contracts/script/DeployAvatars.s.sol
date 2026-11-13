// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {PlayerAvatars} from "../src/PlayerAvatars.sol";

/// @notice Replaces one chain's avatar collection, leaving everything else that
///         chain has deployed alone. Run once per chain, hub and spokes alike.
/// @dev `maxSupply` is immutable and the hub's owner is the timelock, so new art
///      or a new supply is cheaper as a fresh collection than as a governance
///      proposal. Avatars sit outside consensus and nothing else holds the
///      collection's address, so swapping it only costs the old tokens: they
///      stay on the old contract, which the server stops reading.
///
///      Environment:
///        DEPLOYER_PK        pays for the deploy; holds nothing afterwards
///        AVATAR_BASE_URI    `ipfs://<metadata folder CID>/`, from `npm run avatars`;
///                           required, and the placeholder is refused
///        AVATAR_MAX_SUPPLY  defaults to 100; must not exceed the files pinned
///        AVATAR_OWNER       defaults to the registry's `timelock` (a hub), else
///                           its `owner` (a spoke's `SPOKE_OWNER`)
///
///      On a broadcast it rewrites `avatars` in `deployments/<chainId>.json`,
///      which must already exist: this follows `Deploy` or `DeploySpoke`.
contract DeployAvatars is Script {
    error BaseUriRequired();
    error OwnerRequired();

    function run() external returns (PlayerAvatars avatars) {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        string memory baseUri = vm.envString("AVATAR_BASE_URI");
        if (!_isRealBaseUri(baseUri)) revert BaseUriRequired();

        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        string memory registry = vm.readFile(path);
        address owner = vm.envOr("AVATAR_OWNER", _registryOwner(registry));
        if (owner == address(0)) revert OwnerRequired();

        vm.startBroadcast(pk);
        avatars = new PlayerAvatars(owner, "LMS Avatars", "LMSA", vm.envOr("AVATAR_MAX_SUPPLY", uint256(100)), baseUri);
        vm.stopBroadcast();

        console.log("PlayerAvatars ", address(avatars));
        console.log("owner         ", owner);
        console.log("maxSupply     ", avatars.maxSupply());

        bool broadcast = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)
            || vm.isContext(VmSafe.ForgeContext.ScriptResume);
        if (broadcast) vm.writeJson(vm.toString(address(avatars)), path, ".contracts.avatars");
    }

    function _registryOwner(string memory registry) private view returns (address) {
        if (vm.keyExistsJson(registry, ".contracts.timelock")) {
            return vm.parseJsonAddress(registry, ".contracts.timelock");
        }
        if (vm.keyExistsJson(registry, ".contracts.owner")) {
            return vm.parseJsonAddress(registry, ".contracts.owner");
        }
        return address(0);
    }

    /// @dev `ipfs://…/`, and not the deploy scripts' placeholder: a collection
    ///      minted against missing files shows nobody's avatar.
    function _isRealBaseUri(string memory uri) private pure returns (bool) {
        bytes memory b = bytes(uri);
        if (b.length <= 8 || b[b.length - 1] != "/") return false;
        return vm.indexOf(uri, "ipfs://") == 0 && !vm.contains(uri, "bafyplaceholder");
    }
}
