// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {LayerZeroMessenger} from "../../src/adapters/LayerZeroMessenger.sol";
import {MockLayerZeroEndpoint} from "../../src/mocks/MockLayerZeroEndpoint.sol";
import {Origin} from "../../src/interfaces/ILayerZeroEndpoint.sol";
import {SpokeEscrow} from "../../src/SpokeEscrow.sol";
import {UnknownRequest, UntrustedMessenger, UntrustedPeer} from "../../src/Errors.sol";

contract AdapterTest is Fixtures {
    // --- LayerZero: one endpoint mock plays both chains -------------------

    uint32 internal constant HUB_CHAIN = 11_155_111;
    uint32 internal constant HUB_EID = 40_161;
    uint32 internal constant SPOKE_CHAIN = 421_614;
    uint32 internal constant SPOKE_EID = 40_231;
    uint128 internal constant RECEIVE_GAS = 350_000;

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
        bytes memory message =
            abi.encode(_b32(address(b.spoke)), _b32(address(escrow)), abi.encode(bytes32(0), players[5]));

        vm.deal(address(b.endpoint), STAKE);
        vm.expectRevert(abi.encodeWithSelector(UntrustedPeer.selector, SPOKE_EID, _b32(address(rogue))));
        b.endpoint.deliver(address(b.hubLz), SPOKE_EID, _b32(address(rogue)), message, STAKE);
        assertFalse(b.hubLz.allowInitializePath(Origin(SPOKE_EID, _b32(address(rogue)), 0)));
        assertTrue(b.hubLz.allowInitializePath(Origin(SPOKE_EID, _b32(address(b.spokeLz)), 0)));
    }

    /// @dev The escrow sees the originating app, so a trusted messenger
    ///      carrying a message from the wrong app still fails the peer check —
    ///      and the value is parked rather than seated, and can never be
    ///      retried into a seat while the peer is wrong.
    function test_layerZeroPassesTheOriginatingAppToTheEscrow() public {
        Bridge memory b = _bridge();
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        bytes memory payload = abi.encode(matchId, players[6]);
        bytes memory message = abi.encode(_b32(players[6]), _b32(address(escrow)), payload);

        vm.deal(address(b.endpoint), STAKE);
        bytes32 guid =
            b.endpoint.deliver(address(b.hubLz), SPOKE_EID, _b32(address(b.spokeLz)), message, STAKE);

        assertFalse(escrow.hasSeat(matchId, players[6]));
        assertEq(b.hubLz.totalParked(), STAKE);
        vm.expectRevert(abi.encodeWithSelector(UntrustedPeer.selector, SPOKE_CHAIN, _b32(players[6])));
        b.hubLz.retry(guid, SPOKE_CHAIN, _b32(players[6]), payload, STAKE);
    }

    // --- LayerZero: a delivery the hub refuses is parked, not lost ---------

    /// @dev Sends a join from the spoke and delivers it, returning its guid.
    function _joinAcross(Bridge memory b, bytes32 matchId, address player) internal returns (bytes32 guid) {
        uint256 cost = b.spoke.quoteJoin(matchId, STAKE);
        vm.deal(player, cost);
        vm.prank(player);
        b.spoke.join{value: cost}(matchId, STAKE);

        MockLayerZeroEndpoint.Sent memory sent = b.endpoint.getSent(b.endpoint.sentCount() - 1);
        vm.deal(address(b.endpoint), sent.value);
        guid = b.endpoint
            .deliver(address(b.hubLz), SPOKE_EID, _b32(address(b.spokeLz)), sent.message, sent.value);
    }

    /// @dev The case that used to strand a stake: the spoke went live before
    ///      governance registered it on the hub, so the escrow refuses the
    ///      messenger. The stake waits in the messenger; once the route is
    ///      registered, anyone retries it into the seat for free.
    function test_layerZeroParksADeliveryTheHubIsNotConfiguredForAndRetriesIt() public {
        Bridge memory b = _bridge();
        vm.prank(owner);
        config.setRemoteChain(SPOKE_CHAIN, address(0), bytes32(0));

        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        address remote = makeAddr("remote");
        uint256 escrowBefore = address(escrow).balance;

        vm.recordLogs();
        bytes32 guid = _joinAcross(b, matchId, remote);

        assertFalse(escrow.hasSeat(matchId, remote));
        assertEq(address(escrow).balance, escrowBefore);
        assertEq(address(b.hubLz).balance, STAKE);
        assertEq(b.hubLz.totalParked(), STAKE);
        bytes memory payload = abi.encode(matchId, remote);
        assertEq(
            b.hubLz.parked(guid),
            keccak256(abi.encode(SPOKE_CHAIN, _b32(address(b.spoke)), payload, uint256(STAKE)))
        );

        // Still refused: the retry reverts and the delivery stays parked.
        vm.expectRevert(abi.encodeWithSelector(UntrustedMessenger.selector, SPOKE_CHAIN, address(b.hubLz)));
        b.hubLz.retry(guid, SPOKE_CHAIN, _b32(address(b.spoke)), payload, STAKE);
        assertEq(b.hubLz.totalParked(), STAKE);

        vm.prank(owner);
        config.setRemoteChain(SPOKE_CHAIN, address(b.hubLz), _b32(address(b.spoke)));

        vm.prank(makeAddr("anyone"));
        b.hubLz.retry(guid, SPOKE_CHAIN, _b32(address(b.spoke)), payload, STAKE);

        assertTrue(escrow.hasSeat(matchId, remote));
        assertEq(escrow.seatOrigin(matchId, remote), SPOKE_CHAIN);
        assertEq(address(b.hubLz).balance, 0);
        assertEq(b.hubLz.totalParked(), 0);
        assertEq(b.hubLz.parked(guid), bytes32(0));

        // And it cannot be replayed into a second seat or a second refund.
        vm.expectRevert(abi.encodeWithSelector(LayerZeroMessenger.NotParked.selector, guid));
        b.hubLz.retry(guid, SPOKE_CHAIN, _b32(address(b.spoke)), payload, STAKE);
    }

    function test_layerZeroParksWhenNoAppIsSet() public {
        Bridge memory b = _bridge();
        // A hub messenger deployed before the escrow, never pointed at it.
        LayerZeroMessenger fresh = new LayerZeroMessenger(owner, b.endpoint, address(0), RECEIVE_GAS);
        vm.prank(owner);
        fresh.setPeer(SPOKE_CHAIN, SPOKE_EID, _b32(address(b.spokeLz)));

        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        bytes memory payload = abi.encode(matchId, players[6]);
        bytes memory message = abi.encode(_b32(address(b.spoke)), _b32(address(escrow)), payload);
        vm.deal(address(b.endpoint), STAKE);
        bytes32 guid = b.endpoint.deliver(address(fresh), SPOKE_EID, _b32(address(b.spokeLz)), message, STAKE);
        assertEq(fresh.totalParked(), STAKE);

        vm.startPrank(owner);
        fresh.setApp(address(escrow));
        config.setRemoteChain(SPOKE_CHAIN, address(fresh), _b32(address(b.spoke)));
        vm.stopPrank();
        fresh.retry(guid, SPOKE_CHAIN, _b32(address(b.spoke)), payload, STAKE);
        assertTrue(escrow.hasSeat(matchId, players[6]));
    }

    /// @dev A retry must name the parked delivery exactly: changing the
    ///      player or the amount does not match its hash.
    function test_layerZeroRetryRefusesAlteredDeliveries() public {
        Bridge memory b = _bridge();
        vm.prank(owner);
        config.setRemoteChain(SPOKE_CHAIN, address(0), bytes32(0));
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        address remote = makeAddr("remote");
        bytes32 guid = _joinAcross(b, matchId, remote);

        vm.prank(owner);
        config.setRemoteChain(SPOKE_CHAIN, address(b.hubLz), _b32(address(b.spoke)));

        bytes32 spokeApp = _b32(address(b.spoke));
        vm.expectRevert(abi.encodeWithSelector(LayerZeroMessenger.NotParked.selector, guid));
        b.hubLz.retry(guid, SPOKE_CHAIN, spokeApp, abi.encode(matchId, players[6]), STAKE);
        vm.expectRevert(abi.encodeWithSelector(LayerZeroMessenger.NotParked.selector, guid));
        b.hubLz.retry(guid, SPOKE_CHAIN, spokeApp, abi.encode(matchId, remote), STAKE - 1);
    }

    /// @dev An app that burns all the gas it is given still leaves enough
    ///      behind to park: the stake is never left with the executor.
    function test_layerZeroParksWhenTheAppRunsOutOfGas() public {
        Bridge memory b = _bridge();
        GasBurner burner = new GasBurner();
        LayerZeroMessenger lz = new LayerZeroMessenger(owner, b.endpoint, address(burner), RECEIVE_GAS);
        vm.prank(owner);
        lz.setPeer(SPOKE_CHAIN, SPOKE_EID, _b32(address(b.spokeLz)));

        bytes memory message =
            abi.encode(_b32(address(b.spoke)), _b32(address(burner)), abi.encode(bytes32(0), players[6]));
        vm.deal(address(b.endpoint), STAKE);
        // The executor gives `lzReceive` exactly the gas the options asked for.
        (bool ok,) = address(b.endpoint).call{gas: RECEIVE_GAS + 30_000}(
            abi.encodeCall(
                MockLayerZeroEndpoint.deliver,
                (address(lz), SPOKE_EID, _b32(address(b.spokeLz)), message, STAKE)
            )
        );
        assertTrue(ok);
        assertEq(lz.totalParked(), STAKE);
        assertEq(address(lz).balance, STAKE);
    }

    /// @dev A delivery executed with too little gas would otherwise fail
    ///      inside the escrow and park a join that should have seated. It
    ///      reverts instead, leaving the message for a properly gassed call.
    function test_layerZeroRefusesADeliveryWithTooLittleGasRatherThanParkIt() public {
        Bridge memory b = _bridge();
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);
        address remote = makeAddr("remote");
        bytes memory message =
            abi.encode(_b32(address(b.spoke)), _b32(address(escrow)), abi.encode(matchId, remote));

        vm.deal(address(b.endpoint), STAKE);
        (bool ok,) = address(b.endpoint).call{gas: 200_000}(
            abi.encodeCall(
                MockLayerZeroEndpoint.deliver,
                (address(b.hubLz), SPOKE_EID, _b32(address(b.spokeLz)), message, STAKE)
            )
        );
        assertFalse(ok);
        assertEq(b.hubLz.totalParked(), 0);
        assertFalse(escrow.hasSeat(matchId, remote));

        // The same message with the gas the executor is told to give seats.
        b.endpoint.deliver{gas: RECEIVE_GAS}(
            address(b.hubLz), SPOKE_EID, _b32(address(b.spokeLz)), message, STAKE
        );
        assertTrue(escrow.hasSeat(matchId, remote));
    }

    function test_layerZeroMakesItsOwnerTheEndpointDelegate() public {
        Bridge memory b = _bridge();
        assertEq(b.endpoint.delegates(address(b.hubLz)), owner);

        address timelock = makeAddr("timelock");
        vm.prank(owner);
        b.hubLz.setDelegate(timelock);
        assertEq(b.endpoint.delegates(address(b.hubLz)), timelock);

        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, players[0]));
        b.hubLz.setDelegate(players[0]);
    }

    /// @dev Too little gas would leave no room to park after a failed join.
    function test_layerZeroRefusesAReceiveGasTooLowToPark() public {
        MockLayerZeroEndpoint endpoint = new MockLayerZeroEndpoint();
        uint128 low = 100_000;
        vm.expectRevert(abi.encodeWithSelector(LayerZeroMessenger.ReceiveGasTooLow.selector, low));
        new LayerZeroMessenger(owner, endpoint, address(escrow), low);

        LayerZeroMessenger lz = new LayerZeroMessenger(owner, endpoint, address(escrow), RECEIVE_GAS);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(LayerZeroMessenger.ReceiveGasTooLow.selector, low));
        lz.setReceiveGas(low);
    }

    function test_layerZeroRefusesAnUnknownDestination() public {
        Bridge memory b = _bridge();
        vm.expectRevert(abi.encodeWithSelector(LayerZeroMessenger.UnknownChain.selector, uint32(999)));
        b.hubLz.quote(999, bytes32(0), "", 0);
    }
}

/// @dev A receiver that consumes every unit of gas it is handed.
contract GasBurner {
    function receiveMessage(uint32, bytes32, bytes calldata) external payable {
        while (true) {}
    }
}
