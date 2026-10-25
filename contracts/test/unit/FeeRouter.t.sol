// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Fixtures} from "../helpers/Fixtures.sol";
import {ProtocolConfig} from "../../src/ProtocolConfig.sol";
import {NothingToWithdraw, TransferFailed} from "../../src/Errors.sol";
import {LmsToken} from "../../src/governance/LmsToken.sol";
import {StakedLms} from "../../src/governance/StakedLms.sol";
import {FeeRouter} from "../../src/governance/FeeRouter.sol";

contract RejectsEth {
    receive() external payable {
        revert("no");
    }
}

contract FeeRouterTest is Fixtures {
    /// @dev 5% of a four-seat, 1 ETH lobby.
    uint256 private constant MATCH_FEE = 0.2 ether;

    LmsToken private lms;
    StakedLms private vault;
    FeeRouter private router;

    address private safe;
    address private staker;

    function setUp() public override {
        super.setUp();
        safe = makeAddr("safe");
        staker = makeAddr("staker");

        lms = new LmsToken(address(this), 1_000_000e18);
        vault = new StakedLms(lms, owner, 7 days, 7 days);
        router = new FeeRouter(escrow, vault, owner, safe, 5_000);

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

    function test_harvest_paysStakersAndTreasury() public {
        _playOneMatch();
        assertEq(escrow.withdrawable(address(router)), MATCH_FEE);

        uint256 amount = router.harvest();

        assertEq(amount, MATCH_FEE);
        assertEq(address(vault).balance, MATCH_FEE / 2);
        assertEq(safe.balance, MATCH_FEE / 2);
        assertEq(address(router).balance, 0, "holds nothing between transactions");
        assertEq(escrow.withdrawable(address(router)), 0);
    }

    function test_harvest_thenTheStakerClaimsTheirShareInEth() public {
        _playOneMatch();
        router.harvest();
        vm.warp(block.timestamp + vault.rewardDuration());

        vm.prank(staker);
        uint256 paid = vault.claimRewards(staker);

        assertApproxEqAbs(paid, MATCH_FEE / 2, 10);
        assertEq(staker.balance, paid);
    }

    function test_harvest_allOrNothingToStakers() public {
        vm.prank(owner);
        router.setStakerBps(10_000);
        _playOneMatch();
        router.harvest();
        assertEq(address(vault).balance, MATCH_FEE);
        assertEq(safe.balance, 0);

        vm.prank(owner);
        router.setStakerBps(0);
        _playOneMatch();
        router.harvest();
        assertEq(address(vault).balance, MATCH_FEE, "unchanged");
        assertEq(safe.balance, MATCH_FEE);
    }

    function test_harvest_isOpenToAnyone() public {
        _playOneMatch();
        vm.prank(makeAddr("anyone"));
        assertEq(router.harvest(), MATCH_FEE);
    }

    function test_harvest_revertsWhenNothingCredited() public {
        vm.expectRevert(NothingToWithdraw.selector);
        router.harvest();
    }

    function test_harvest_revertsWhenTheTreasuryRefusesEth() public {
        address refuses = address(new RejectsEth());
        vm.prank(owner);
        router.setTreasury(refuses);
        _playOneMatch();

        vm.expectRevert(abi.encodeWithSelector(TransferFailed.selector, refuses, MATCH_FEE / 2));
        router.harvest();
    }

    function test_receive_rejectsAnyoneButTheEscrow() public {
        vm.deal(address(this), 1 ether);
        (bool ok, bytes memory data) = address(router).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(data, abi.encodeWithSelector(FeeRouter.UnexpectedSender.selector, address(this)));
    }

    function test_setters_ownerOnlyAndBounded() public {
        vm.startPrank(staker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, staker));
        router.setTreasury(staker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, staker));
        router.setStakerBps(0);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(FeeRouter.InvalidBps.selector, uint16(10_001)));
        vm.prank(owner);
        router.setStakerBps(10_001);
    }

    /// @dev Settlement now proposes and pays only after the challenge window,
    ///      so a match's fee reaches the router on `finalize`, not on `settle`.
    function _playOneMatch() private {
        bytes32 matchId = _createAndFill(4);
        _lockAndSeed(matchId, bytes32(uint256(0x51)));
        _settleAndFinalize(matchId);
    }
}
