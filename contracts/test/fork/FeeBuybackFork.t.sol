// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {ProtocolConfig} from "../../src/ProtocolConfig.sol";
import {LmsToken} from "../../src/governance/LmsToken.sol";
import {StakedLms} from "../../src/governance/StakedLms.sol";
import {FeeRouter} from "../../src/governance/FeeRouter.sol";
import {ProtocolLiquidity} from "../../src/governance/ProtocolLiquidity.sol";
import {IPoolManager} from "../../src/interfaces/IPoolManager.sol";

/// @dev The whole fee path against the real Uniswap v4 `PoolManager` on a
///      mainnet fork: create and seed the LMS/ETH pool, settle a match, harvest
///      the fee, buy LMS into the vault, and take the liquidity back out. Proves
///      the `initialize`/`modifyLiquidity` mirror and the exact-input delta
///      conventions, which `MockPoolManager` only imitates.
///
///      Opt-in, like `ZapJoinFork`: `MAINNET_RPC_URL=… forge test --match-path test/fork/*`.
contract FeeBuybackForkTest is Fixtures {
    IPoolManager private constant POOL_MANAGER = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);

    LmsToken private lms;
    StakedLms private vault;
    ProtocolLiquidity private pol;
    FeeRouter private router;
    address private keeper;
    address private staker;

    function setUp() public override {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        super.setUp();
        keeper = makeAddr("keeper");
        staker = makeAddr("staker");

        lms = new LmsToken(address(this), 100_000_000e18);
        vault = new StakedLms(lms, owner, 7 days);
        pol = new ProtocolLiquidity(POOL_MANAGER, lms, owner, 3000, 60);
        router = new FeeRouter(
            POOL_MANAGER,
            escrow,
            lms,
            address(vault),
            owner,
            makeAddr("safe"),
            keeper,
            10_000,
            FeeRouter.PoolConfig({fee: 3000, tickSpacing: 60, hooks: address(0)})
        );

        lms.transfer(staker, 1_000e18);
        vm.startPrank(staker);
        lms.approve(address(vault), type(uint256).max);
        vault.deposit(1_000e18, staker);
        vm.stopPrank();

        ProtocolConfig.Params memory params = config.getParams();
        params.treasury = address(router);
        vm.prank(owner);
        config.setParams(params);

        vm.deal(address(this), 10 ether);
        lms.approve(address(pol), 1_000_000e18);
        pol.bootstrap{value: 10 ether}(1_000_000e18);
    }

    function test_fork_bootstrapThenBuybackIntoTheVault() public {
        assertGt(pol.liquidity(), 0);

        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(0x51)));
        address[] memory ranking = _rankingOf(matchId);
        bytes32 root = keccak256("history");
        escrow.settle(matchId, 7, root, ranking, _signResult(_twoAttestors(), matchId, 7, root, ranking));
        router.harvest();
        uint256 pending = router.pendingBuyback();
        assertEq(pending, 0.2 ether);

        uint256 assetsBefore = vault.totalAssets();
        vm.prank(keeper);
        // 100k LMS per ETH, less the 0.3% fee and a little price impact.
        uint256 lmsOut = router.buyback(pending, 19_000e18, block.timestamp);

        assertGt(lmsOut, 19_000e18);
        assertLt(lmsOut, 20_000e18);
        assertEq(vault.totalAssets(), assetsBefore + lmsOut);
        assertEq(router.pendingBuyback(), 0);
        assertEq(address(router).balance, 0);
    }

    function test_fork_governanceCanWithdrawTheLiquidity() public {
        address to = makeAddr("to");
        uint128 held = pol.liquidity();

        vm.prank(owner);
        (uint256 ethOut, uint256 lmsOut) = pol.removeLiquidity(held, to);

        assertApproxEqRel(ethOut, 10 ether, 1e15);
        assertApproxEqRel(lmsOut, 1_000_000e18, 1e15);
        assertEq(to.balance, ethOut);
        assertEq(lms.balanceOf(to), lmsOut);
        assertEq(pol.liquidity(), 0);
    }

    receive() external payable {}
}
