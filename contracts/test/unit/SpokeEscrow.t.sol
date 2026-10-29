// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SpokeEscrow} from "../../src/SpokeEscrow.sol";
import {MockMessenger} from "../../src/mocks/MockMessenger.sol";

contract SpokeEscrowTest is Fixtures {
    SpokeEscrow internal spoke;
    MockMessenger internal spokeMessenger;
    uint32 internal constant HUB_CHAIN = 11_155_111;
    uint256 internal constant FEE = 0.01 ether;

    function setUp() public override {
        super.setUp();
        spokeMessenger = new MockMessenger();
        spokeMessenger.setFee(FEE);
        spoke = new SpokeEscrow(owner, address(spokeMessenger), HUB_CHAIN, address(escrow));
    }

    function test_joinForwardsStakeAndPayload() public {
        bytes32 matchId = keccak256("m");
        uint256 cost = spoke.quoteJoin(matchId, STAKE);
        assertEq(cost, STAKE + FEE);

        vm.prank(players[0]);
        spoke.join{value: cost}(matchId, STAKE);

        assertEq(spokeMessenger.sentCount(), 1);
        MockMessenger.SentMessage memory sent = spokeMessenger.getSent(0);
        assertEq(sent.dstChainId, HUB_CHAIN);
        assertEq(sent.receiver, bytes32(uint256(uint160(address(escrow)))));
        // The stake is the value delivered on the hub; the fee stays with the transport.
        assertEq(sent.value, STAKE);
        (bytes32 forwardedId, address player) = abi.decode(sent.payload, (bytes32, address));
        assertEq(forwardedId, matchId);
        assertEq(player, players[0]);
    }

    function test_refusesAnUnderpaidJoin() public {
        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(SpokeEscrow.InsufficientValue.selector, STAKE, STAKE + FEE));
        spoke.join{value: STAKE}(keccak256("m"), STAKE);
    }

    function test_refundsExcessJoinValue() public {
        uint256 before = players[0].balance;
        vm.prank(players[0]);
        spoke.join{value: STAKE + 0.5 ether}(keccak256("m"), STAKE);
        assertEq(players[0].balance, before - STAKE - FEE);
        assertEq(address(spoke).balance, 0);
    }

    function test_holdsNothingAndReceivesNothing() public {
        // No payout path back to the spoke: it has no receive hook at all.
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(spoke).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_onlyOwnerRepointsTheHub() public {
        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, players[0]));
        spoke.setHub(address(spokeMessenger), HUB_CHAIN, players[0]);
    }
}
