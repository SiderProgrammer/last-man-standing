// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {ChainlinkVrfAdapter} from "../../src/oracles/ChainlinkVrfAdapter.sol";
import {MockVrfCoordinator} from "../../src/mocks/MockVrfCoordinator.sol";
import {LayerZeroMessenger} from "../../src/adapters/LayerZeroMessenger.sol";
import {MockLayerZeroEndpoint} from "../../src/mocks/MockLayerZeroEndpoint.sol";
import {Origin} from "../../src/interfaces/ILayerZeroEndpoint.sol";
import {SpokeEscrow} from "../../src/SpokeEscrow.sol";

contract AdapterTest is Fixtures {
    function test_vrfAdapterDeliversSeedToEscrow() public {
        MockVrfCoordinator coordinator = new MockVrfCoordinator();
        ChainlinkVrfAdapter adapter = new ChainlinkVrfAdapter(
            owner, coordinator, bytes32(uint256(1)), 1, 3, 200_000
        );

        vm.startPrank(owner);
        config.setRandomnessOracle(address(adapter));
        adapter.setConsumer(address(escrow), true);
        vm.stopPrank();

        bytes32 matchId = _createAndFill(4);
        bytes32 requestId = escrow.lockMatch(matchId);
        uint256 vrfId = adapter.vrfIdOf(requestId);
        coordinator.fulfill(vrfId, uint256(keccak256("vrf")));

        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Live));
        assertTrue(escrow.getMatch(matchId).seed != bytes32(0));
        // A fulfilled request leaves nothing behind.
        assertEq(adapter.vrfIdOf(requestId), 0);
        (address consumer,) = adapter.pending(vrfId);
        assertEq(consumer, address(0));
    }

    function test_vrfAdapterRefusesUnregisteredConsumers() public {
        MockVrfCoordinator coordinator = new MockVrfCoordinator();
        ChainlinkVrfAdapter adapter = new ChainlinkVrfAdapter(
            owner, coordinator, bytes32(uint256(1)), 1, 3, 200_000
        );

        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkVrfAdapter.NotConsumer.selector, players[0]));
        adapter.requestRandomness(bytes32(uint256(1)));
    }

    function test_vrfAdapterRejectsASecondCallback() public {
        MockVrfCoordinator coordinator = new MockVrfCoordinator();
        ChainlinkVrfAdapter adapter = new ChainlinkVrfAdapter(
            owner, coordinator, bytes32(uint256(1)), 1, 3, 200_000
        );
        vm.startPrank(owner);
        config.setRandomnessOracle(address(adapter));
        adapter.setConsumer(address(escrow), true);
        vm.stopPrank();

        bytes32 matchId = _createAndFill(4);
        uint256 vrfId = adapter.vrfIdOf(escrow.lockMatch(matchId));
        coordinator.fulfill(vrfId, 1);

        uint256[] memory words = new uint256[](1);
        words[0] = 2;
        vm.prank(address(coordinator));
        vm.expectRevert(abi.encodeWithSelector(ChainlinkVrfAdapter.UnknownRequest.selector, vrfId));
        adapter.rawFulfillRandomWords(vrfId, words);
    }

    // --- LayerZero: one endpoint mock plays both chains -------------------

    uint32 internal constant HUB_CHAIN = 11_155_111;
    uint32 internal constant HUB_EID = 40_161;
    uint32 internal constant SPOKE_CHAIN = 421_614;
    uint32 internal constant SPOKE_EID = 40_231;
    uint128 internal constant RECEIVE_GAS = 300_000;

    struct Bridge {
        MockLayerZeroEndpoint endpoint;
        LayerZeroMessenger hubLz;
        LayerZeroMessenger spokeLz;
        SpokeEscrow spoke;
    }

    /// @dev Hub messenger serves the escrow, spoke messenger serves the spoke,
    ///      each knows the other as its peer, and the hub config trusts the
    ///      hub messenger as transport and the spoke *escrow* as the peer app.
    function _bridge() internal returns (Bridge memory b) {
        b.endpoint = new MockLayerZeroEndpoint();
        b.endpoint.setFee(0.01 ether);
        b.hubLz = new LayerZeroMessenger(owner, b.endpoint, address(escrow), RECEIVE_GAS);
        b.spokeLz = new LayerZeroMessenger(owner, b.endpoint, address(0), RECEIVE_GAS);
        b.spoke = new SpokeEscrow(owner, address(b.spokeLz), HUB_CHAIN, address(escrow));

        vm.startPrank(owner);
        b.spokeLz.setApp(address(b.spoke));
        b.hubLz.setPeer(SPOKE_CHAIN, SPOKE_EID, _b32(address(b.spokeLz)));
        b.spokeLz.setPeer(HUB_CHAIN, HUB_EID, _b32(address(b.hubLz)));
        config.setRemoteChain(SPOKE_CHAIN, address(b.hubLz), _b32(address(b.spoke)));
        vm.stopPrank();
    }

    function _b32(address account) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }

    /// @dev Plays the hub endpoint delivering the last message the spoke sent.
    function _relay(Bridge memory b) internal {
        MockLayerZeroEndpoint.Sent memory sent = b.endpoint.getSent(b.endpoint.sentCount() - 1);
        assertEq(sent.dstEid, HUB_EID);
        assertEq(sent.receiver, _b32(address(b.hubLz)));
        vm.deal(address(b.endpoint), sent.value);
        b.endpoint.deliver(address(b.hubLz), SPOKE_EID, _b32(address(b.spokeLz)), sent.message, sent.value);
    }

    function test_layerZeroJoinSeatsThePlayerWithTheExactStake() public {
        Bridge memory b = _bridge();
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);

        address remote = makeAddr("remote");
        uint256 cost = b.spoke.quoteJoin(matchId, STAKE);
        assertEq(cost, 0.01 ether + STAKE);
        vm.deal(remote, cost);
        vm.prank(remote);
        b.spoke.join{value: cost}(matchId, STAKE);

        // The options ask the executor to deliver exactly this lobby's stake.
        MockLayerZeroEndpoint.Sent memory sent = b.endpoint.getSent(0);
        assertEq(sent.value, STAKE);
        assertEq(sent.options, b.hubLz.options(STAKE));

        _relay(b);
        assertTrue(escrow.hasSeat(matchId, remote));
        // Recorded as an EVM chain id, not a LayerZero endpoint id.
        assertEq(escrow.seatOrigin(matchId, remote), SPOKE_CHAIN);
    }

    function test_layerZeroCarriesAnyStakeNotJustOne() public {
        Bridge memory b = _bridge();
        uint128 bigStake = 3 ether;
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(bigStake, 4);

        address remote = makeAddr("remote");
        uint256 cost = b.spoke.quoteJoin(matchId, bigStake);
        vm.deal(remote, cost);
        vm.prank(remote);
        b.spoke.join{value: cost}(matchId, bigStake);
        _relay(b);
        assertTrue(escrow.hasSeat(matchId, remote));
    }

    /// @dev The hole the review found: the messenger used to be open to any
    ///      caller, and the hub only ever saw the messenger as the sender.
    function test_layerZeroRefusesToSendForAnyoneButItsApp() public {
        Bridge memory b = _bridge();
        address stranger = makeAddr("stranger");
        vm.deal(stranger, 2 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(LayerZeroMessenger.NotApp.selector, stranger));
        b.spokeLz.sendMessage{value: 1.01 ether}(
            HUB_CHAIN, _b32(address(escrow)), abi.encode(bytes32(0), stranger), 1 ether
        );
    }

    function test_layerZeroRefusesAMessageFromAnUnknownMessenger() public {
        Bridge memory b = _bridge();
        // A rogue messenger on the spoke chain, wired to an app of its own.
        LayerZeroMessenger rogue = new LayerZeroMessenger(owner, b.endpoint, players[5], RECEIVE_GAS);
        bytes memory message = abi.encode(_b32(address(b.spoke)), _b32(address(escrow)), abi.encode(bytes32(0), players[5]));

        vm.deal(address(b.endpoint), STAKE);
        vm.expectRevert(abi.encodeWithSelector(LayerZeroMessenger.UntrustedPeer.selector, SPOKE_EID, _b32(address(rogue))));
        b.endpoint.deliver(address(b.hubLz), SPOKE_EID, _b32(address(rogue)), message, STAKE);
        assertFalse(b.hubLz.allowInitializePath(Origin(SPOKE_EID, _b32(address(rogue)), 0)));
        assertTrue(b.hubLz.allowInitializePath(Origin(SPOKE_EID, _b32(address(b.spokeLz)), 0)));
    }

    /// @dev The escrow sees the originating app, so a trusted messenger
    ///      carrying a message from the wrong app still fails the peer check.
    function test_layerZeroPassesTheOriginatingAppToTheEscrow() public {
        Bridge memory b = _bridge();
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        bytes memory message =
            abi.encode(_b32(players[6]), _b32(address(escrow)), abi.encode(matchId, players[6]));

        vm.deal(address(b.endpoint), STAKE);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.UntrustedPeer.selector, SPOKE_CHAIN, _b32(players[6])));
        b.endpoint.deliver(address(b.hubLz), SPOKE_EID, _b32(address(b.spokeLz)), message, STAKE);
    }

    function test_layerZeroRefusesAnUnknownDestination() public {
        Bridge memory b = _bridge();
        vm.expectRevert(abi.encodeWithSelector(LayerZeroMessenger.UnknownChain.selector, uint32(999)));
        b.hubLz.quote(999, bytes32(0), "", 0);
    }
}
