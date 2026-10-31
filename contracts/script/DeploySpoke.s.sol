// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {Registry} from "./Registry.sol";
import {AcrossBook} from "./AcrossBook.sol";

import {PlayerAvatars} from "../src/PlayerAvatars.sol";
import {SpokeRouter} from "../src/periphery/SpokeRouter.sol";
import {IAcrossSpokePool} from "../src/vendor/across/IAcrossSpokePool.sol";
import {IWETH9} from "../src/vendor/across/IWETH9.sol";
import {MockAcrossSpokePool} from "../src/mocks/MockAcrossSpokePool.sol";
import {MockWETH} from "../src/mocks/MockWETH.sol";

/// @notice Spoke deploy: the chain's `SpokeRouter`, and its own avatar
///         collection. Run once per spoke, on that chain, after the hub exists.
/// @dev The router has no owner and needs no registration on the hub: the
///      hub's `BridgeJoinReceiver` takes a fill from any chain Across serves.
///      So a new spoke is live as soon as this script has run and the server
///      lists it in `SPOKES`.
///
///      Environment:
///        DEPLOYER_PK    pays for the deploy; holds nothing afterwards
///        HUB_CHAIN_ID   the hub's EVM chain id
///        HUB_RECEIVER   the hub's `BridgeJoinReceiver`
///        HUB_WETH       the hub's WETH; defaults to `config/across.json`
///        SPOKE_POOL     this chain's Across SpokePool; defaults to `config/across.json`,
///                       or a `MockAcrossSpokePool` on a local node
///        SPOKE_OWNER    owns the avatar collection: this chain's timelock;
///                       required off a local node
///        AVATARS        false to skip the avatar collection
///
///      On a broadcast it writes `deployments/<chainId>.json` (see `Registry`).
contract DeploySpoke is Registry, AcrossBook {
    /// @dev The two chains `npm run dev:fork` runs: the hub fork and a spoke.
    uint256 private constant LOCAL_HUB = 31_337;
    uint256 private constant LOCAL_SPOKE = 31_338;

    struct SpokeDeployment {
        SpokeRouter router;
        /// @dev The SpokePool the router deposits into: Across's, or a mock.
        address spokePool;
        address weth;
        PlayerAvatars avatars;
        address owner;
        /// @dev The head when the script started: no contract here is older.
        uint256 deployBlock;
    }

    error OwnerRequired();
    error HubRequired();
    error SpokePoolRequired();

    function run() external returns (SpokeDeployment memory d) {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(pk);
        uint256 hubChainId = vm.envUint("HUB_CHAIN_ID");
        address hubReceiver = vm.envAddress("HUB_RECEIVER");
        (, address hubWeth) = _across(hubChainId);
        hubWeth = vm.envOr("HUB_WETH", hubWeth);
        if (hubReceiver == address(0) || hubWeth == address(0) || hubChainId == block.chainid) {
            revert HubRequired();
        }

        // Like the hub's `SAFE`: a local node may default to the deployer;
        // anywhere else a missing variable must not quietly mean "an EOA".
        d.owner = vm.envOr("SPOKE_OWNER", address(0));
        if (d.owner == address(0)) {
            if (!_local()) revert OwnerRequired();
            d.owner = deployer;
        }

        d.deployBlock = block.number;
        vm.startBroadcast(pk);

        (d.spokePool, d.weth) = _across(block.chainid);
        d.spokePool = vm.envOr("SPOKE_POOL", d.spokePool);
        if (d.spokePool == address(0)) {
            if (!_local()) revert SpokePoolRequired();
            // A relayer stand-in: `npm run dev:fork` fills its deposits on the hub.
            d.weth = address(new MockWETH());
            d.spokePool = address(new MockAcrossSpokePool(IWETH9(d.weth)));
        } else {
            d.weth = IAcrossSpokePool(d.spokePool).wrappedNativeToken();
        }
        d.router = new SpokeRouter(IAcrossSpokePool(d.spokePool), d.weth, hubChainId, hubReceiver, hubWeth);

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

        console.log("SpokeRouter      ", address(d.router));
        console.log("Across SpokePool ", d.spokePool);
        if (address(d.avatars) != address(0)) console.log("PlayerAvatars    ", address(d.avatars));
        _record(registry(d));
    }

    /// @notice The `deployments/<chainId>.json` contents for `d`.
    function registry(SpokeDeployment memory d) public returns (string memory) {
        _entry("spokeRouter", address(d.router));
        _entry("acrossSpokePool", d.spokePool);
        _entry("weth", d.weth);
        _entry("avatars", address(d.avatars));
        _entry("owner", d.owner);
        return _registry(d.deployBlock);
    }

    function _local() private view returns (bool) {
        return block.chainid == LOCAL_HUB || block.chainid == LOCAL_SPOKE;
    }
}
