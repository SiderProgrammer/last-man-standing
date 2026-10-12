// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Fixtures} from "../helpers/Fixtures.sol";
import {ProtocolConfig} from "../../src/ProtocolConfig.sol";
import {NothingToWithdraw} from "../../src/Errors.sol";
import {LmsToken} from "../../src/governance/LmsToken.sol";
import {StakedLms} from "../../src/governance/StakedLms.sol";
import {FeeRouter} from "../../src/governance/FeeRouter.sol";
import {ProtocolLiquidity} from "../../src/governance/ProtocolLiquidity.sol";
import {PoolKey} from "../../src/interfaces/IPoolManager.sol";
import {MockPoolManager} from "../../src/mocks/MockPoolManager.sol";

contract FeeRouterTest is Fixtures {
    uint24 private constant FEE = 3000;
    int24 private constant SPACING = 60;
    /// @dev 1000 LMS per ETH.
    uint256 private constant RATE = 1000e18;
    /// @dev 5% of a four-seat, 1 ETH lobby.
    uint256 private constant MATCH_FEE = 0.2 ether;

    MockPoolManager private manager;
    LmsToken private lms;
    StakedLms private vault;
    FeeRouter private router;

    address private keeper;
    address private safe;
    address private staker;

    function setUp() public override {
        super.setUp();
        keeper = makeAddr("keeper");
        safe = makeAddr("safe");
        staker = makeAddr("staker");

        manager = new MockPoolManager();
        lms = new LmsToken(address(this), 1_000_000e18);
        vault = new StakedLms(lms, owner, 7 days);
        router = new FeeRouter(
            manager,
            escrow,
            lms,
            address(vault),
            owner,
            safe,
            keeper,
            5_000,
            FeeRouter.PoolConfig({fee: FEE, tickSpacing: SPACING, hooks: address(0)})
        );

        manager.setPool(_key(), RATE, 0);
        lms.transfer(address(manager), 500_000e18);

        lms.transfer(staker, 100e18);
        vm.startPrank(staker);
        lms.approve(address(vault), type(uint256).max);
        vault.deposit(100e18, staker);
        vm.stopPrank();

        ProtocolConfig.Params memory params = config.getParams();
        params.treasury = address(router);
        vm.prank(owner);
        config.setParams(params);
    }

    // --- harvest -------------------------------------------------------------

    function test_harvest_splitsBetweenStakersAndTreasury() public {
        _playOneMatch();
        assertEq(escrow.withdrawable(address(router)), MATCH_FEE);

        uint256 amount = router.harvest();

        assertEq(amount, MATCH_FEE);
        assertEq(router.pendingBuyback(), MATCH_FEE / 2);
        assertEq(address(router).balance, MATCH_FEE / 2, "only the stakers' half stays");
        assertEq(safe.balance, MATCH_FEE / 2);
        assertEq(escrow.withdrawable(address(router)), 0);
    }

    function test_harvest_allToStakers() public {
        vm.prank(owner);
        router.setStakerBps(10_000);
        _playOneMatch();

        router.harvest();

        assertEq(router.pendingBuyback(), MATCH_FEE);
        assertEq(safe.balance, 0);
    }

    function test_harvest_revertsWhenNothingCredited() public {
        vm.expectRevert(NothingToWithdraw.selector);
        router.harvest();
    }

    function test_receive_rejectsAnyoneButTheEscrow() public {
        vm.deal(address(this), 1 ether);
        (bool ok, bytes memory data) = address(router).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(data, abi.encodeWithSelector(FeeRouter.UnexpectedSender.selector, address(this)));
    }

    // --- buyback ---------------------------------------------------------------

    function test_buyback_sendsLmsToVault_raisingShareValue() public {
        _playOneMatch();
        router.harvest();
        uint256 valueBefore = vault.convertToAssets(vault.balanceOf(staker));

        vm.prank(keeper);
        uint256 lmsOut = router.buyback(0.1 ether, 100e18, block.timestamp);

        assertEq(lmsOut, 100e18);
        assertEq(router.pendingBuyback(), 0);
        assertEq(address(router).balance, 0);
        assertEq(vault.totalAssets(), 200e18);
        assertGt(vault.convertToAssets(vault.balanceOf(staker)), valueBefore);
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(staker)), 200e18, 1);
    }

    function test_buyback_partialAmountKeepsTheRestPending() public {
        _playOneMatch();
        router.harvest();

        vm.prank(keeper);
        router.buyback(0.04 ether, 0, block.timestamp);

        assertEq(router.pendingBuyback(), 0.06 ether);
        assertEq(address(router).balance, 0.06 ether);
    }

    function test_buyback_onlyKeeper() public {
        _playOneMatch();
        router.harvest();

        vm.expectRevert(abi.encodeWithSelector(FeeRouter.NotKeeper.selector, address(this)));
        router.buyback(0.1 ether, 0, block.timestamp);
    }

    function test_buyback_enforcesMinOut() public {
        _playOneMatch();
        router.harvest();

        vm.expectRevert(abi.encodeWithSelector(FeeRouter.SlippageExceeded.selector, 100e18, 100e18 + 1));
        vm.prank(keeper);
        router.buyback(0.1 ether, 100e18 + 1, block.timestamp);
    }

    function test_buyback_rejectsPartialFill() public {
        manager.setPool(_key(), RATE, 50e18);
        _playOneMatch();
        router.harvest();

        vm.expectRevert(abi.encodeWithSelector(FeeRouter.PartialFill.selector, 0.1 ether, 0.05 ether));
        vm.prank(keeper);
        router.buyback(0.1 ether, 0, block.timestamp);
    }

    function test_buyback_rejectsMoreThanPendingAndPastDeadline() public {
        _playOneMatch();
        router.harvest();

        vm.startPrank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(FeeRouter.InsufficientPending.selector, 0.1 ether + 1, 0.1 ether)
        );
        router.buyback(0.1 ether + 1, 0, block.timestamp);

        vm.expectRevert(abi.encodeWithSelector(FeeRouter.DeadlinePassed.selector, block.timestamp - 1));
        router.buyback(0.1 ether, 0, block.timestamp - 1);
        vm.stopPrank();
    }

    function test_unlockCallback_onlyPoolManager() public {
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.NotPoolManager.selector, address(this)));
        router.unlockCallback(abi.encode(uint256(1), uint256(0)));
    }

    // --- governance --------------------------------------------------------------

    function test_setters_ownerOnly() public {
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        router.setKeeper(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        router.setTreasury(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        router.setStakerBps(0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        router.setPool(FeeRouter.PoolConfig({fee: 500, tickSpacing: 10, hooks: address(0)}));
        vm.stopPrank();
    }

    function test_setStakerBps_bounded() public {
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.InvalidBps.selector, uint16(10_001)));
        vm.prank(owner);
        router.setStakerBps(10_001);
    }

    function test_setPool_switchesTheRoute() public {
        FeeRouter.PoolConfig memory other =
            FeeRouter.PoolConfig({fee: 500, tickSpacing: 10, hooks: address(0)});
        vm.prank(owner);
        router.setPool(other);
        manager.setPool(
            PoolKey({
                currency0: address(0), currency1: address(lms), fee: 500, tickSpacing: 10, hooks: address(0)
            }),
            2 * RATE,
            0
        );
        _playOneMatch();
        router.harvest();

        vm.prank(keeper);
        assertEq(router.buyback(0.1 ether, 0, block.timestamp), 200e18);
    }

    function test_buyback_throughAPoolCreatedByProtocolLiquidity() public {
        ProtocolLiquidity pol = new ProtocolLiquidity(manager, lms, owner, 10_000, 200);
        lms.approve(address(pol), 400_000e18);
        vm.deal(address(this), 4 ether);
        pol.bootstrap{value: 4 ether}(400_000e18);

        vm.prank(owner);
        router.setPool(FeeRouter.PoolConfig({fee: 10_000, tickSpacing: 200, hooks: address(0)}));
        _playOneMatch();
        router.harvest();

        vm.prank(keeper);
        uint256 lmsOut = router.buyback(0.1 ether, 9_999e18, block.timestamp);

        assertApproxEqRel(lmsOut, 10_000e18, 1e9, "100k LMS per ETH");
        assertEq(vault.totalAssets(), 100e18 + lmsOut);
    }

    // --- helpers -------------------------------------------------------------------

    function _playOneMatch() private {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(0x51)));
        address[] memory ranking = _rankingOf(matchId);
        bytes32 historyRoot = keccak256("history");
        escrow.settle(
            matchId, 7, historyRoot, ranking, _signResult(_twoAttestors(), matchId, 7, historyRoot, ranking)
        );
    }

    function _key() private view returns (PoolKey memory) {
        return PoolKey({
            currency0: address(0), currency1: address(lms), fee: FEE, tickSpacing: SPACING, hooks: address(0)
        });
    }
}
