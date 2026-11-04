// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";

/// @notice Handles the interaction with ProtocolConfig. Each change stands for a
///         proposal the timelock executed, reaching matches already under way.
abstract contract ProtocolConfigHandler is Properties {
    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    function config_secondary(uint8 selector, uint256 arg0, uint256 arg1, uint256 arg2) public {
        selector = uint8(selector % 8);
        if (selector == 0) {
            _setParamsClamped(arg0, arg1, arg2);
        } else if (selector == 1) {
            _setPayoutClamped(arg0, arg1);
        } else if (selector == 2) {
            // Zero is the boundary the setter must refuse.
            _config_setChallengeWindow(uint64(clampBetween(arg0, 0, CHALLENGE_WINDOW)));
        } else if (selector == 3) {
            _setAttestorsClamped(arg0, arg1);
        } else if (selector == 4) {
            _config_setGuardian(arg0 % 2 == 0 ? guardian : address(0));
        } else if (selector == 5) {
            _config_setSequencerUptimeFeed(arg0 % 2 == 0 ? address(sequencerFeed) : address(0));
        } else if (selector == 6) {
            _setDiscountClamped(arg0);
        } else {
            // A feed reporting down, or up only just now: finalize's two reverts.
            sequencerFeed.set(arg0 % 2 == 0, arg1 % 2 == 0 ? 0 : block.timestamp);
            _afterCall();
        }
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function _config_setParams(ProtocolConfig.Params memory newParams) internal asTimelock {
        config.setParams(newParams);
        _afterCall();
    }

    function _config_setPayoutSchedule(uint16[] memory newSchedule) internal asTimelock {
        config.setPayoutSchedule(newSchedule);
        _afterCall();
    }

    function _config_setChallengeWindow(uint64 window) internal asTimelock {
        config.setChallengeWindow(window);
        _afterCall();
    }

    function _config_setAttestorSet(address[] memory attestors, uint32 threshold) internal asTimelock {
        config.setAttestorSet(attestors, threshold);
        _afterCall();
    }

    function _config_setGuardian(address newGuardian) internal asTimelock {
        config.setGuardian(newGuardian);
        _afterCall();
    }

    function _config_setSequencerUptimeFeed(address feed) internal asTimelock {
        config.setSequencerUptimeFeed(feed);
        _afterCall();
    }

    function _config_setLmsPerEthDiscount(uint256 lmsPerEth) internal asTimelock {
        config.setLmsPerEthDiscount(lmsPerEth);
        _afterCall();
    }

    // ――――――――――――――――――――――――― Private ――――――――――――――――――――――――――

    /// @dev Windows stay at or under the harness's, so the timelock delay still
    ///      outlasts a match. The fee and the stake reach their boundaries: a fee
    ///      of zero or of 10%, and a minimum stake of one wei.
    function _setParamsClamped(uint256 arg0, uint256 arg1, uint256 arg2) private {
        uint16 minSeats = uint16(clampBetween(arg1 & 0xff, 2, 8));
        uint16 maxSeats = uint16(clampBetween((arg1 >> 8) & 0xff, uint256(minSeats), 8));
        uint128 minStake = uint128(clampBetween(arg2 & type(uint64).max, 1, 0.001 ether));
        uint128 maxStake = uint128(clampBetween((arg2 >> 64) & type(uint64).max, uint256(minStake), 1 ether));
        _config_setParams(
            ProtocolConfig.Params({
                feeBps: uint16(clampBetween(arg0 & 0xffff, 0, 1_000)),
                minSeats: minSeats,
                maxSeats: maxSeats,
                joinWindow: uint64(clampBetween((arg0 >> 16) & type(uint32).max, 1 hours, JOIN_WINDOW)),
                settleWindow: uint64(clampBetween((arg0 >> 48) & type(uint32).max, 1 hours, SETTLE_WINDOW)),
                minStake: minStake,
                maxStake: maxStake,
                treasury: address(feeRouter)
            })
        );
    }

    /// @dev One to three paid places that sum to exactly 100%, zero shares included.
    function _setPayoutClamped(uint256 arg0, uint256 arg1) private {
        uint256 first = clampBetween(arg0, 0, 10_000);
        uint256 second = clampBetween(arg1, 0, 10_000 - first);
        uint256 places = arg0 % 3 + 1;
        uint16[] memory schedule = new uint16[](places);
        if (places == 1) {
            schedule[0] = 10_000;
        } else if (places == 2) {
            schedule[0] = uint16(first);
            schedule[1] = uint16(10_000 - first);
        } else {
            schedule[0] = uint16(first);
            schedule[1] = uint16(second);
            schedule[2] = uint16(10_000 - first - second);
        }
        _config_setPayoutSchedule(schedule);
    }

    /// @dev A new attestor version from the keys the handlers can sign with.
    function _setAttestorsClamped(uint256 mask, uint256 threshold) private {
        mask = (mask % (1 << ATTESTOR_COUNT)) | 1;
        address[] memory attestors = new address[](ATTESTOR_COUNT);
        uint256 count;
        for (uint256 i = 0; i < ATTESTOR_COUNT; ++i) {
            if (mask & (1 << i) != 0) attestors[count++] = attestorPool[i];
        }
        assembly ("memory-safe") {
            mstore(attestors, count)
        }
        _config_setAttestorSet(attestors, uint32(clampBetween(threshold, 1, count)));
    }

    /// @dev Off, tiny, the deploy default, and so dear a seat can hardly buy any discount.
    function _setDiscountClamped(uint256 arg0) private {
        uint256 pick = arg0 % 4;
        if (pick == 0) _config_setLmsPerEthDiscount(0);
        else if (pick == 1) _config_setLmsPerEthDiscount(1);
        else if (pick == 2) _config_setLmsPerEthDiscount(LMS_PER_ETH_DISCOUNT);
        else _config_setLmsPerEthDiscount(1e30);
    }
}
