// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";

/// @notice Handles the interaction with RewardVesting
abstract contract RewardVestingHandler is Properties {
    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    /// @dev Releases what has vested in every epoch that has a tranche for `player`.
    function vesting_release_clamped(uint256 actorSeed, uint256 playerSeed) public {
        _useActor(actorSeed);
        address player = actors[playerSeed % actors.length];
        uint256 total = feeEpochs.length;
        uint256[] memory epochs = new uint256[](total);
        uint256 count;
        for (uint256 i = 0; i < total; ++i) {
            if (vesting.releasable(player, feeEpochs[i]) != 0) epochs[count++] = feeEpochs[i];
        }
        if (count == 0) return;
        assembly ("memory-safe") {
            mstore(epochs, count)
        }
        vesting_release(player, epochs);
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function vesting_release(address player, uint256[] memory epochs) public asActor {
        _noteAddr(player);
        uint256 expected = _spReleasable(player, epochs);
        uint256 playerBefore = lms.balanceOf(player);
        uint256 callerBefore = lms.balanceOf(actor);
        uint256 vestingBefore = lms.balanceOf(address(vesting));
        uint256 releasedBefore = vesting.totalReleased();
        uint256 got = vesting.release(player, epochs);
        property_vestingRelease(
            player, actor, epochs, expected, got, playerBefore, callerBefore, vestingBefore, releasedBefore
        );
        _afterCall();
    }
}
