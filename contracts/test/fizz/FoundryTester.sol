// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {Handlers} from "./handlers/Handlers.sol";

/// @notice Contract to be used for quick testing with Foundry
contract FoundryTester is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    function setUp() public {
        setup();
    }

    // forge test --match-test test_sequence -vvv
    function test_sequence() public {
        // Add here call sequence to Handler's functions to reproduce failing property
    }

    /// @dev Proves the harness wiring: every lifecycle reached through the
    ///      clamped handlers, with assertions on what each was meant to do.
    function test_harness_matchLifecycle() public {
        // Into the program's first epoch: fees before it earn no play-mining.
        vm.warp(rewards.firstEpoch() * rewards.epochLength());
        escrow_openMatchmadeAndFill_clamped(0.1 ether, 8, type(uint256).max, 0x020100, 1e18);
        bytes32 matchId = matchIds[0];
        assertEq(escrow.getMatch(matchId).seatCount, 8, "lobby filled");

        escrow_lockAndSeed_clamped(0, 0, 7);
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Live), "seeded");

        escrow_settle_clamped(0, 0, 1, 3);
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Proposed), "proposed");

        escrow_dispute_clamped(0, 0, keccak256("evidence"));
        escrow_secondary(1, 0, 0, true);
        assertFalse(escrow.getMatch(matchId).disputed, "dismissed");

        vm.warp(escrow.getMatch(matchId).deadline);
        escrow_finalize_clamped(0, 0);
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Settled), "settled");

        feeRouter_harvest_clamped(0);
        assertEq(escrow.withdrawable(address(feeRouter)), 0, "harvested");
        escrow_withdraw_clamped(0, 0);

        vm.warp(block.timestamp + 8 days);
        stakedLms_claimRewards_clamped(0, 0);
        rewards_claim_clamped(0, 0);
        assertGt(vesting.totalGranted(), 0, "play-mining granted");
        vm.warp(block.timestamp + 30 days);
        vesting_release_clamped(0, 0);
        assertGt(vesting.totalReleased(), 0, "vesting released");
    }

    function test_harness_exitsAndRefunds() public {
        escrow_openAndFill_clamped(0.1 ether, 4, 0, 0, 0);
        escrow_lockMatch_clamped(0, 0);
        vm.warp(block.timestamp + 1 hours);
        escrow_cancelMatch_clamped(0, 0);
        assertEq(
            uint8(escrow.getMatch(matchIds[0]).status), uint8(GameEscrow.MatchStatus.Cancelled), "cancelled"
        );

        // Answered after its match was cancelled: the word stays for `deliver`.
        vrf_fulfill_clamped(0, 7);
        (, bool answered,,) = vrf.requests(vrfRequestIds[0]);
        assertTrue(answered, "word stored");
        vrf_deliver_clamped(0, 0);

        escrow_openAndFill_clamped(0.1 ether, 4, 0, 0x020202, 1e18);
        escrow_lockAndSeed_clamped(0, 1, 7);
        escrow_abortMatch_clamped(0, 1);
        assertEq(
            uint8(escrow.getMatch(matchIds[1]).status), uint8(GameEscrow.MatchStatus.Cancelled), "aborted"
        );

        escrow_openAndFill_clamped(0.1 ether, 4, 0, 0, 0);
        escrow_lockAndSeed_clamped(0, 2, 7);
        escrow_settle_clamped(0, 2, 1, 3);
        escrow_secondary(0, 2, 0, true);
        assertEq(
            uint8(escrow.getMatch(matchIds[2]).status), uint8(GameEscrow.MatchStatus.Cancelled), "vetoed"
        );
    }

    function test_harness_periphery() public {
        escrow_createMatch_clamped(0, 0.1 ether, 8);

        bridge_fillJoin_clamped(0, 3, 0, 0);
        bridge_fillJoin_clamped(0, 4, 1 ether, 1);
        bridge_fillJoin_clamped(0, 5, 0.01 ether, 2);
        assertEq(escrow.getMatch(matchIds[0]).seatCount, 2, "exact and over seat, under credits");
        assertGt(escrow.withdrawable(signerActors[2]), 0, "under-paying fill credited");

        bridge_fillUnroutable_clamped(1 ether, hex"ff", 0);
        assertEq(address(bridgeReceiver).balance, 1 ether, "junk message held as ETH");
        bridge_fillUnroutable_clamped(1 ether, "", 2);
        assertEq(zapToken.balanceOf(address(bridgeReceiver)), 1 ether, "other token held");
        bridge_secondary(0, 1 ether, 0);
        bridge_secondary(1, 1 ether, 0);

        uint256 owed = escrow.withdrawable(signerActors[2]);
        bridge_withdrawToChainFor_clamped(2, 0, 0, 0);
        assertEq(escrow.withdrawable(signerActors[2]), 0, "bridged out");
        assertEq(weth.balanceOf(address(acrossPool)), owed, "deposited with Across");

        zap_joinWithToken_clamped(0, 0, 0, 0, false);
        zap_joinWithToken_clamped(1, 0, 0, 2, false);
        assertEq(escrow.getMatch(matchIds[0]).seatCount, 4, "zapped in");

        session_grantSession_clamped(0, 0, 1 days, 1 ether, 2 ether);
        session_execute_clamped(0, 0, 0, 0, 0);
        assertTrue(escrow.hasSeat(matchIds[0], address(sessionAccounts[0])), "session joined");
        assertEq(sessionAccounts[0].sessionNonce(), 1, "nonce advanced");
    }

    function test_harness_governance() public {
        // First, while a call scheduled now can still be ready before the phase ends.
        multisig_secondary(0, 2_222, 0);
        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        multisig_secondary(3, 0, 0);
        assertEq(feeRouter.stakerBps(), 2_222, "safe's operation executed");

        for (uint256 i = 0; i < actors.length; ++i) {
            stakedLms_deposit_clamped(i, 500_000e18);
        }
        vm.warp(block.timestamp + 1);
        governor_secondary(0, 0, 1_234, 0);
        assertEq(proposals.length, 1, "proposed");

        vm.warp(block.timestamp + VOTING_DELAY + 1);
        for (uint256 i = 0; i < actors.length; ++i) {
            governor_secondary(1, i, 0, 1);
        }
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        governor_secondary(2, 0, 0, 0);
        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        governor_secondary(3, 0, 0, 0);
        assertEq(feeRouter.stakerBps(), 1_234, "proposal executed");

        vm.warp(block.timestamp + MULTISIG_PHASE);
        multisig_secondary(4, 0, 0);
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), address(phase)), "retired");
    }

    function test_harness_staking() public {
        stakedLms_depositRewards_clamped(0, 10 ether);
        vm.warp(block.timestamp + 1 days);
        stakedLms_claimRewards_clamped(0, 0);
        stakedLms_requestUnstake_full_clamped(0);
        vm.warp(block.timestamp + STAKE_COOLDOWN);
        stakedLms_claim_clamped(0, 0);
        (uint128 assets,) = stakedLms.unstakeOf(actors[0]);
        assertEq(assets, 0, "unstake claimed");

        stakedLms_donateLms(0, 1e18);
        stakedLms_secondary(1, 0, 0);
        assertEq(
            lms.balanceOf(address(stakedLms)),
            stakedLms.totalSupply() + stakedLms.totalUnstaking(),
            "stray swept"
        );
    }

    function test_harness_streamPausesWithNoStakers() public {
        stakedLms_depositRewards_clamped(0, 10 ether);
        stakedLms_unstakeEveryone_clamped();
        assertEq(stakedLms.totalSupply(), 0, "nothing staked");
        uint64 finish = stakedLms.periodFinish();

        vm.warp(block.timestamp + 1 days);
        stakedLms_deposit_clamped(0, 1e18);
        assertEq(stakedLms.periodFinish(), finish + 1 days, "stream paused");
    }

    function test_harness_governorAdvances() public {
        vm.warp(block.timestamp + 1);
        governor_advance_clamped(0, 1_234, 0);
        assertEq(proposals.length, 1, "proposed");
        vm.warp(block.timestamp + VOTING_DELAY + 1);
        governor_advance_clamped(0, 0, 0);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        governor_advance_clamped(0, 0, 0);
        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        governor_advance_clamped(0, 0, 0);
        assertEq(feeRouter.stakerBps(), 1_234, "executed");
    }

    function test_harness_seatRefusals() public {
        escrow_openAndFill_clamped(0.1 ether, 8, 0, 0, 0);
        vm.expectRevert();
        this.escrow_join_alreadySeated_clamped(0, 0);
    }

    // ── Violation Repros (auto-generated by Step 11) ──────────────────
    // Each test_repro_* function below replays a shrunk fuzzer call
    // sequence that violated a property. Run all with:
    //   forge test --match-contract FoundryTester -vvv
}
