// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";

/// @notice Handles the interaction with MultisigPhase: the Safe's timelock powers.
abstract contract MultisigPhaseHandler is Properties {
    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    function multisig_secondary(uint8 selector, uint256 arg0, uint8 mode) public {
        selector = uint8(selector % 6);
        if (selector == 0) {
            _scheduleAllowed(arg0);
        } else if (selector == 1) {
            (address target, bytes memory data) = _forbiddenCall(mode);
            vm.prank(safe);
            try phase.schedule(target, 0, data, bytes32(0), bytes32(++saltNonce), timelock.getMinDelay()) {
                t(false, "SP-33: the phase scheduled a forbidden call");
            } catch {}
        } else if (selector == 5) {
            _scheduleBatchWithForbidden(mode);
        } else if (selector == 2) {
            _cancelScheduled(arg0);
        } else if (selector == 3) {
            _executeScheduled(arg0);
        } else {
            _multisig_retire();
        }
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function _multisig_schedule(address target, bytes memory data, bytes32 salt) internal asSafe {
        phase.schedule(target, 0, data, bytes32(0), salt, timelock.getMinDelay());
        _afterCall();
    }

    function _multisig_scheduleBatch(address[] memory targets, bytes[] memory payloads, bytes32 salt)
        internal
        asSafe
    {
        phase.scheduleBatch(
            targets, new uint256[](targets.length), payloads, bytes32(0), salt, timelock.getMinDelay()
        );
        _afterCall();
    }

    function _multisig_cancel(bytes32 id) internal asSafe {
        phase.cancel(id);
        _afterCall();
    }

    function _multisig_retire() internal asActor {
        try phase.retire() {
            t(block.timestamp >= phase.phaseEnd(), "SP-33: the phase retired before its end");
            for (uint256 i = 0; i < scheduledOps.length; ++i) {
                ScheduledOp storage op = scheduledOps[i];
                bytes32 id = timelock.hashOperation(op.target, 0, op.data, bytes32(0), op.salt);
                t(!timelock.isOperationPending(id), "SP-33: a call the Safe scheduled outlived the phase");
            }
        } catch {
            return;
        }
        ghosts.phaseRetired = true;
        _afterCall();
    }

    // ――――――――――――――――――――――――― Private ――――――――――――――――――――――――――

    function _scheduleAllowed(uint256 arg0) private {
        address target = address(feeRouter);
        bytes memory data =
            abi.encodeWithSelector(feeRouter.setStakerBps.selector, uint16(clampBetween(arg0, 0, 10_000)));
        bytes32 salt = bytes32(++saltNonce);
        _multisig_schedule(target, data, salt);
        scheduledOps.push(ScheduledOp({target: target, data: data, salt: salt}));
    }

    /// @dev A forbidden call behind an allowed one: every entry of a batch is checked.
    function _scheduleBatchWithForbidden(uint8 mode) private {
        address[] memory targets = new address[](2);
        bytes[] memory payloads = new bytes[](2);
        targets[0] = address(feeRouter);
        payloads[0] = abi.encodeWithSelector(feeRouter.setStakerBps.selector, uint16(1));
        (targets[1], payloads[1]) = _forbiddenCall(mode);
        vm.prank(safe);
        try phase.scheduleBatch(
            targets, new uint256[](2), payloads, bytes32(0), bytes32(++saltNonce), timelock.getMinDelay()
        ) {
            t(false, "SP-33: the phase scheduled a batch holding a forbidden call");
        } catch {}
    }

    /// @dev Each of the calls the contract notes say the Safe can never schedule.
    function _forbiddenCall(uint8 mode) private view returns (address target, bytes memory data) {
        mode = uint8(mode % 8);
        target = address(config);
        if (mode == 0) {
            target = address(timelock);
            data = abi.encodeWithSelector(timelock.updateDelay.selector, uint256(0));
        } else if (mode == 1) {
            data = abi.encodeWithSelector(config.transferOwnership.selector, safe);
        } else if (mode == 2) {
            data = abi.encodeWithSelector(config.renounceOwnership.selector);
        } else if (mode == 3) {
            target = address(lms);
            data = abi.encodeWithSelector(lms.transfer.selector, safe, uint256(1));
        } else if (mode == 4) {
            target = address(rewards);
            data = abi.encodeWithSelector(rewards.sweep.selector, safe);
        } else if (mode == 5) {
            target = address(stakedLms);
            data = abi.encodeWithSelector(stakedLms.sweepStray.selector, safe);
        } else if (mode == 6) {
            target = address(reserve);
            data = abi.encodeWithSelector(reserve.setRecipient.selector, actors[0], true);
        } else {
            target = address(bridgeReceiver);
            data = abi.encodeWithSelector(bridgeReceiver.recover.selector, address(lms), safe, uint256(1));
        }
    }

    function _cancelScheduled(uint256 seed) private {
        if (scheduledOps.length == 0) return;
        ScheduledOp storage op = scheduledOps[seed % scheduledOps.length];
        _multisig_cancel(timelock.hashOperation(op.target, 0, op.data, bytes32(0), op.salt));
    }

    /// @dev The timelock's executor role is open: anyone may run a ready operation.
    function _executeScheduled(uint256 seed) private {
        if (scheduledOps.length == 0) return;
        ScheduledOp storage op = scheduledOps[seed % scheduledOps.length];
        timelock.execute(op.target, 0, op.data, bytes32(0), op.salt);
        _afterCall();
    }
}
