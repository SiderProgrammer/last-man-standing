// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {IFeeLedger} from "../../src/interfaces/IFeeLedger.sol";
import {LmsToken} from "../../src/governance/LmsToken.sol";
import {StakedLms} from "../../src/governance/StakedLms.sol";
import {RewardsDistributor} from "../../src/governance/RewardsDistributor.sol";
import {RewardVesting} from "../../src/governance/RewardVesting.sol";

/// @dev The escrow's fee totals, written directly: a fee lands in the
///      current epoch only, as settlement does.
contract MockFeeLedger is IFeeLedger {
    uint256 public constant FEE_EPOCH = 7 days;
    mapping(address player => mapping(uint256 epoch => uint256)) public feesPaid;
    mapping(uint256 epoch => uint256) public epochFees;

    function pay(address player, uint256 amount) external {
        uint256 epoch = block.timestamp / FEE_EPOCH;
        feesPaid[player][epoch] += amount;
        epochFees[epoch] += amount;
    }
}

/// @dev Players pay fees, time passes, claims vest, vested LMS is released
///      and staked, and governance moves the caps.
contract RewardsHandler is Test {
    MockFeeLedger public ledger;
    RewardsDistributor public rewards;
    RewardVesting public vesting;
    StakedLms public vault;
    LmsToken public lms;
    address public owner;
    address[] public actors;

    /// @dev Every epoch fees were paid in, and the LMS each one's claims granted.
    uint256[] public epochs;
    mapping(uint256 epoch => bool) private seen;
    mapping(uint256 epoch => uint256) public grantedIn;

    constructor(
        MockFeeLedger ledger_,
        RewardsDistributor rewards_,
        StakedLms vault_,
        address owner_,
        address[] memory actors_
    ) {
        ledger = ledger_;
        rewards = rewards_;
        vesting = rewards_.vesting();
        vault = vault_;
        lms = LmsToken(address(rewards_.lms()));
        owner = owner_;
        actors = actors_;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function epochCount() external view returns (uint256) {
        return epochs.length;
    }

    function _actor(uint256 seed) private view returns (address) {
        return actors[seed % actors.length];
    }

    function payFee(uint256 who, uint256 amount) public {
        ledger.pay(_actor(who), bound(amount, 1, 5 ether));
        uint256 epoch = block.timestamp / ledger.FEE_EPOCH();
        if (!seen[epoch]) {
            seen[epoch] = true;
            epochs.push(epoch);
        }
    }

    function warp(uint256 secs) public {
        vm.warp(block.timestamp + bound(secs, 1 hours, 30 days));
    }

    function claim(uint256 who, uint256 pick) public {
        if (epochs.length == 0) return;
        uint256 epoch = epochs[pick % epochs.length];
        uint256[] memory one = new uint256[](1);
        one[0] = epoch;
        grantedIn[epoch] += rewards.claim(_actor(who), one);
    }

    function release(uint256 who, uint256 pick) public {
        if (epochs.length == 0) return;
        uint256[] memory one = new uint256[](1);
        one[0] = epochs[pick % epochs.length];
        vesting.release(_actor(who), one);
    }

    /// @dev Stakes whatever liquid LMS the actor has: released rewards only.
    function stake(uint256 who) public {
        address actor = _actor(who);
        uint256 amount = lms.balanceOf(actor);
        if (amount == 0) return;
        vm.startPrank(actor);
        lms.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function setCaps(uint256 perEth, uint256 perWallet) public {
        vm.startPrank(owner);
        rewards.setMaxRewardPerEth(bound(perEth, 0, 1_000_000e18));
        rewards.setMaxRewardPerWalletPerEpoch(bound(perWallet, 0, 1_000_000e18));
        vm.stopPrank();
    }
}

contract RewardsInvariantTest is Test {
    uint256 internal constant BUDGET = 50_000_000e18;

    MockFeeLedger internal ledger;
    LmsToken internal lms;
    StakedLms internal vault;
    RewardsDistributor internal rewards;
    RewardVesting internal vesting;
    RewardsHandler internal handler;
    address internal owner;
    address[] internal actors;

    function setUp() public {
        owner = makeAddr("owner");
        ledger = new MockFeeLedger();
        lms = new LmsToken(address(this), BUDGET);
        vault = new StakedLms(lms, owner, 7 days, 7 days);
        rewards = new RewardsDistributor(ledger, lms, owner, 0, BUDGET, 10_000e18, 20_000e18);
        vesting = rewards.vesting();
        lms.transfer(address(rewards), BUDGET);

        for (uint256 i = 0; i < 4; ++i) {
            actors.push(makeAddr(string.concat("player", vm.toString(i))));
        }
        handler = new RewardsHandler(ledger, rewards, vault, owner, actors);
        targetContract(address(handler));
    }

    /// @dev Σ vested ≤ Σ granted ≤ budget, and released ≤ vested.
    function invariant_vestedWithinGrantedWithinBudget() public view {
        uint256 vested;
        for (uint256 a = 0; a < actors.length; ++a) {
            for (uint256 e = 0; e < handler.epochCount(); ++e) {
                vested += vesting.vested(actors[a], handler.epochs(e));
            }
        }
        assertLe(vesting.totalReleased(), vested);
        assertLe(vested, vesting.totalGranted());
        assertLe(vesting.totalGranted(), rewards.totalBudget());
    }

    /// @dev No epoch's claims add up to more than its budget.
    function invariant_noEpochPaysMoreThanItsBudget() public view {
        for (uint256 e = 0; e < handler.epochCount(); ++e) {
            uint256 epoch = handler.epochs(e);
            assertLe(handler.grantedIn(epoch), rewards.epochBudget(epoch));
        }
    }

    /// @dev Every LMS of the budget is in the distributor, vesting, or released.
    function invariant_lmsIsConserved() public view {
        assertEq(lms.balanceOf(address(vesting)), vesting.totalGranted() - vesting.totalReleased());
        assertEq(lms.balanceOf(address(rewards)) + vesting.totalGranted(), BUDGET);
    }

    /// @dev The only LMS the players ever hold is released LMS, so nothing
    ///      staked — nothing that votes — had not vested first.
    function invariant_nothingVotesBeforeItVests() public view {
        assertLe(vault.totalSupply(), vesting.totalReleased());
        assertEq(vault.getVotes(address(vesting)), 0);
        uint256 votes;
        for (uint256 a = 0; a < actors.length; ++a) {
            votes += vault.getVotes(actors[a]);
        }
        assertEq(votes, vault.totalSupply());
    }
}
