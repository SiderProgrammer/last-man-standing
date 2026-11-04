// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";

/// @notice Handles the interaction with RewardsDistributor: play-mining claims.
abstract contract RewardsDistributorHandler is Properties {
    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    /// @dev Claims every ended epoch `player` has not claimed. Anyone may claim for anyone.
    function rewards_claim_clamped(uint256 actorSeed, uint256 playerSeed) public {
        _useActor(actorSeed);
        address player = actors[playerSeed % actors.length];
        uint256 total = feeEpochs.length;
        uint256[] memory epochs = new uint256[](total);
        uint256 count;
        for (uint256 i = 0; i < total; ++i) {
            uint256 epoch = feeEpochs[i];
            if (block.timestamp >= rewards.claimableFrom(epoch) && !rewards.isClaimed(player, epoch)) {
                epochs[count++] = epoch;
            }
        }
        if (count == 0) return;
        assembly ("memory-safe") {
            mstore(epochs, count)
        }
        rewards_claim(player, epochs);
    }

    /// @dev The same epoch twice in one claim: the second must not pay.
    function rewards_claim_duplicateEpoch_clamped(uint256 actorSeed, uint256 playerSeed, uint256 epochSeed)
        public
    {
        _useActor(actorSeed);
        if (feeEpochs.length == 0) return;
        uint256[] memory epochs = new uint256[](2);
        epochs[0] = feeEpochs[epochSeed % feeEpochs.length];
        epochs[1] = epochs[0];
        rewards_claim(actors[playerSeed % actors.length], epochs);
    }

    function rewards_secondary(uint8 selector, uint256 arg0, uint256 toSeed) public {
        selector = uint8(selector % 3);
        if (selector == 0) {
            _rewards_setMaxRewardPerEth(clampBetween(arg0, 0, 100_000e18));
        } else if (selector == 1) {
            _rewards_setMaxRewardPerWalletPerEpoch(clampBetween(arg0, 0, 1_000_000e18));
        } else {
            _rewards_sweep(actors[toSeed % actors.length]);
        }
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function rewards_claim(address player, uint256[] memory epochs) public asActor {
        _noteAddr(player);
        SpClaim memory c = _spClaimPre(player, epochs);
        uint256 reward = rewards.claim(player, epochs);
        property_rewardsClaim(c, player, epochs, reward);
        _afterCall();
    }

    function _rewards_setMaxRewardPerEth(uint256 cap) internal asTimelock {
        rewards.setMaxRewardPerEth(cap);
        _afterCall();
    }

    function _rewards_setMaxRewardPerWalletPerEpoch(uint256 cap) internal asTimelock {
        rewards.setMaxRewardPerWalletPerEpoch(cap);
        _afterCall();
    }

    function _rewards_sweep(address to) internal asTimelock {
        uint256 swept = rewards.sweep(to);
        ghosts.rewardsSwept += swept;
        _afterCall();
    }
}
