// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {SpokeEscrow} from "../../src/SpokeEscrow.sol";
import {MockMessenger} from "../../src/mocks/MockMessenger.sol";

contract SpokeEscrowTest is Fixtures {
    SpokeEscrow internal spoke;
    MockMessenger internal spokeMessenger;
    uint32 internal constant HUB_EID = 40161;

    function setUp() public override {
        super.setUp();
        spokeMessenger = new MockMessenger();
        spoke = new SpokeEscrow(owner, address(spokeMessenger), HUB_EID, address(escrow));
    }

    function test_joinForwardsStakeAndPayload() public {
        bytes32 matchId = keccak256("m");
        vm.prank(players[0]);
        spoke.join{value: STAKE}(matchId, STAKE);

        assertEq(spokeMessenger.sentCount(), 1);
        MockMessenger.SentMessage memory sent = spokeMessenger.getSent(0);
        assertEq(sent.dstChainId, HUB_EID);
        assertEq(sent.receiver, bytes32(uint256(uint160(address(escrow)))));
        assertEq(sent.value, STAKE);
        (bytes32 forwardedId, address player) = abi.decode(sent.payload, (bytes32, address));
        assertEq(forwardedId, matchId);
        assertEq(player, players[0]);
    }

    function test_receivePayoutAndWithdraw() public {
        bytes32 hub = bytes32(uint256(uint160(address(escrow))));
        spokeMessenger.deliver{value: 2 ether}(
            address(spoke), HUB_EID, hub, abi.encode(players[0], uint256(2 ether)), 2 ether
        );
        assertEq(spoke.withdrawable(players[0]), 2 ether);
        assertEq(spoke.totalOwed(), 2 ether);

        uint256 before = players[0].balance;
        vm.prank(players[0]);
        spoke.withdraw(players[0]);
        assertEq(players[0].balance, before + 2 ether);
        assertEq(spoke.totalOwed(), 0);
    }

    function test_rejectsUntrustedDelivery() public {
        vm.expectRevert();
        spoke.receiveMessage{value: 1 ether}(
            HUB_EID, bytes32(uint256(uint160(address(escrow)))), abi.encode(players[0], uint256(1 ether))
        );
    }

    function test_refundsExcessJoinValue() public {
        uint256 before = players[0].balance;
        vm.prank(players[0]);
        spoke.join{value: STAKE + 0.5 ether}(keccak256("m"), STAKE);
        assertEq(players[0].balance, before - STAKE);
    }
}
