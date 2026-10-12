// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LmsAirdrop} from "../src/governance/LmsAirdrop.sol";
import {StakedLms} from "../src/governance/StakedLms.sol";

/// @notice Deploys an `LmsAirdrop` for a root computed by `scripts/airdrop.mjs`.
/// @dev Deploys only. The airdrop holds nothing until the Safe transfers the
///      total the allocation script printed, which is a Safe transaction and
///      so deliberately not something this script can do.
///
///      Environment: `DEPLOYER_PK`, `LMS`, `STAKED_LMS`, `AIRDROP_ROOT`,
///      `AIRDROP_TREASURY` (where unclaimed LMS is swept, normally the Safe),
///      and optionally `AIRDROP_CLAIM_DAYS` (default 90).
contract DeployAirdrop is Script {
    function run() external returns (LmsAirdrop airdrop) {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        uint256 claimDays = vm.envOr("AIRDROP_CLAIM_DAYS", uint256(90));

        vm.startBroadcast(pk);
        airdrop = new LmsAirdrop(
            IERC20(vm.envAddress("LMS")),
            StakedLms(vm.envAddress("STAKED_LMS")),
            vm.envBytes32("AIRDROP_ROOT"),
            uint64(block.timestamp + claimDays * 1 days),
            vm.envAddress("AIRDROP_TREASURY")
        );
        vm.stopBroadcast();
    }
}
