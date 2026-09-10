// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {ChainlinkVrfAdapter} from "../../src/oracles/ChainlinkVrfAdapter.sol";
import {MockVrfCoordinator} from "../../src/mocks/MockVrfCoordinator.sol";
import {LayerZeroMessenger} from "../../src/adapters/LayerZeroMessenger.sol";
import {MockLayerZeroEndpoint} from "../../src/mocks/MockLayerZeroEndpoint.sol";
import {SpokeEscrow} from "../../src/SpokeEscrow.sol";

contract AdapterTest is Fixtures {
    function test_vrfAdapterDeliversSeedToEscrow() public {
        MockVrfCoordinator coordinator = new MockVrfCoordinator();
        ChainlinkVrfAdapter adapter = new ChainlinkVrfAdapter(
            owner, coordinator, bytes32(uint256(1)), 1, 3, 200_000
        );

        vm.prank(owner);
        config.setRandomnessOracle(address(adapter));

        bytes32 matchId = _createAndFill(4);
        bytes32 requestId = escrow.lockMatch(matchId);
        uint256 vrfId = adapter.vrfIdOf(requestId);
        coordinator.fulfill(vrfId, uint256(keccak256("vrf")));

        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Live));
        assertTrue(escrow.getMatch(matchId).seed != bytes32(0));
    }

    function test_layerZeroMessengerQuotesAndSends() public {
        MockLayerZeroEndpoint endpoint = new MockLayerZeroEndpoint();
        endpoint.setFee(0.01 ether);
        LayerZeroMessenger lz = new LayerZeroMessenger(owner, endpoint, address(escrow), bytes(""));

        bytes memory payload = abi.encode(bytes32(uint256(1)), players[0]);
        uint256 fee = lz.quote(40161, bytes32(uint256(uint160(address(escrow)))), payload);
        assertEq(fee, 0.01 ether);

        vm.prank(players[0]);
        vm.deal(players[0], 1 ether);
        bytes32 guid = lz.sendMessage{value: 0.01 ether}(
            40161, bytes32(uint256(uint160(address(escrow)))), payload
        );
        assertTrue(guid != bytes32(0));
    }

    function test_layerZeroReceiveForwardsToSpoke() public {
        MockLayerZeroEndpoint endpoint = new MockLayerZeroEndpoint();

        SpokeEscrow spoke = new SpokeEscrow(owner, address(messenger), 40161, address(escrow));
        LayerZeroMessenger lz = new LayerZeroMessenger(owner, endpoint, address(spoke), bytes(""));
        vm.prank(owner);
        spoke.setHub(address(lz), 40161, address(escrow));

        bytes memory inner = abi.encode(players[0], uint256(1 ether));
        bytes memory envelope = abi.encode(address(escrow), inner);
        endpoint.deliver{value: 1 ether}(
            address(lz), 40161, bytes32(uint256(uint160(address(escrow)))), envelope, 1 ether
        );
        assertEq(spoke.withdrawable(players[0]), 1 ether);
    }
}
