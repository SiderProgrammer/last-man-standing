// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {ProtocolConfig} from "../../src/ProtocolConfig.sol";

contract ProtocolConfigTest is Fixtures {
    function test_rejectsFeeAboveCap() public {
        ProtocolConfig.Params memory params = config.getParams();
        params.feeBps = 1001;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.FeeTooHigh.selector, uint16(1001)));
        config.setParams(params);
    }

    function test_payoutScheduleMustSumToBps() public {
        uint16[] memory bad = new uint16[](2);
        bad[0] = 6000;
        bad[1] = 3000;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.PayoutScheduleNotExact.selector, uint256(9000)));
        config.setPayoutSchedule(bad);
    }

    function test_payoutScheduleCannotExceedMinSeats() public {
        uint16[] memory tooLong = new uint16[](5);
        tooLong[0] = 2000;
        tooLong[1] = 2000;
        tooLong[2] = 2000;
        tooLong[3] = 2000;
        tooLong[4] = 2000;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.PayoutScheduleTooLong.selector, uint256(5), uint16(4)));
        config.setPayoutSchedule(tooLong);
    }

    function test_cannotDropAttestorsBelowThreshold() public {
        vm.prank(owner);
        config.setAttestor(attestorC, false);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.ThresholdOutOfRange.selector, uint32(2), uint32(1)));
        config.setAttestor(attestorB, false);
        assertEq(config.attestorCount(), 2);
    }

    function test_onlyOwnerCanMutate() public {
        vm.expectRevert();
        config.setRulesHash(bytes32(uint256(1)));

        vm.expectRevert();
        config.setGuardian(address(this));
    }

    function test_guardianCanBeSetAndRemoved() public {
        address guardian = makeAddr("guardian");
        vm.startPrank(owner);
        vm.expectEmit(true, true, false, false, address(config));
        emit ProtocolConfig.GuardianUpdated(address(0), guardian);
        config.setGuardian(guardian);
        assertEq(config.guardian(), guardian);

        config.setGuardian(address(0));
        assertEq(config.guardian(), address(0));
        vm.stopPrank();
    }
}
