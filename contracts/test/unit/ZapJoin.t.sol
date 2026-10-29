// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {ZapJoin} from "../../src/periphery/ZapJoin.sol";
import {PoolKey} from "../../src/interfaces/IPoolManager.sol";
import {MockPoolManager} from "../../src/mocks/MockPoolManager.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

contract ZapJoinTest is Fixtures {
    uint24 private constant FEE = 3000;
    int24 private constant SPACING = 60;
    address private constant ETH = address(0);

    MockPoolManager private manager;
    ZapJoin private zap;
    MockERC20 private usdc;
    MockERC20 private dai;

    bytes32 private matchId;
    address private player;

    event ZapJoined(
        bytes32 indexed matchId,
        address indexed player,
        address indexed tokenIn,
        uint256 amountIn,
        uint128 stake
    );
    event PlayerJoined(bytes32 indexed matchId, address indexed player, uint16 seat, uint32 originChainId);

    function setUp() public override {
        super.setUp();

        manager = new MockPoolManager();
        zap = new ZapJoin(manager, escrow);
        usdc = new MockERC20("USD Coin", "USDC");
        dai = new MockERC20("Dai", "DAI");

        // 2000 USDC per ETH. ETH is address(0), so always currency0.
        manager.setPool(_key(ETH, address(usdc)), 2000e18, 0);
        // 2 USDC per DAI, whichever way round the pair sorts.
        manager.setPool(_key(address(dai), address(usdc)), address(dai) < address(usdc) ? 2e18 : 0.5e18, 0);

        vm.deal(address(manager), 100 ether);
        usdc.mint(address(manager), 1_000_000e18);

        player = players[5];
        usdc.mint(player, 10_000e18);
        dai.mint(player, 10_000e18);
        vm.startPrank(player);
        usdc.approve(address(zap), type(uint256).max);
        dai.approve(address(zap), type(uint256).max);
        vm.stopPrank();

        vm.prank(players[0]);
        matchId = escrow.createMatch(STAKE, 4);
    }

    // --- Happy paths -------------------------------------------------------

    function test_singleHop_seatsCallerAndPaysExactCost() public {
        uint256 usdcBefore = usdc.balanceOf(player);
        uint256 ethBefore = player.balance;

        vm.expectEmit(address(escrow));
        emit PlayerJoined(matchId, player, 0, 0);
        vm.expectEmit(address(zap));
        emit ZapJoined(matchId, player, address(usdc), 2000e18, STAKE);

        vm.prank(player);
        uint256 amountIn = zap.joinWithToken(matchId, _usdcPath(), 2000e18, block.timestamp);

        assertEq(amountIn, 2000e18);
        assertEq(usdc.balanceOf(player), usdcBefore - 2000e18);
        assertEq(player.balance, ethBefore, "player spent no ETH");

        assertTrue(escrow.hasSeat(matchId, player));
        assertFalse(escrow.hasSeat(matchId, address(zap)));
        assertEq(escrow.seatOrigin(matchId, player), 0);
        assertEq(escrow.totalEscrowed(), STAKE);
        assertEq(address(escrow).balance, STAKE);

        _assertZapHoldsNothing();
    }

    function test_multiHop_routesThroughIntermediate() public {
        uint256 daiBefore = dai.balanceOf(player);
        uint256 usdcBefore = usdc.balanceOf(player);

        // DAI -> USDC -> ETH: 1 ETH costs 2000 USDC, which costs 1000 DAI.
        vm.prank(player);
        uint256 amountIn = zap.joinWithToken(matchId, _daiPath(), 1000e18, block.timestamp);

        assertEq(amountIn, 1000e18);
        assertEq(dai.balanceOf(player), daiBefore - 1000e18);
        assertEq(usdc.balanceOf(player), usdcBefore, "intermediate currency never touches the player");
        assertTrue(escrow.hasSeat(matchId, player));
        _assertZapHoldsNothing();
    }

    function test_seatedPlayerIsPaidOnCancel() public {
        vm.prank(player);
        zap.joinWithToken(matchId, _usdcPath(), 2000e18, block.timestamp);

        vm.warp(block.timestamp + 1 hours);
        escrow.cancelMatch(matchId);

        assertEq(escrow.withdrawable(player), STAKE, "refund goes to the player, in ETH");
        assertEq(escrow.withdrawable(address(zap)), 0);
    }

    function testFuzz_costIsQuotedRateAndNothingIsRetained(uint256 rate) public {
        rate = bound(rate, 1e15, 1e24);
        manager.setPool(_key(ETH, address(usdc)), rate, 0);
        uint256 expected = (uint256(STAKE) * rate - 1) / 1e18 + 1;
        usdc.mint(player, expected);

        vm.prank(player);
        uint256 amountIn = zap.joinWithToken(matchId, _usdcPath(), expected, block.timestamp);

        assertEq(amountIn, expected);
        assertEq(address(escrow).balance, escrow.totalEscrowed() + escrow.totalOwed());
        _assertZapHoldsNothing();
    }

    // --- Guards ------------------------------------------------------------

    function test_revertsAboveMaxAmountIn() public {
        vm.prank(player);
        vm.expectRevert(abi.encodeWithSelector(ZapJoin.SlippageExceeded.selector, 2000e18, 1999e18));
        zap.joinWithToken(matchId, _usdcPath(), 1999e18, block.timestamp);
    }

    function test_revertsAfterDeadline() public {
        uint256 deadline = block.timestamp;
        vm.warp(deadline + 1);
        vm.prank(player);
        vm.expectRevert(abi.encodeWithSelector(ZapJoin.DeadlinePassed.selector, deadline));
        zap.joinWithToken(matchId, _usdcPath(), 2000e18, deadline);
    }

    function test_revertsOnPartialFill() public {
        manager.setPool(_key(ETH, address(usdc)), 2000e18, STAKE / 2);
        vm.prank(player);
        vm.expectRevert(abi.encodeWithSelector(ZapJoin.PartialFill.selector, STAKE, STAKE / 2));
        zap.joinWithToken(matchId, _usdcPath(), type(uint256).max, block.timestamp);
    }

    function test_revertsOnUnknownPool() public {
        ZapJoin.PathKey[] memory path = _usdcPath();
        path[0].fee = 500;
        vm.prank(player);
        vm.expectRevert(MockPoolManager.PoolNotInitialized.selector);
        zap.joinWithToken(matchId, path, type(uint256).max, block.timestamp);
    }

    function test_revertsOnEmptyPathAndNativeInput() public {
        vm.startPrank(player);
        vm.expectRevert(ZapJoin.EmptyPath.selector);
        zap.joinWithToken(matchId, new ZapJoin.PathKey[](0), 0, block.timestamp);

        ZapJoin.PathKey[] memory path = _usdcPath();
        path[0].intermediateCurrency = ETH;
        vm.expectRevert(ZapJoin.NativeInput.selector);
        zap.joinWithToken(matchId, path, 0, block.timestamp);
        vm.stopPrank();
    }

    function test_revertsBeforeSwappingIntoAClosedLobby() public {
        bytes32 unknown = keccak256("nope");
        vm.prank(player);
        vm.expectRevert(abi.encodeWithSelector(ZapJoin.MatchNotOpen.selector, unknown));
        zap.joinWithToken(unknown, _usdcPath(), 2000e18, block.timestamp);

        vm.warp(block.timestamp + 1 hours);
        escrow.cancelMatch(matchId);
        vm.prank(player);
        vm.expectRevert(abi.encodeWithSelector(ZapJoin.MatchNotOpen.selector, matchId));
        zap.joinWithToken(matchId, _usdcPath(), 2000e18, block.timestamp);
    }

    function test_escrowRulesStillApply_andTheSwapUnwinds() public {
        vm.prank(player);
        escrow.join{value: STAKE}(matchId);
        uint256 usdcBefore = usdc.balanceOf(player);

        vm.prank(player);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.AlreadyJoined.selector, matchId, player));
        zap.joinWithToken(matchId, _usdcPath(), 2000e18, block.timestamp);

        assertEq(usdc.balanceOf(player), usdcBefore);
    }

    function test_revertsWhileEscrowPaused() public {
        vm.prank(owner);
        escrow.pause();
        vm.prank(player);
        vm.expectRevert(GameEscrow.Paused.selector);
        zap.joinWithToken(matchId, _usdcPath(), 2000e18, block.timestamp);
    }

    function test_revertsWithoutApproval() public {
        address stranger = makeAddr("stranger");
        usdc.mint(stranger, 10_000e18);
        vm.prank(stranger);
        // The amount in the error is the swap's exact input, which the mock pool prices.
        vm.expectPartialRevert(IERC20Errors.ERC20InsufficientAllowance.selector);
        zap.joinWithToken(matchId, _usdcPath(), 2000e18, block.timestamp);
    }

    function test_unlockCallback_rejectsAnyoneButTheManager() public {
        bytes memory data = abi.encode(player, STAKE, type(uint256).max, _usdcPath());
        vm.expectRevert(abi.encodeWithSelector(ZapJoin.NotPoolManager.selector, address(this)));
        zap.unlockCallback(data);
    }

    function test_rejectsStrayEth() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(zap).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // --- Helpers -----------------------------------------------------------

    function _assertZapHoldsNothing() private view {
        assertEq(address(zap).balance, 0);
        assertEq(usdc.balanceOf(address(zap)), 0);
        assertEq(dai.balanceOf(address(zap)), 0);
    }

    function _key(address a, address b) private pure returns (PoolKey memory) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return PoolKey({currency0: c0, currency1: c1, fee: FEE, tickSpacing: SPACING, hooks: address(0)});
    }

    function _hop(address currencyIn) private pure returns (ZapJoin.PathKey memory) {
        return ZapJoin.PathKey({
            intermediateCurrency: currencyIn, fee: FEE, tickSpacing: SPACING, hooks: address(0), hookData: ""
        });
    }

    function _usdcPath() private view returns (ZapJoin.PathKey[] memory path) {
        path = new ZapJoin.PathKey[](1);
        path[0] = _hop(address(usdc));
    }

    function _daiPath() private view returns (ZapJoin.PathKey[] memory path) {
        path = new ZapJoin.PathKey[](2);
        path[0] = _hop(address(dai));
        path[1] = _hop(address(usdc));
    }
}
