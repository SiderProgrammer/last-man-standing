// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {Registry} from "./Registry.sol";

import {PlayerAvatars} from "../src/PlayerAvatars.sol";

/// @notice Spoke deploy: the chain's own avatar collection. Run once per
///         spoke, on that chain, after the hub exists.
/// @dev Environment:
///        DEPLOYER_PK    pays for the deploy; holds nothing afterwards
///        SPOKE_OWNER    this chain's timelock; required off a local node
///        AVATARS        false to skip the avatar collection
///
///      On a broadcast it writes `deployments/<chainId>.json` (see `Registry`).
contract DeploySpoke is Registry {
    /// @dev The two chains `npm run dev:fork` runs: the hub fork and a spoke.
    uint256 private constant LOCAL_HUB = 31_337;
    uint256 private constant LOCAL_SPOKE = 31_338;

    struct SpokeDeployment {
        PlayerAvatars avatars;
        address owner;
        /// @dev The head when the script started: no contract here is older.
        uint256 deployBlock;
    }

    error OwnerRequired();

    function run() external returns (SpokeDeployment memory d) {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(pk);

        // Like the hub's `SAFE`: a local node may default to the deployer;
        // anywhere else a missing variable must not quietly mean "an EOA".
        d.owner = vm.envOr("SPOKE_OWNER", address(0));
        if (d.owner == address(0)) {
            if (!_local()) revert OwnerRequired();
            d.owner = deployer;
        }

        d.deployBlock = block.number;
        vm.startBroadcast(pk);
        if (vm.envOr("AVATARS", true)) {
            d.avatars = new PlayerAvatars(
                d.owner,
                "LMS Avatars",
                "LMSA",
                vm.envOr("AVATAR_MAX_SUPPLY", uint256(10_000)),
                vm.envOr("AVATAR_BASE_URI", string("ipfs://bafyplaceholder/"))
            );
        }
        vm.stopBroadcast();

        if (address(d.avatars) != address(0)) console.log("PlayerAvatars", address(d.avatars));
        _record(registry(d));
    }

    /// @notice The `deployments/<chainId>.json` contents for `d`.
    function registry(SpokeDeployment memory d) public returns (string memory) {
        _entry("avatars", address(d.avatars));
        _entry("owner", d.owner);
        return _registry(d.deployBlock);
    }

    function _local() private view returns (bool) {
        return block.chainid == LOCAL_HUB || block.chainid == LOCAL_SPOKE;
    }
}
