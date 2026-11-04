// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";

/// @notice Handles the interaction with LiquidityReserve
abstract contract LiquidityReserveHandler is Properties {
    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    /// @dev `recipientSeed` reaches the addresses that may never be approved as
    ///      well as the actors: the vault, the Safe and the reserve itself.
    function reserve_secondary(uint8 selector, uint256 recipientSeed, uint256 amount, bool flag) public {
        selector = uint8(selector % 2);
        address recipient = _reserveCandidate(recipientSeed);
        if (selector == 0) _reserve_setRecipient(recipient, flag);
        else _reserve_release(recipient, clampBetween(amount, 0, lms.balanceOf(address(reserve))), flag);
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function _reserve_setRecipient(address recipient, bool approved) internal asTimelock {
        reserve.setRecipient(recipient, approved);
        property_reserveSetRecipient(recipient);
        _afterCall();
    }

    function _reserve_release(address to, uint256 amount, bool bySafe) internal {
        bool approvedBefore = reserve.isApproved(to);
        uint256 reserveBefore = lms.balanceOf(address(reserve));
        uint256 toBefore = lms.balanceOf(to);
        vm.startPrank(bySafe ? safe : address(timelock));
        reserve.release(to, amount);
        vm.stopPrank();
        ghosts.reserveReleased += amount;
        property_reserveRelease(to, amount, approvedBefore, reserveBefore, toBefore);
        _afterCall();
    }

    // ――――――――――――――――――――――――― Private ――――――――――――――――――――――――――

    function _reserveCandidate(uint256 seed) private view returns (address) {
        uint256 pick = seed % (actors.length + 3);
        if (pick < actors.length) return actors[pick];
        if (pick == actors.length) return address(stakedLms);
        if (pick == actors.length + 1) return safe;
        return address(reserve);
    }
}
