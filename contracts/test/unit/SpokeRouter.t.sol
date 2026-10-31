// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {SpokeRouter} from "../../src/periphery/SpokeRouter.sol";
import {MockAcrossSpokePool} from "../../src/mocks/MockAcrossSpokePool.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {IAcrossSpokePool} from "../../src/vendor/across/IAcrossSpokePool.sol";
import {IWETH9} from "../../src/vendor/across/IWETH9.sol";
import {ZeroAddress} from "../../src/Errors.sol";

contract SpokeRouterTest is Test {
    uint256 private constant HUB_CHAIN = 84_532;
    uint256 private constant STAKE = 0.01 ether;
    uint256 private constant FEE = 0.0001 ether;
    bytes32 private constant MATCH = keccak256("match");

    MockWETH private weth;
    MockAcrossSpokePool private pool;
    SpokeRouter private router;
    address private hubReceiver;
    address private hubWeth;
    address private player;

    function setUp() public {
        vm.chainId(421_614);
        vm.warp(1_800_000_000);
        weth = new MockWETH();
        pool = new MockAcrossSpokePool(IWETH9(address(weth)));
        hubReceiver = makeAddr("hubReceiver");
        hubWeth = makeAddr("hubWeth");
        router =
            new SpokeRouter(IAcrossSpokePool(address(pool)), address(weth), HUB_CHAIN, hubReceiver, hubWeth);
        player = makeAddr("player");
        vm.deal(player, 1 ether);
    }

    function _quote(uint256 outputAmount) private view returns (SpokeRouter.Quote memory) {
        return SpokeRouter.Quote({
            outputAmount: outputAmount,
            quoteTimestamp: uint32(block.timestamp),
            fillDeadline: uint32(block.timestamp + 2 hours),
            exclusiveRelayer: address(0),
            exclusivityParameter: 0
        });
    }

    function test_join_depositsTheStakeForTheHubReceiver() public {
        vm.expectEmit(true, true, true, true, address(router));
        emit SpokeRouter.JoinBridged(MATCH, player, player, STAKE + FEE, STAKE);
        vm.prank(player);
        router.join{value: STAKE + FEE}(MATCH, address(0), _quote(STAKE));

        MockAcrossSpokePool.Deposit memory deposit = pool.getDeposit(0);
        assertEq(deposit.depositor, player, "refunds go to the player");
        assertEq(deposit.recipient, hubReceiver);
        assertEq(deposit.inputToken, address(weth));
        assertEq(deposit.outputToken, hubWeth);
        assertEq(deposit.inputAmount, STAKE + FEE);
        assertEq(deposit.outputAmount, STAKE);
        assertEq(deposit.destinationChainId, HUB_CHAIN);
        assertEq(deposit.message, abi.encode(MATCH, player, uint32(421_614)));
        assertEq(deposit.message, router.joinMessage(MATCH, player));

        assertEq(weth.balanceOf(address(pool)), STAKE + FEE);
        assertEq(address(router).balance, 0, "the router holds nothing");
    }

    function test_join_passesTheQuoteThrough() public {
        SpokeRouter.Quote memory quote = _quote(STAKE);
        quote.exclusiveRelayer = makeAddr("relayer");
        quote.exclusivityParameter = 3;
        vm.prank(player);
        router.join{value: STAKE + FEE}(MATCH, address(0), quote);

        MockAcrossSpokePool.Deposit memory deposit = pool.getDeposit(0);
        assertEq(deposit.exclusiveRelayer, quote.exclusiveRelayer);
        assertEq(deposit.exclusivityParameter, 3);
        assertEq(deposit.quoteTimestamp, quote.quoteTimestamp);
        assertEq(deposit.fillDeadline, quote.fillDeadline);
    }

    function test_join_seatsWhoeverTheCallerNames() public {
        address friend = makeAddr("friend");
        vm.prank(player);
        router.join{value: STAKE + FEE}(MATCH, friend, _quote(STAKE));

        MockAcrossSpokePool.Deposit memory deposit = pool.getDeposit(0);
        assertEq(deposit.depositor, player);
        assertEq(deposit.message, abi.encode(MATCH, friend, uint32(421_614)));
    }

    /// @dev A contract's address here may be someone else's on the hub.
    function test_join_aContractMustNameItsHubRecipient() public {
        Wallet wallet = new Wallet();
        vm.deal(address(wallet), 1 ether);

        vm.expectRevert(abi.encodeWithSelector(SpokeRouter.HubRecipientRequired.selector, address(wallet)));
        wallet.join(router, MATCH, address(0), _quote(STAKE), STAKE + FEE);

        address owner = makeAddr("owner");
        wallet.join(router, MATCH, owner, _quote(STAKE), STAKE + FEE);
        assertEq(pool.getDeposit(0).message, abi.encode(MATCH, owner, uint32(421_614)));
    }

    /// @dev An EOA delegated under EIP-7702 has the same address everywhere.
    function test_join_aDelegatedEoaIsItself() public {
        vm.etch(player, abi.encodePacked(bytes3(0xef0100), makeAddr("delegate")));
        vm.prank(player);
        router.join{value: STAKE + FEE}(MATCH, address(0), _quote(STAKE));
        assertEq(pool.getDeposit(0).message, abi.encode(MATCH, player, uint32(421_614)));
    }

    function test_join_refusesAnEmptyOrOversizedOutput() public {
        vm.startPrank(player);
        vm.expectRevert(SpokeRouter.NothingToBridge.selector);
        router.join{value: STAKE}(MATCH, address(0), _quote(0));

        vm.expectRevert(abi.encodeWithSelector(SpokeRouter.OutputExceedsInput.selector, STAKE + 1, STAKE));
        router.join{value: STAKE}(MATCH, address(0), _quote(STAKE + 1));
        vm.stopPrank();
    }

    /// @dev The pool's own checks still apply, and its revert comes back whole.
    function test_join_aStaleQuoteRevertsInThePool() public {
        SpokeRouter.Quote memory quote = _quote(STAKE);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(player);
        vm.expectRevert(MockAcrossSpokePool.InvalidQuoteTimestamp.selector);
        router.join{value: STAKE + FEE}(MATCH, address(0), quote);
    }

    function test_constructor_refusesZeroAddresses() public {
        IAcrossSpokePool p = IAcrossSpokePool(address(pool));
        vm.expectRevert(ZeroAddress.selector);
        new SpokeRouter(IAcrossSpokePool(address(0)), address(weth), HUB_CHAIN, hubReceiver, hubWeth);
        vm.expectRevert(ZeroAddress.selector);
        new SpokeRouter(p, address(0), HUB_CHAIN, hubReceiver, hubWeth);
        vm.expectRevert(ZeroAddress.selector);
        new SpokeRouter(p, address(weth), HUB_CHAIN, address(0), hubWeth);
        vm.expectRevert(ZeroAddress.selector);
        new SpokeRouter(p, address(weth), HUB_CHAIN, hubReceiver, address(0));
    }
}

/// @dev A smart wallet: a contract caller.
contract Wallet {
    function join(
        SpokeRouter router,
        bytes32 matchId,
        address to,
        SpokeRouter.Quote memory quote,
        uint256 value
    ) external {
        router.join{value: value}(matchId, to, quote);
    }

    receive() external payable {}
}
