// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Fixtures} from "../helpers/Fixtures.sol";
import {ProtocolConfig} from "../../src/ProtocolConfig.sol";
import {LmsToken} from "../../src/governance/LmsToken.sol";
import {StakedLms} from "../../src/governance/StakedLms.sol";
import {RewardsDistributor} from "../../src/governance/RewardsDistributor.sol";
import {RewardVesting} from "../../src/governance/RewardVesting.sol";

contract RewardsDistributorTest is Fixtures {
    uint256 private constant EPOCH = 7 days;
    /// @dev 1,000 LMS per first-year epoch: 52 × 1,000 × 175/64 over the four years.
    uint256 private constant FIRST_YEAR_BUDGET = 1_000e18;
    uint256 private constant TOTAL_BUDGET = 142_187.5e18;
    /// @dev High enough never to bind unless a test lowers it.
    uint256 private constant NO_CAP = type(uint120).max;
    uint256 private constant NO_WALLET_CAP = type(uint128).max;
    uint256 private constant VESTING = 26 weeks;
    /// @dev 5% of the fixtures' 1 ETH stake.
    uint256 private constant SEAT_FEE = 0.05 ether;

    LmsToken private lms;
    StakedLms private vault;
    RewardsDistributor private rewards;
    RewardVesting private vesting;

    function setUp() public override {
        super.setUp();
        lms = new LmsToken(address(this), 1_000_000e18);
        vault = new StakedLms(lms, owner, 7 days, 7 days);
        rewards = new RewardsDistributor(escrow, lms, owner, 0, TOTAL_BUDGET, NO_CAP, NO_WALLET_CAP);
        vesting = rewards.vesting();
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
        RewardsDistributor later =
            new RewardsDistributor(escrow, lms, owner, 10, TOTAL_BUDGET, NO_CAP, NO_WALLET_CAP);
        assertEq(later.epochBudget(9), 0);
        assertEq(later.epochBudget(10), FIRST_YEAR_BUDGET);
    }

    // --- Claims ------------------------------------------------------------

    /// @dev Two matches: players 0–3, then 0 and 4–6. Player 0 paid two of the
    ///      epoch's eight seat fees, so takes a quarter of its budget.
    function test_claim_splitsTheBudgetByFeesPaid_andVestsIt() public {
        _playTwoMatches();
        vm.warp(rewards.claimableFrom(0));

        assertEq(_claim(players[0]), 250e18);
        assertEq(_claim(players[1]), 125e18);
        (uint128 amount, uint128 released) = vesting.trancheOf(players[0], 0);
        assertEq(amount, 250e18, "one tranche for the epoch");
        assertEq(released, 0);
        assertEq(lms.balanceOf(address(vesting)), 375e18, "held while it vests");
        assertEq(lms.balanceOf(players[0]), 0, "nothing liquid yet");
        assertEq(vault.getVotes(players[0]), 0, "and no votes");
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

        (uint128 amount,) = vesting.trancheOf(players[1], 0);
        assertEq(amount, 125e18);
        (amount,) = vesting.trancheOf(stranger, 0);
        assertEq(amount, 0);
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
        address[] memory roster = new address[](1);
        roster[0] = players[7];
        bytes32 unfillable = _createMatchmade(8, roster);
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
        bytes32 early = _createMatchmadeAndFill(4);
        _lockAndSeed(early, bytes32(uint256(1)));
        _settleAndFinalize(early);
        bytes32 late = _createMatchmadeAndFill(4);
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

    /// @dev Player 0 paid 0.1 ETH of week 0's fees: a quarter of its budget,
    ///      250 LMS, unless one wallet may earn less.
    function test_claim_theWalletCapLimitsOneWallet_andTheRestStays() public {
        vm.prank(owner);
        rewards.setMaxRewardPerWalletPerEpoch(200e18);
        _playTwoMatches();
        vm.warp(rewards.claimableFrom(0));

        assertEq(_claim(players[0]), 200e18, "capped");
        assertEq(_claim(players[1]), 125e18, "under the cap: untouched");
        assertEq(lms.balanceOf(address(rewards)), TOTAL_BUDGET - 325e18);
    }

    /// @dev Like the rate: fixed by the first claim of the epoch.
    function test_theWalletCapIsFixedByTheEpochsFirstClaim() public {
        vm.prank(owner);
        rewards.setMaxRewardPerWalletPerEpoch(200e18);
        _playTwoMatches();
        vm.warp(rewards.claimableFrom(0));
        _claim(players[1]);

        vm.prank(owner);
        rewards.setMaxRewardPerWalletPerEpoch(NO_WALLET_CAP);
        (, uint256 walletCap, bool fixed_) = rewards.rateOf(0);
        assertTrue(fixed_);
        assertEq(walletCap, 200e18);
        assertEq(_claim(players[0]), 200e18, "the cap the epoch was fixed with");
    }

    // --- Vesting -----------------------------------------------------------

    /// @dev From the moment the epoch ended, not the moment it was claimed.
    function test_vesting_isLinearOverSixMonthsFromTheEpochsEnd() public {
        _playTwoMatches();
        uint256 start = rewards.claimableFrom(0);
        vm.warp(start);
        _claim(players[0]);
        assertEq(vesting.vestingStart(0), start);
        assertEq(vesting.releasable(players[0], 0), 0);

        vm.warp(start + VESTING / 4);
        assertEq(vesting.release(players[0], _epochs(0)), 62.5e18);
        assertEq(lms.balanceOf(players[0]), 62.5e18, "liquid LMS");

        vm.warp(start + VESTING);
        assertEq(vesting.release(players[0], _epochs(0)), 187.5e18);
        assertEq(lms.balanceOf(players[0]), 250e18);

        vm.warp(start + 2 * VESTING);
        vm.expectRevert(RewardVesting.NothingToRelease.selector);
        vesting.release(players[0], _epochs(0));
    }

    function test_vesting_aLateClaimHasAlreadyVested() public {
        _playTwoMatches();
        vm.warp(rewards.claimableFrom(0) + VESTING);
        _claim(players[0]);
        assertEq(vesting.releasable(players[0], 0), 250e18);
    }

    /// @dev Only once released and staked by the player does a reward vote.
    function test_vesting_nothingVotesUntilReleasedAndStaked() public {
        _playTwoMatches();
        vm.warp(rewards.claimableFrom(0));
        _claim(players[0]);
        assertEq(vault.getVotes(address(vesting)), 0);
        assertEq(vault.getVotes(players[0]), 0);

        vm.warp(block.timestamp + VESTING);
        vesting.release(players[0], _epochs(0));
        vm.startPrank(players[0]);
        lms.approve(address(vault), 250e18);
        vault.deposit(250e18);
        vm.stopPrank();
        assertEq(vault.getVotes(players[0]), 250e18);
    }

    /// @dev Anyone may release, but only ever to the player.
    function test_vesting_releaseByAnyone_paysThePlayer() public {
        _playTwoMatches();
        vm.warp(rewards.claimableFrom(0) + VESTING);
        _claim(players[1]);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vesting.release(players[1], _epochs(0));
        assertEq(lms.balanceOf(players[1]), 125e18);
        assertEq(lms.balanceOf(stranger), 0);
    }

    function test_vesting_releasableIn_showsWhatAndWhere() public {
        _playTwoMatches();
        vm.warp(EPOCH);
        _playTwoMatches();
        vm.warp(rewards.claimableFrom(1));
        uint256[] memory both = new uint256[](2);
        both[1] = 1;
        rewards.claim(players[0], both);

        vm.warp(rewards.claimableFrom(1) + VESTING);
        (uint256 total, uint256[] memory epochs) = vesting.releasableIn(players[0], 0, 5);
        assertEq(total, 500e18);
        assertEq(epochs.length, 2);
        assertEq(vesting.release(players[0], epochs), 500e18);
        assertEq(vesting.totalReleased(), vesting.totalGranted());
    }

    function test_vesting_onlyTheDistributorGrants() public {
        vm.expectRevert(abi.encodeWithSelector(RewardVesting.NotDistributor.selector, address(this)));
        vesting.grant(players[0], _epochs(0), _epochs(1));
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

    function test_setMaxRewardPerWalletPerEpoch_ownerOnly_andBounded() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, players[0]));
        vm.prank(players[0]);
        rewards.setMaxRewardPerWalletPerEpoch(1);

        uint256 tooHigh = uint256(type(uint128).max) + 1;
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(RewardsDistributor.MaxRewardPerWalletTooHigh.selector, tooHigh)
        );
        rewards.setMaxRewardPerWalletPerEpoch(tooHigh);
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
            bytes32 matchId = _createMatchmade(seats, _firstPlayers(8));
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
        bytes32 first = _createMatchmadeAndFill(4);
        _lockAndSeed(first, bytes32(uint256(1)));
        _settleAndFinalize(first);

        bytes32 second = _createMatchmade(4, _firstPlayers(8));
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
