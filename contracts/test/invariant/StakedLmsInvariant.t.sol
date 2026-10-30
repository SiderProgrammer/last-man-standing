// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {LmsToken} from "../../src/governance/LmsToken.sol";
import {StakedLms} from "../../src/governance/StakedLms.sol";

/// @dev Drives `StakedLms` through stakes, transfers, delegation, unstaking
///      and reward deposits and claims, in any order and at any pace.
contract StakedLmsHandler is Test {
    StakedLms public vault;
    LmsToken public lms;
    address[] public actors;

    /// @dev Ghosts: ETH that arrived as rewards, and ETH paid out.
    uint256 public deposited;
    uint256 public claimed;

    constructor(StakedLms vault_, LmsToken lms_, address[] memory actors_) {
        vault = vault_;
        lms = lms_;
        actors = actors_;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) private view returns (address) {
        return actors[seed % actors.length];
    }

    function deposit(uint256 who, uint256 amount) public {
        address actor = _actor(who);
        amount = bound(amount, 1, lms.balanceOf(actor));
        vm.prank(actor);
        vault.deposit(amount);
    }

    function depositFor(uint256 from, uint256 to, uint256 amount) public {
        address payer = _actor(from);
        amount = bound(amount, 1, lms.balanceOf(payer));
        vm.prank(payer);
        vault.depositFor(_actor(to), amount);
    }

    function transfer(uint256 from, uint256 to, uint256 amount) public {
        address sender = _actor(from);
        amount = bound(amount, 0, vault.balanceOf(sender));
        vm.prank(sender);
        vault.transfer(_actor(to), amount);
    }

    function delegate(uint256 who, uint256 to) public {
        vm.prank(_actor(who));
        vault.delegate(_actor(to));
    }

    function requestUnstake(uint256 who, uint256 amount) public {
        address actor = _actor(who);
        amount = bound(amount, 1, vault.balanceOf(actor));
        vm.prank(actor);
        vault.requestUnstake(amount);
    }

    function claim(uint256 who) public {
        address actor = _actor(who);
        (, uint64 unlockAt) = vault.unstakeOf(actor);
        if (block.timestamp < unlockAt) vm.warp(unlockAt);
        vm.prank(actor);
        vault.claim(actor);
    }

    function depositRewards(uint256 amount) public {
        amount = bound(amount, 1, 10 ether);
        vm.deal(address(this), amount);
        vault.depositRewards{value: amount}();
        deposited += amount;
    }

    function claimRewards(uint256 who) public {
        address actor = _actor(who);
        uint256 before = actor.balance;
        vm.prank(actor);
        vault.claimRewards(actor);
        claimed += actor.balance - before;
    }

    function warp(uint256 secs) public {
        vm.warp(block.timestamp + bound(secs, 1, 10 days));
    }
}

contract StakedLmsInvariantTest is Test {
    LmsToken internal lms;
    StakedLms internal vault;
    StakedLmsHandler internal handler;
    address[] internal actors;

    function setUp() public {
        lms = new LmsToken(address(this), 100_000_000e18);
        vault = new StakedLms(lms, makeAddr("owner"), 7 days, 7 days);
        for (uint256 i = 0; i < 4; ++i) {
            address actor = makeAddr(string.concat("staker", vm.toString(i)));
            actors.push(actor);
            lms.transfer(actor, 1_000_000e18);
            vm.prank(actor);
            lms.approve(address(vault), type(uint256).max);
        }
        handler = new StakedLmsHandler(vault, lms, actors);
        targetContract(address(handler));
    }

    /// @dev Every holder delegates to an actor, so the actors' votes are all
    ///      the votes there are, and they are exactly the staked supply.
    function invariant_votesAreTheStakedSupply() public view {
        uint256 votes;
        for (uint256 i = 0; i < actors.length; ++i) {
            votes += vault.getVotes(actors[i]);
        }
        assertEq(votes, vault.totalSupply());
    }

    /// @dev One sLMS is one LMS, and unstaking LMS is held until claimed.
    function invariant_everySlmsAndEveryUnstakeIsBacked() public view {
        uint256 unstaking;
        for (uint256 i = 0; i < actors.length; ++i) {
            (uint128 pending,) = vault.unstakeOf(actors[i]);
            unstaking += pending;
        }
        assertEq(vault.totalUnstaking(), unstaking);
        assertEq(lms.balanceOf(address(vault)), vault.totalSupply() + unstaking);
    }

    /// @dev The vault holds every wei of ETH that arrived and was not paid
    ///      out, which covers everything earned and not yet claimed.
    function invariant_ethRewardsStaySolvent() public view {
        assertEq(address(vault).balance, handler.deposited() - handler.claimed());
        uint256 owed;
        for (uint256 i = 0; i < actors.length; ++i) {
            owed += vault.earned(actors[i]);
        }
        assertLe(owed, address(vault).balance);
    }
}
