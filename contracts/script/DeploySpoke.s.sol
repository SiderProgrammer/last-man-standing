// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";

import {SpokeEscrow} from "../src/SpokeEscrow.sol";
import {PlayerAvatars} from "../src/PlayerAvatars.sol";
import {LayerZeroMessenger} from "../src/adapters/LayerZeroMessenger.sol";
import {ILayerZeroEndpoint} from "../src/interfaces/ILayerZeroEndpoint.sol";
import {MockLayerZeroEndpoint} from "../src/mocks/MockLayerZeroEndpoint.sol";

/// @notice Spoke deploy: the chain's `SpokeEscrow`, its `LayerZeroMessenger`,
///         and its own avatar collection. Run once per spoke, on that chain,
///         after the hub exists.
/// @dev Ends up as:
///
///        SpokeEscrow ----sends through----> LayerZeroMessenger --peer--> hub messenger
///             \_ both owned by SPOKE_OWNER (the spoke's timelock) _/
///        PlayerAvatars, owned by SAFE
///
///      The spoke side is wired here, while the deployer still owns it. The
///      hub side cannot be: the hub's config and messenger belong to its
///      timelock, so registering this spoke is a governance proposal with two
///      calls, which the script prints and the governance screen's "Add a
///      spoke chain" template builds:
///
///        config.setRemoteChain(thisChainId, hubMessenger, spokeEscrow)
///        hubMessenger.setPeer(thisChainId, thisEid, spokeMessenger)
///
///      Joins sent before that executes park in the hub messenger and are
///      retried into their seats afterwards, so opening the spoke first loses
///      nothing; it only makes those players wait for the vote.
///
///      Environment:
///        DEPLOYER_PK    pays for the deploy; holds nothing afterwards
///        HUB_CHAIN_ID   the hub's EVM chain id
///        HUB_EID        the hub's LayerZero endpoint id
///        HUB_ESCROW     the hub `GameEscrow`
///        HUB_MESSENGER  the hub `LayerZeroMessenger`
///        LZ_ENDPOINT    this chain's LayerZero endpoint (a mock on a local node if unset)
///        SPOKE_OWNER    this chain's timelock; required off a local node
///        SAFE           owns the avatar collection; required off a local node
///        RECEIVE_GAS    gas for `lzReceive` on the hub, default 350k
///        AVATARS        false to skip the avatar collection
contract DeploySpoke is Script {
    /// @dev The two chains `npm run dev:fork` runs: the hub fork and a spoke.
    uint256 private constant LOCAL_HUB = 31_337;
    uint256 private constant LOCAL_SPOKE = 31_338;
    uint256 private constant DEFAULT_RECEIVE_GAS = 350_000;

    struct SpokeDeployment {
        SpokeEscrow spoke;
        LayerZeroMessenger messenger;
        address endpoint;
        PlayerAvatars avatars;
        address owner;
    }

    error OwnerRequired();
    error SafeRequired();
    error EndpointRequired();
    error HubRequired();

    function run() external returns (SpokeDeployment memory d) {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(pk);
        uint32 hubChainId = uint32(vm.envUint("HUB_CHAIN_ID"));
        uint32 hubEid = uint32(vm.envUint("HUB_EID"));
        address hubEscrow = vm.envAddress("HUB_ESCROW");
        address hubMessenger = vm.envAddress("HUB_MESSENGER");
        if (hubEscrow == address(0) || hubMessenger == address(0) || hubChainId == block.chainid) {
            revert HubRequired();
        }

        // Like the hub's `SAFE`: a local node may default to the deployer;
        // anywhere else a missing variable must not quietly mean "an EOA".
        d.owner = vm.envOr("SPOKE_OWNER", address(0));
        if (d.owner == address(0)) {
            if (!_local()) revert OwnerRequired();
            d.owner = deployer;
        }
        address safe = vm.envOr("SAFE", address(0));
        if (safe == address(0)) {
            if (!_local()) revert SafeRequired();
            safe = deployer;
        }

        vm.startBroadcast(pk);

        d.endpoint = vm.envOr("LZ_ENDPOINT", address(0));
        if (d.endpoint == address(0)) {
            if (!_local()) revert EndpointRequired();
            d.endpoint = address(new MockLayerZeroEndpoint());
        }

        // Deployer-owned until the end, so the spoke side can be wired here.
        d.messenger = new LayerZeroMessenger(
            deployer,
            ILayerZeroEndpoint(d.endpoint),
            address(0),
            uint128(vm.envOr("RECEIVE_GAS", DEFAULT_RECEIVE_GAS))
        );
        d.spoke = new SpokeEscrow(deployer, address(d.messenger), hubChainId, hubEscrow);
        d.messenger.setApp(address(d.spoke));
        d.messenger.setPeer(hubChainId, hubEid, bytes32(uint256(uint160(hubMessenger))));

        if (vm.envOr("AVATARS", true)) {
            d.avatars = new PlayerAvatars(
                safe,
                "LMS Avatars",
                "LMSA",
                vm.envOr("AVATAR_MAX_SUPPLY", uint256(10_000)),
                vm.envOr("AVATAR_BASE_URI", string("ipfs://bafyplaceholder/"))
            );
        }

        // Both are `Ownable2Step`: this only proposes the owner, which must
        // call `acceptOwnership` on each — one proposal on the spoke's own
        // timelock. The delegate moves at once, so the timelock can set the
        // messenger's verifiers in that same proposal.
        if (d.owner != deployer) {
            d.messenger.setDelegate(d.owner);
            d.messenger.transferOwnership(d.owner);
            d.spoke.transferOwnership(d.owner);
        }

        vm.stopBroadcast();
        _report(d, hubMessenger);
    }

    function _local() private view returns (bool) {
        return block.chainid == LOCAL_HUB || block.chainid == LOCAL_SPOKE;
    }

    function _report(SpokeDeployment memory d, address hubMessenger) private view {
        console.log("SpokeEscrow       ", address(d.spoke));
        console.log("LayerZeroMessenger", address(d.messenger));
        console.log("Endpoint          ", d.endpoint);
        if (address(d.avatars) != address(0)) console.log("PlayerAvatars     ", address(d.avatars));
        console.log("");
        console.log("Register this spoke on the hub with one governance proposal:");
        console.log("  config.setRemoteChain(chainId, hubMessenger, spokeEscrow)");
        console.log("    chainId     ", block.chainid);
        console.log("    hubMessenger", hubMessenger);
        console.log("    spokeEscrow ", address(d.spoke));
        console.log("  hubMessenger.setPeer(chainId, eid, spokeMessenger)");
        console.log("    eid          this chain's LayerZero endpoint id");
        console.log("    spokeMessenger", address(d.messenger));
        if (d.owner != vm.addr(vm.envUint("DEPLOYER_PK"))) {
            console.log("");
            console.log("Then have SPOKE_OWNER call acceptOwnership() on both contracts above.");
        }
    }
}
