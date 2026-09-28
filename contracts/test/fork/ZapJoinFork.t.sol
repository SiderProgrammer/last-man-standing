// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Fixtures} from "../helpers/Fixtures.sol";
import {ZapJoin} from "../../src/periphery/ZapJoin.sol";
import {IPoolManager} from "../../src/interfaces/IPoolManager.sol";

/// @dev Runs `ZapJoin` against the real Uniswap v4 `PoolManager` on a mainnet
///      fork, which is the only thing that proves the local `IPoolManager`
///      mirror matches the deployed ABI and its delta conventions. The unit
///      suite runs against `MockPoolManager` and cannot.
///
///      Opt-in, because it needs an RPC: `MAINNET_RPC_URL=… forge test --match-path test/fork/*`.
///      Skipped otherwise.
contract ZapJoinForkTest is Fixtures {
    IPoolManager private constant POOL_MANAGER = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
    address private constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    ZapJoin private zap;
    address private player;

    function setUp() public override {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        super.setUp();

        zap = new ZapJoin(POOL_MANAGER, escrow);
        player = players[5];
        deal(USDC, player, 1_000_000e6);
        vm.prank(player);
        IERC20(USDC).approve(address(zap), type(uint256).max);
    }

    function test_fork_joinsWithUsdcThroughTheEthUsdcPool() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);

        ZapJoin.PathKey[] memory path = new ZapJoin.PathKey[](1);
        path[0] = ZapJoin.PathKey({
            intermediateCurrency: USDC, fee: 500, tickSpacing: 10, hooks: address(0), hookData: ""
        });

        uint256 before = IERC20(USDC).balanceOf(player);
        vm.prank(player);
        uint256 amountIn = zap.joinWithToken(matchId, path, 1_000_000e6, block.timestamp);

        assertGt(amountIn, 0);
        assertEq(IERC20(USDC).balanceOf(player), before - amountIn);
        assertTrue(escrow.hasSeat(matchId, player));
        assertEq(address(escrow).balance, STAKE);
        assertEq(address(zap).balance, 0);
        assertEq(IERC20(USDC).balanceOf(address(zap)), 0);
    }

    function test_fork_slippageBoundHolds() public {
        vm.prank(players[0]);
        bytes32 matchId = escrow.createMatch(STAKE, 4);

        ZapJoin.PathKey[] memory path = new ZapJoin.PathKey[](1);
        path[0] = ZapJoin.PathKey({
            intermediateCurrency: USDC, fee: 500, tickSpacing: 10, hooks: address(0), hookData: ""
        });

        // One USDC does not buy one ETH.
        vm.prank(player);
        vm.expectPartialRevert(ZapJoin.SlippageExceeded.selector);
        zap.joinWithToken(matchId, path, 1e6, block.timestamp);
    }
}
