// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {DeploySpoke} from "../../script/DeploySpoke.s.sol";
import {LayerZeroMessenger} from "../../src/adapters/LayerZeroMessenger.sol";
import {MockLayerZeroEndpoint} from "../../src/mocks/MockLayerZeroEndpoint.sol";

/// @dev Runs the real spoke deploy against a hub built from the fixtures, then
///      walks a join across it. One EVM plays both chains; `vm.chainId` moves
///      between them. The environment is process-wide and suites run in
///      parallel, so this sets only what `Deploy.t.sol` sets to the same value
///      (`DEPLOYER_PK`, `SAFE`) or what no other script reads (`HUB_*`), and
///      never `LZ_ENDPOINT`, `SPOKE_OWNER` or `RECEIVE_GAS`.
contract DeploySpokeTest is Fixtures {
    uint256 private constant DEPLOYER_PK = 0xDE9107;
    uint32 private constant HUB_CHAIN = 31_337;
    uint32 private constant HUB_EID = 50_337;
    uint32 private constant SPOKE_CHAIN = 31_338;
    uint32 private constant SPOKE_EID = 50_338;

    MockLayerZeroEndpoint private hubEndpoint;
    LayerZeroMessenger private hubLz;
    DeploySpoke.SpokeDeployment private d;
    address private safe;

    function setUp() public override {
        super.setUp();
        hubEndpoint = new MockLayerZeroEndpoint();
        hubLz = new LayerZeroMessenger(owner, hubEndpoint, address(escrow), 350_000);

        vm.deal(vm.addr(DEPLOYER_PK), 10 ether);
        vm.setEnv("DEPLOYER_PK", vm.toString(DEPLOYER_PK));
        safe = makeAddr("safe");
        vm.setEnv("SAFE", vm.toString(safe));
        vm.setEnv("HUB_CHAIN_ID", vm.toString(uint256(HUB_CHAIN)));
        vm.setEnv("HUB_EID", vm.toString(uint256(HUB_EID)));
        vm.setEnv("HUB_ESCROW", vm.toString(address(escrow)));
        vm.setEnv("HUB_MESSENGER", vm.toString(address(hubLz)));

        vm.chainId(SPOKE_CHAIN);
        d = new DeploySpoke().run();
        vm.chainId(HUB_CHAIN);
    }

    function _b32(address account) private pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }

    /// @dev What the governance proposal does on the hub.
    function _register() private {
        vm.startPrank(owner);
        config.setRemoteChain(SPOKE_CHAIN, address(hubLz), _b32(address(d.spoke)));
        hubLz.setPeer(SPOKE_CHAIN, SPOKE_EID, _b32(address(d.messenger)));
        vm.stopPrank();
    }

    /// @dev A player joins on the spoke; the relayer carries it to the hub.
    function _joinFromSpoke(bytes32 matchId, address player) private returns (bytes32 guid) {
        vm.chainId(SPOKE_CHAIN);
        uint256 cost = d.spoke.quoteJoin(matchId, STAKE);
        vm.deal(player, cost);
        vm.prank(player);
        d.spoke.join{value: cost}(matchId, STAKE);
        MockLayerZeroEndpoint spokeEndpoint = MockLayerZeroEndpoint(d.endpoint);
        MockLayerZeroEndpoint.Sent memory sent = spokeEndpoint.getSent(spokeEndpoint.sentCount() - 1);

        vm.chainId(HUB_CHAIN);
        assertEq(sent.dstEid, HUB_EID);
        assertEq(sent.receiver, _b32(address(hubLz)));
        vm.deal(address(hubEndpoint), sent.value);
        guid = hubEndpoint.deliver(
            address(hubLz), SPOKE_EID, _b32(address(d.messenger)), sent.message, sent.value
        );
    }

    function test_wiresTheSpokeSideToTheHub() public view {
        assertEq(d.messenger.app(), address(d.spoke));
        assertEq(d.messenger.peers(HUB_EID), _b32(address(hubLz)));
        assertEq(d.messenger.eidOf(HUB_CHAIN), HUB_EID);
        assertEq(d.spoke.hubChainId(), HUB_CHAIN);
        assertEq(d.spoke.hubEscrow(), _b32(address(escrow)));
        assertEq(d.spoke.messenger(), address(d.messenger));
        // On a local node, with no SPOKE_OWNER, the deployer keeps both.
        assertEq(d.owner, vm.addr(DEPLOYER_PK));
        assertEq(d.spoke.owner(), d.owner);
        assertEq(d.avatars.owner(), safe);
    }

    function test_registeredSpokeSeatsAPlayer() public {
        _register();
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);

        address remote = makeAddr("remote");
        _joinFromSpoke(matchId, remote);

        assertTrue(escrow.hasSeat(matchId, remote));
        assertEq(escrow.seatOrigin(matchId, remote), SPOKE_CHAIN);
    }

    /// @dev The spoke opened before governance registered it: the join parks,
    ///      and once the proposal executes, anyone retries it into the seat.
    function test_aJoinBeforeRegistrationParksThenSeats() public {
        // The hub messenger already knows the spoke's messenger (or the
        // endpoint would never open the path), but the config does not trust
        // the route yet.
        vm.prank(owner);
        hubLz.setPeer(SPOKE_CHAIN, SPOKE_EID, _b32(address(d.messenger)));
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);

        address remote = makeAddr("remote");
        bytes32 guid = _joinFromSpoke(matchId, remote);
        assertFalse(escrow.hasSeat(matchId, remote));
        assertEq(hubLz.totalParked(), STAKE);

        _register();
        hubLz.retry(guid, SPOKE_CHAIN, _b32(address(d.spoke)), abi.encode(matchId, remote), STAKE);
        assertTrue(escrow.hasSeat(matchId, remote));
        assertEq(hubLz.totalParked(), 0);
    }

    function test_offALocalChain_theSpokeOwnerIsRequired() public {
        vm.chainId(8453);
        DeploySpoke script = new DeploySpoke();
        vm.expectRevert(DeploySpoke.OwnerRequired.selector);
        script.run();
    }
}
