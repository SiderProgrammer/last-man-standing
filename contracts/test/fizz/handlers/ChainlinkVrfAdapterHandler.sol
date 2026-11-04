// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";

/// @notice Handles the interaction with ChainlinkVrfAdapter
abstract contract ChainlinkVrfAdapterHandler is Properties {
    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    /// @dev The VRF node answering the first unanswered request at or after `seed`.
    function vrf_fulfill_clamped(uint256 seed, uint256 word) public {
        uint256 count = vrfRequestIds.length;
        for (uint256 i = 0; i < count; ++i) {
            uint256 vrfId = vrfRequestIds[(seed % count + i) % count];
            (address consumer, bool answered,,) = vrf.requests(vrfId);
            if (consumer != address(0) && !answered) {
                (bytes32 id, SpPre memory p, GameEscrow.MatchInfo memory info) = _vrfBefore(vrfId);
                coordinator.fulfill(vrfId, word);
                property_randomnessDelivery(p, info, id, bytes32(word));
                _afterCall();
                return;
            }
        }
    }

    /// @dev Retries a word whose delivery failed: its match was cancelled while waiting.
    function vrf_deliver_clamped(uint256 actorSeed, uint256 seed) public {
        _useActor(actorSeed);
        uint256 count = vrfRequestIds.length;
        for (uint256 i = 0; i < count; ++i) {
            uint256 vrfId = vrfRequestIds[(seed % count + i) % count];
            (address consumer, bool answered,,) = vrf.requests(vrfId);
            if (consumer != address(0) && answered) {
                vrf_deliver(vrfId);
                return;
            }
        }
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function vrf_deliver(uint256 vrfId) public asActor {
        (bytes32 id, SpPre memory p, GameEscrow.MatchInfo memory info) = _vrfBefore(vrfId);
        (,,, bytes32 word) = vrf.requests(vrfId);
        vrf.deliver(vrfId);
        property_randomnessDelivery(p, info, id, word);
        _afterCall();
    }

    /// @dev The coordinator's callback must never revert for any request id or words (SP-05).
    function vrf_rawFulfillRandomWords(uint256 vrfId, uint256[] memory randomWords) public {
        (bytes32 id, SpPre memory p, GameEscrow.MatchInfo memory info) = _vrfBefore(vrfId);
        vm.prank(address(coordinator));
        try vrf.rawFulfillRandomWords(vrfId, randomWords) {}
        catch {
            t(false, "SP-05: the coordinator's callback reverted");
        }
        if (randomWords.length != 0) property_randomnessDelivery(p, info, id, bytes32(randomWords[0]));
        _afterCall();
    }

    // ――――――――――――――――――――――――― Private ――――――――――――――――――――――――――

    function _vrfBefore(uint256 vrfId)
        private
        view
        returns (bytes32 id, SpPre memory p, GameEscrow.MatchInfo memory info)
    {
        (,, bytes32 context,) = vrf.requests(vrfId);
        id = context;
        p = _spPre(address(0));
        info = escrow.getMatch(id);
    }
}
