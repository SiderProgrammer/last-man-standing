// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";

/// @notice Handles the interaction with StakedLms: staking, the reward stream, votes.
abstract contract StakedLmsHandler is Properties {
    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    function stakedLms_deposit_clamped(uint256 actorSeed, uint256 amount) public {
        _useActor(actorSeed);
        uint256 balance = lms.balanceOf(actor);
        if (balance == 0) return;
        stakedLms_deposit(clampBetween(amount, 1, balance));
    }

    /// @dev Near zero: one wei of stake against a scaled reward accumulator.
    function stakedLms_deposit_dust_clamped(uint256 actorSeed, uint256 amount) public {
        _useActor(actorSeed);
        if (lms.balanceOf(actor) < 1e6) return;
        stakedLms_deposit(clampBetween(amount, 1, 1e6));
    }

    function stakedLms_depositFor_clamped(uint256 actorSeed, uint256 accountSeed, uint256 amount) public {
        _useActor(actorSeed);
        uint256 balance = lms.balanceOf(actor);
        if (balance == 0) return;
        stakedLms_depositFor(actors[accountSeed % actors.length], clampBetween(amount, 1, balance));
    }

    function stakedLms_depositRewards_clamped(uint256 actorSeed, uint256 amount) public {
        _useActor(actorSeed);
        amount = clampBetween(amount, 1, 100 ether);
        _fund(actor, amount);
        stakedLms_depositRewards(amount);
    }

    /// @dev Near zero: dust restarts the period for the whole remainder.
    function stakedLms_depositRewards_dust_clamped(uint256 actorSeed, uint256 amount) public {
        _useActor(actorSeed);
        amount = clampBetween(amount, 1, 1e9);
        _fund(actor, amount);
        stakedLms_depositRewards(amount);
    }

    function stakedLms_claimRewards_clamped(uint256 actorSeed, uint256 toSeed) public {
        _useActor(actorSeed);
        if (stakedLms.earned(actor) == 0) return;
        stakedLms_claimRewards(actors[toSeed % actors.length]);
    }

    function stakedLms_requestUnstake_clamped(uint256 actorSeed, uint256 amount) public {
        _useActor(actorSeed);
        uint256 balance = stakedLms.balanceOf(actor);
        if (balance == 0) return;
        stakedLms_requestUnstake(clampBetween(amount, 1, balance));
    }

    /// @dev Full amount: can take the supply to zero, which pauses the stream.
    function stakedLms_requestUnstake_full_clamped(uint256 actorSeed) public {
        _useActor(actorSeed);
        uint256 balance = stakedLms.balanceOf(actor);
        if (balance == 0) return;
        stakedLms_requestUnstake(balance);
    }

    /// @dev Every staker leaves. With nothing staked the stream pauses, and what it
    ///      still holds must wait for the next staker.
    function stakedLms_unstakeEveryone_clamped() public {
        for (uint256 i = 0; i < actors.length; ++i) {
            uint256 balance = stakedLms.balanceOf(actors[i]);
            if (balance == 0) continue;
            actor = actors[i];
            stakedLms_requestUnstake(balance);
        }
    }

    function stakedLms_claim_clamped(uint256 actorSeed, uint256 receiverSeed) public {
        _useActor(actorSeed);
        (uint128 assets, uint64 unlockAt) = stakedLms.unstakeOf(actor);
        if (assets == 0 || block.timestamp < unlockAt) return;
        stakedLms_claim(actors[receiverSeed % actors.length]);
    }

    function stakedLms_transfer_clamped(uint256 actorSeed, uint256 toSeed, uint256 value) public {
        _useActor(actorSeed);
        uint256 balance = stakedLms.balanceOf(actor);
        if (balance == 0) return;
        stakedLms_transfer(actors[toSeed % actors.length], clampBetween(value, 1, balance));
    }

    function stakedLms_delegate_clamped(uint256 actorSeed, uint256 delegateeSeed) public {
        _useActor(actorSeed);
        stakedLms_delegate(actors[delegateeSeed % actors.length]);
    }

    /// @dev LMS sent straight to the vault: neither staked nor unstaking.
    function stakedLms_donateLms(uint256 actorSeed, uint256 amount) public {
        _useActor(actorSeed);
        uint256 balance = lms.balanceOf(actor);
        if (balance == 0) return;
        amount = clampBetween(amount, 1, balance);
        vm.prank(actor);
        lms.transfer(address(stakedLms), amount);
        ghosts.lmsDirectIn[address(stakedLms)] += amount;
        _afterCall();
    }

    /// @dev ETH forced in, past `depositRewards`.
    function stakedLms_donateETH(uint256 amount) public {
        amount = clampBetween(amount, 1, 10 ether);
        _forceSend(address(stakedLms), amount);
        ghosts.donatedStakedEth += amount;
    }

    /// @dev Stake, add rewards, unstake, all in one call: the staker was in for no time and
    ///      must have earned nothing (SP-20).
    function stakedLms_flashStake_clamped(uint256 actorSeed, uint256 amount, uint256 reward) public {
        _useActor(actorSeed);
        uint256 balance = lms.balanceOf(actor);
        if (balance == 0) return;
        amount = clampBetween(amount, 1, balance);
        reward = clampBetween(reward, 0, 10 ether);
        SpStake memory s = _spStake();
        uint256 earnedBefore = stakedLms.earned(actor);
        _fund(actor, reward);
        vm.startPrank(actor);
        stakedLms.deposit(amount);
        if (reward != 0) stakedLms.depositRewards{value: reward}();
        stakedLms.requestUnstake(amount);
        vm.stopPrank();
        ghosts.accrualOps += 3;
        ghosts.stakedEthDeposited += reward;
        eq(stakedLms.earned(actor), earnedBefore, "SP-20: a same-call stake and unstake earned something");
        property_stakingNeutral(s, address(0), actor);
        _afterCall();
    }

    function stakedLms_secondary(uint8 selector, uint256 arg0, uint256 toSeed) public {
        selector = uint8(selector % 2);
        if (selector == 0) _stakedLms_setCooldown(uint64(clampBetween(arg0, 1 days, 30 days)));
        else _stakedLms_sweepStray(actors[toSeed % actors.length]);
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function stakedLms_deposit(uint256 amount) public asActor {
        SpStake memory s = _spStake();
        uint256 payerBefore = lms.balanceOf(actor);
        uint256 accountBefore = stakedLms.balanceOf(actor);
        stakedLms.deposit(amount);
        ++ghosts.accrualOps;
        property_stakeDeposit(s, actor, actor, amount, payerBefore, accountBefore);
        _afterCall();
    }

    function stakedLms_depositFor(address account, uint256 amount) public asActor {
        _noteAddr(account);
        SpStake memory s = _spStake();
        uint256 payerBefore = lms.balanceOf(actor);
        uint256 accountBefore = stakedLms.balanceOf(account);
        stakedLms.depositFor(account, amount);
        ++ghosts.accrualOps;
        property_stakeDeposit(s, actor, account, amount, payerBefore, accountBefore);
        _afterCall();
    }

    function stakedLms_depositRewards(uint256 amount) public asActor {
        SpStake memory s = _spStake();
        stakedLms.depositRewards{value: amount}();
        ghosts.stakedEthDeposited += amount;
        ++ghosts.accrualOps;
        property_depositRewards(s, amount);
        _afterCall();
    }

    function stakedLms_claimRewards(address to) public asActor {
        _noteAddr(to);
        SpStake memory s = _spStake();
        uint256 earnedBefore = stakedLms.earned(actor);
        uint256 got = stakedLms.claimRewards(to);
        ghosts.stakedEthClaimed += got;
        ++ghosts.accrualOps;
        property_claimRewards(s, actor, earnedBefore, got);
        _afterCall();
    }

    function stakedLms_requestUnstake(uint256 amount) public asActor {
        SpStake memory s = _spStake();
        uint256 sBefore = stakedLms.balanceOf(actor);
        (uint128 assetsBefore,) = stakedLms.unstakeOf(actor);
        stakedLms.requestUnstake(amount);
        ++ghosts.accrualOps;
        property_requestUnstake(s, actor, amount, sBefore, assetsBefore);
        _afterCall();
    }

    function stakedLms_claim(address receiver) public asActor {
        _noteAddr(receiver);
        SpStake memory s = _spStake();
        (uint128 assets, uint64 unlockAt) = stakedLms.unstakeOf(actor);
        uint256 receiverBefore = lms.balanceOf(receiver);
        try stakedLms.claim(receiver) {}
        catch (bytes memory reason) {
            // SP-21: after the unlock a claim never reverts.
            t(
                assets == 0 || receiver == address(0) || block.timestamp < unlockAt,
                "SP-21: claim reverted although the cooldown has passed"
            );
            _spExitFailed(reason, "");
        }
        property_claim(s, actor, receiver, assets, unlockAt, receiverBefore);
        _afterCall();
    }

    function stakedLms_transfer(address to, uint256 value) public asActor {
        _noteAddr(to);
        SpStake memory s = _spStake();
        stakedLms.transfer(to, value);
        ++ghosts.accrualOps;
        property_stakingNeutral(s, address(0), address(0));
        _afterCall();
    }

    function stakedLms_delegate(address delegatee) public asActor {
        _noteAddr(delegatee);
        SpStake memory s = _spStake();
        stakedLms.delegate(delegatee);
        property_stakingNeutral(s, address(0), address(0));
        _afterCall();
    }

    function _stakedLms_setCooldown(uint64 cooldown_) internal asTimelock {
        SpStake memory s = _spStake();
        stakedLms.setCooldown(cooldown_);
        eq(uint256(stakedLms.cooldown()), uint256(cooldown_), "SP-21: setCooldown did not store the cooldown");
        property_stakingNeutral(s, address(0), address(0));
        _afterCall();
    }

    function _stakedLms_sweepStray(address to) internal asTimelock {
        _noteAddr(to);
        SpStake memory s = _spStake();
        uint256 toBefore = lms.balanceOf(to);
        uint256 swept = stakedLms.sweepStray(to);
        ghosts.sweptStakedLms += swept;
        property_sweepStray(s, to, swept, toBefore);
        _afterCall();
    }
}
