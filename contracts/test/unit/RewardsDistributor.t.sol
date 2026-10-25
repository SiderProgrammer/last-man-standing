// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Fixtures} from "../helpers/Fixtures.sol";
import {ProtocolConfig} from "../../src/ProtocolConfig.sol";
import {LmsToken} from "../../src/governance/LmsToken.sol";
import {StakedLms} from "../../src/governance/StakedLms.sol";
import {RewardsDistributor} from "../../src/governance/RewardsDistributor.sol";

contract RewardsDistributorTest is Fixtures {
    uint256 private constant EPOCH = 7 days;
    /// @dev 1,000 LMS per first-year epoch: 52 × 1,000 × 175/64 over the four years.
    uint256 private constant FIRST_YEAR_BUDGET = 1_000e18;
    uint256 private constant TOTAL_BUDGET = 142_187.5e18;
    /// @dev High enough never to bind unless a test lowers it.
    uint256 private constant NO_CAP = 1e40;
    /// @dev 5% of the fixtures' 1 ETH stake.
    uint256 private constant SEAT_FEE = 0.05 ether;

    LmsToken private lms;
    StakedLms private vault;
    RewardsDistributor private rewards;

    function setUp() public override {
        super.setUp();
        lms = new LmsToken(address(this), 1_000_000e18);
        vault = new StakedLms(lms, owner, 7 days, 7 days);
        rewards = new RewardsDistributor(escrow, vault, owner, 0, TOTAL_BUDGET, NO_CAP);
        lms.transfer(address(rewards), TOTAL_BUDGET);
    }

    // --- Budget ------------------------------------------------------------

    function test_budget_dropsByAQuarterEachYear_andEndsAfterFour() public view {
        assertEq(rewards.firstYearEpochBudget(), FIRST_YEAR_BUDGET);
        assertEq(rewards.epochBudget(0), 1_000e18);
        assertEq(rewards.epochBudget(51), 1_000e18);
        assertEq(rewards.epochBudget(52), 750e18);
        assertEq(rewards.epochBudget(104), 562.5e18);
        assertEq(rewards.epochBudget(156), 421.875e18);
        assertEq(rewards.epochBudget(208), 0);
        assertEq(rewards.totalBudget(), TOTAL_BUDGET);
    }

    function test_budget_isZeroBeforeTheProgramStarts() public {
        RewardsDistributor later = new RewardsDistributor(escrow, vault, owner, 10, TOTAL_BUDGET, NO_CAP);
        assertEq(later.epochBudget(9), 0);
        assertEq(later.epochBudget(10), FIRST_YEAR_BUDGET);
    }

    // --- Claims ------------------------------------------------------------

    /// @dev Two matches: players 0–3, then 0 and 4–6. Player 0 paid two of the
    ///      epoch's eight seat fees, so takes a quarter of its budget.
    function test_claim_splitsTheBudgetByFeesPaid_andPaysItStaked() public {
        _playTwoMatches();
        vm.warp(rewards.claimableFrom(0));

        assertEq(_claim(players[0]), 250e18);
        assertEq(_claim(players[1]), 125e18);
        assertEq(vault.balanceOf(players[0]), 250e18, "paid as sLMS");
        assertEq(lms.balanceOf(players[0]), 0, "never as LMS");
        assertEq(vault.getVotes(players[0]), 250e18, "and it votes straight away");
    }

    function test_claim_everyoneTogetherGetsExactlyTheBudget() public {
        _playTwoMatches();
        vm.warp(rewards.claimableFrom(0));

        uint256 total;
        for (uint256 i = 0; i < 7; ++i) {
            total += _claim(players[i]);
        }
        assertEq(total, FIRST_YEAR_BUDGET);
    }

    function test_claim_theCapLimitsAQuietEpoch_andTheRestStays() public {
        vm.prank(owner);
        rewards.setMaxRewardPerEth(1_000e18);
        _playTwoMatches();
        vm.warp(rewards.claimableFrom(0));

        assertEq(_claim(players[0]), 100e18, "0.1 ETH of fees at 1,000 LMS per ETH");
        assertEq(lms.balanceOf(address(rewards)), TOTAL_BUDGET - 100e18);
    }

    function test_claim_notBeforeTheEpochEnds() public {
        _playTwoMatches();
        uint256[] memory epochs = _epochs(0);

        vm.warp(EPOCH - 1);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.EpochNotClaimable.selector, 0));
        rewards.claim(players[0], epochs);

        vm.warp(EPOCH);
        rewards.claim(players[0], epochs);
    }

    function test_claim_onlyOncePerEpoch() public {
        _playTwoMatches();
        vm.warp(rewards.claimableFrom(0));
        _claim(players[0]);

        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.AlreadyClaimed.selector, 0));
        rewards.claim(players[0], _epochs(0));
    }

    function test_claim_nothingForAPlayerWhoPaidNothing() public {
        _playTwoMatches();
        vm.warp(rewards.claimableFrom(0));

        vm.expectRevert(RewardsDistributor.NothingToClaim.selector);
        rewards.claim(players[7], _epochs(0));
    }

    function test_claim_byAnyone_alwaysPaysThePlayer() public {
        _playTwoMatches();
        vm.warp(rewards.claimableFrom(0));
        address stranger = makeAddr("stranger");

        vm.prank(stranger);
        rewards.claim(players[1], _epochs(0));

        assertEq(vault.balanceOf(players[1]), 125e18);
        assertEq(vault.balanceOf(stranger), 0);
    }

    function test_claim_manyEpochsAtOnce() public {
        _playTwoMatches();
        vm.warp(EPOCH);
        _playTwoMatches();
        vm.warp(rewards.claimableFrom(1));

        uint256[] memory epochs = new uint256[](2);
        epochs[0] = 0;
        epochs[1] = 1;
        assertEq(rewards.claim(players[0], epochs), 500e18);
        assertTrue(rewards.isClaimed(players[0], 0) && rewards.isClaimed(players[0], 1));
    }

    /// @dev The exploit counting fees at join allowed: sit in a lobby that can
    ///      never fill past the week's end, claim on the fee, cancel for a
    ///      full refund. Unsettled seats count for nothing.
    function test_claim_aLobbyThatNeverPlaysEarnsNothing() public {
        _playTwoMatches();
        vm.prank(players[7]);
        bytes32 unfillable = escrow.createMatch(STAKE, 8);
        vm.prank(players[7]);
        escrow.join{value: STAKE}(unfillable);

        vm.warp(rewards.claimableFrom(0));
        vm.expectRevert(RewardsDistributor.NothingToClaim.selector);
        rewards.claim(players[7], _epochs(0));

        escrow.cancelMatch(unfillable);
        assertEq(escrow.withdrawable(players[7]), STAKE, "and the stake comes back in full");
    }

    /// @dev A match still in play when its week ends counts in the week it
    ///      settles: the ended week's totals, and so its claims, never move.
    function test_claim_aMatchSettlingAfterTheWeekEndsCountsInTheNext() public {
        bytes32 early = _createAndFill(4);
        _lockAndSeed(early, bytes32(uint256(1)));
        _settleAndFinalize(early);
        bytes32 late = _createAndFill(4);
        _lockAndSeed(late, bytes32(uint256(2)));

        vm.warp(rewards.claimableFrom(0));
        assertEq(_claim(players[0]), FIRST_YEAR_BUDGET / 4, "a quarter of week 0: one of four seat fees");

        _settleAndFinalize(late);
        assertEq(escrow.epochFees(0), 4 * SEAT_FEE, "week 0 did not move");
        assertEq(escrow.feesPaid(players[0], 1), SEAT_FEE, "the late match is week 1's");

        uint256 total = FIRST_YEAR_BUDGET / 4;
        for (uint256 i = 1; i < 4; ++i) {
            total += _claim(players[i]);
        }
        assertEq(total, FIRST_YEAR_BUDGET, "week 0 pays its budget, no more");
    }

    function test_claimable_showsWhatAndWhere() public {
        _playTwoMatches();
        vm.warp(EPOCH);
        _playTwoMatches();

        (uint256 total, uint256[] memory epochs) = rewards.claimable(players[0], 0, 5);
        assertEq(total, 250e18, "week 0 has ended; week 1 has not");
        assertEq(epochs.length, 1);
        assertEq(epochs[0], 0);

        vm.warp(rewards.claimableFrom(1));
        (total, epochs) = rewards.claimable(players[0], 0, 5);
        assertEq(total, 500e18);
        assertEq(epochs.length, 2);
        assertEq(epochs[0], 0);
        assertEq(epochs[1], 1);

        rewards.claim(players[0], epochs);
        (total, epochs) = rewards.claimable(players[0], 0, 5);
        assertEq(total, 0);
        assertEq(epochs.length, 0);
    }

    // --- Governance --------------------------------------------------------

    function test_setMaxRewardPerEth_ownerOnly_andLeavesFixedRatesAlone() public {
        _playTwoMatches();
        vm.warp(rewards.claimableFrom(0));
        _claim(players[0]);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, players[0]));
        vm.prank(players[0]);
        rewards.setMaxRewardPerEth(1);

        vm.prank(owner);
        rewards.setMaxRewardPerEth(1);
        assertEq(_claim(players[1]), 125e18);
    }

    function test_sweep_onlyOnceClaimsHaveClosed() public {
        address to = makeAddr("to");
        uint256 closesAt = rewards.claimsCloseAt();
        assertEq(closesAt, 208 * EPOCH + 365 days);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.ClaimsStillOpen.selector, closesAt));
        rewards.sweep(to);

        vm.warp(closesAt);
        vm.expectRevert(RewardsDistributor.ClaimsClosed.selector);
        rewards.claim(players[0], _epochs(0));

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, to));
        vm.prank(to);
        rewards.sweep(to);

        vm.prank(owner);
        assertEq(rewards.sweep(to), TOTAL_BUDGET);
        assertEq(lms.balanceOf(to), TOTAL_BUDGET);
    }

    // --- Properties --------------------------------------------------------

    /// @dev However the fees fall, an epoch never pays more than its budget.
    /// forge-config: default.fuzz.runs = 128
    function testFuzz_anEpochNeverPaysMoreThanItsBudget(uint8 matches, uint256 seed, uint96 cap) public {
        matches = uint8(bound(matches, 1, 12));
        vm.prank(owner);
        rewards.setMaxRewardPerEth(bound(cap, 1, NO_CAP));

        for (uint256 m = 0; m < matches; ++m) {
            uint16 seats = uint16(4 + (uint256(keccak256(abi.encode(seed, m))) % 5));
            vm.prank(players[0]);
            bytes32 matchId = escrow.createMatch(STAKE, seats);
            for (uint16 s = 0; s < seats; ++s) {
                // A rotating window of players, so their shares differ.
                address player = players[(m + s) % 8];
                vm.prank(player);
                escrow.join{value: STAKE}(matchId);
            }
            _lockAndSeed(matchId, bytes32(m));
            _settleAndFinalize(matchId);
        }

        vm.warp(rewards.claimableFrom(0));
        uint256 total;
        for (uint256 i = 0; i < 8; ++i) {
            if (escrow.feesPaid(players[i], 0) == 0) continue;
            (uint256 owed,) = rewards.claimable(players[i], 0, 0);
            if (owed == 0) continue;
            total += _claim(players[i]);
        }
        assertLe(total, FIRST_YEAR_BUDGET);
    }

    // --- Helpers -----------------------------------------------------------

    /// @dev Plays and settles two matches: players 0–3, then 0 and 4–6.
    function _playTwoMatches() private {
        bytes32 first = _createAndFill(4);
        _lockAndSeed(first, bytes32(uint256(1)));
        _settleAndFinalize(first);

        vm.prank(players[0]);
        bytes32 second = escrow.createMatch(STAKE, 4);
        vm.prank(players[0]);
        escrow.join{value: STAKE}(second);
        for (uint256 i = 4; i < 7; ++i) {
            vm.prank(players[i]);
            escrow.join{value: STAKE}(second);
        }
        _lockAndSeed(second, bytes32(uint256(2)));
        _settleAndFinalize(second);
    }

    function _claim(address player) private returns (uint256) {
        return rewards.claim(player, _epochs(0));
    }

    function _epochs(uint256 epoch) private pure returns (uint256[] memory epochs) {
        epochs = new uint256[](1);
        epochs[0] = epoch;
    }
}
