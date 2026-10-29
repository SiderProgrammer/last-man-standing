// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {ProtocolConfig} from "../../src/ProtocolConfig.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";

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
        vm.expectRevert(
            abi.encodeWithSelector(ProtocolConfig.PayoutScheduleTooLong.selector, uint256(5), uint16(4))
        );
        config.setPayoutSchedule(tooLong);
    }

    function test_cannotDropAttestorsBelowThreshold() public {
        vm.prank(owner);
        config.setAttestor(attestorC, false);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ProtocolConfig.ThresholdOutOfRange.selector, uint32(2), uint32(1))
        );
        config.setAttestor(attestorB, false);
        assertEq(config.attestorCount(), 2);
    }

    function test_onlyOwnerCanMutate() public {
        vm.expectRevert();
        config.setRulesHash(bytes32(uint256(1)));

        vm.expectRevert();
        config.setGuardian(address(this));
    }

    function test_rejectsAZeroRulesHash() public {
        vm.prank(owner);
        vm.expectRevert(ProtocolConfig.InvalidRulesHash.selector);
        config.setRulesHash(bytes32(0));
    }

    function test_escrowRefusesLobbiesOnAnIncompleteConfig() public {
        uint16[] memory payout = new uint16[](1);
        payout[0] = 10_000;
        ProtocolConfig fresh = new ProtocolConfig(owner, config.getParams(), payout);
        GameEscrow unusable = new GameEscrow(fresh);

        vm.expectRevert(GameEscrow.ConfigIncomplete.selector);
        unusable.createMatch(STAKE, 4);

        // Rules alone are not enough: nothing could ever seed the match.
        bytes32 rulesHash = config.rulesHash();
        vm.prank(owner);
        fresh.setRulesHash(rulesHash);
        vm.expectRevert(GameEscrow.ConfigIncomplete.selector);
        unusable.createMatch(STAKE, 4);

        vm.prank(owner);
        fresh.setRandomnessOracle(address(oracle));
        // Nor is a seed: with no challenge window a result would pay out
        // before anyone could object to it.
        vm.expectRevert(GameEscrow.ConfigIncomplete.selector);
        unusable.createMatch(STAKE, 4);

        vm.prank(owner);
        fresh.setChallengeWindow(CHALLENGE_WINDOW);
        unusable.createMatch(STAKE, 4);
    }

    function test_challengeWindowIsBounded() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.InvalidChallengeWindow.selector, uint64(0)));
        config.setChallengeWindow(0);
        vm.expectRevert(
            abi.encodeWithSelector(ProtocolConfig.InvalidChallengeWindow.selector, uint64(8 days))
        );
        config.setChallengeWindow(8 days);
        vm.stopPrank();
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
