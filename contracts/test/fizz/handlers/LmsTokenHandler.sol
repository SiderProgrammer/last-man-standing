// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";

/// @notice Handles the interaction with LmsToken
abstract contract LmsTokenHandler is Properties {
    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    function lms_transfer_clamped(uint256 actorSeed, uint256 toSeed, uint256 value) public {
        _useActor(actorSeed);
        uint256 balance = lms.balanceOf(actor);
        if (balance == 0) return;
        lms_transfer(actors[toSeed % actors.length], clampBetween(value, 1, balance));
    }

    /// @dev Shrinks the supply the governor's quorum floor cap is measured against.
    function lms_burn_clamped(uint256 actorSeed, uint256 value) public {
        _useActor(actorSeed);
        uint256 balance = lms.balanceOf(actor);
        if (balance == 0) return;
        lms_burn(clampBetween(value, 1, balance));
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function lms_transfer(address to, uint256 value) public asActor {
        _noteAddr(to);
        lms.transfer(to, value);
        ghosts.lmsDirectIn[to] += value;
        _afterCall();
    }

    function lms_burn(uint256 value) public asActor {
        lms.burn(value);
        ghosts.burnedLms += value;
        _afterCall();
    }
}
