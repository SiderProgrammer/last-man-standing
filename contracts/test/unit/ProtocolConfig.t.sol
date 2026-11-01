// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ProtocolConfig} from "../../src/ProtocolConfig.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {ZeroAddress} from "../../src/Errors.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

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

    function test_seatAndStakeRangesMustBeOrdered() public {
        ProtocolConfig.Params memory params = config.getParams();
        vm.startPrank(owner);

        params.minSeats = 1;
        vm.expectRevert(
            abi.encodeWithSelector(ProtocolConfig.InvalidSeatRange.selector, uint16(1), uint16(8))
        );
        config.setParams(params);
        (params.minSeats, params.maxSeats) = (4, 3);
        vm.expectRevert(
            abi.encodeWithSelector(ProtocolConfig.InvalidSeatRange.selector, uint16(4), uint16(3))
        );
        config.setParams(params);
        params.maxSeats = 257;
        vm.expectRevert(
            abi.encodeWithSelector(ProtocolConfig.InvalidSeatRange.selector, uint16(4), uint16(257))
        );
        config.setParams(params);
        params.maxSeats = 8;

        params.minStake = 0;
        vm.expectRevert(
            abi.encodeWithSelector(ProtocolConfig.InvalidStakeRange.selector, uint128(0), params.maxStake)
        );
        config.setParams(params);
        (params.minStake, params.maxStake) = (2 ether, 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                ProtocolConfig.InvalidStakeRange.selector, uint128(2 ether), uint128(1 ether)
            )
        );
        config.setParams(params);
        (params.minStake, params.maxStake) = (0.01 ether, 50 ether);

        params.treasury = address(0);
        vm.expectRevert(ZeroAddress.selector);
        config.setParams(params);
        vm.stopPrank();
    }

    /// @dev A schedule paying four places cannot outlive a cut to three-seat lobbies.
    function test_minSeatsCannotDropBelowThePaidPlaces() public {
        uint16[] memory four = new uint16[](4);
        (four[0], four[1], four[2], four[3]) = (4000, 3000, 2000, 1000);
        ProtocolConfig.Params memory params = config.getParams();
        params.minSeats = 3;

        vm.startPrank(owner);
        config.setPayoutSchedule(four);
        vm.expectRevert(
            abi.encodeWithSelector(ProtocolConfig.PayoutScheduleTooLong.selector, uint256(4), uint16(3))
        );
        config.setParams(params);
        vm.stopPrank();
    }

    function test_payoutScheduleCannotBeEmpty() public {
        vm.prank(owner);
        vm.expectRevert(ProtocolConfig.PayoutScheduleEmpty.selector);
        config.setPayoutSchedule(new uint16[](0));
    }

    function test_oracleAndLmsTokenCannotBeZero() public {
        vm.startPrank(owner);
        vm.expectRevert(ZeroAddress.selector);
        config.setRandomnessOracle(address(0));
        vm.expectRevert(ZeroAddress.selector);
        config.setLmsToken(address(0));
        vm.stopPrank();
    }

    function test_everyAttestorChangeIsANewVersion_andOldVersionsStay() public {
        uint32 first = config.attestorSetVersion();
        address d = makeAddr("d");
        vm.prank(owner);
        config.setAttestorSet(_attestors(attestorA, attestorB, d), 3);

        uint32 second = config.attestorSetVersion();
        assertEq(second, first + 1);
        assertTrue(config.isAttestor(d));
        assertFalse(config.isAttestor(attestorC));
        assertEq(config.attestorThreshold(), 3);

        assertTrue(config.isAttestorAt(first, attestorC));
        assertFalse(config.isAttestorAt(first, d));
        assertEq(config.thresholdOf(first), 2);
        assertEq(config.getAttestors(first)[2], attestorC);
    }

    function test_anAttestorSetHasNoDuplicatesOrZeroAddress() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.DuplicateAttestor.selector, attestorA));
        config.setAttestorSet(_attestors(attestorA, attestorB, attestorA), 2);
        vm.expectRevert(ZeroAddress.selector);
        config.setAttestorSet(_attestors(attestorA, attestorB, address(0)), 2);
        vm.stopPrank();
    }

    function test_onlyOwnerCanMutate() public {
        bytes memory notOwner =
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this));
        vm.expectRevert(notOwner);
        config.setRulesHash(bytes32(uint256(1)));

        vm.expectRevert(notOwner);
        config.setGuardian(address(this));

        vm.expectRevert(notOwner);
        config.setBridgeReceiver(address(this));
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
        // Nor is a window: with no quorum no result could ever settle.
        vm.expectRevert(GameEscrow.ConfigIncomplete.selector);
        unusable.createMatch(STAKE, 4);

        vm.prank(owner);
        fresh.setAttestorSet(_attestors(attestorA, attestorB, attestorC), 1);
        unusable.createMatch(STAKE, 4);
    }

    function test_thresholdMustBeBetweenOneAndTheAttestorCount() public {
        address[] memory set = _attestors(attestorA, attestorB, attestorC);
        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ProtocolConfig.ThresholdOutOfRange.selector, uint32(0), uint256(3))
        );
        config.setAttestorSet(set, 0);
        vm.expectRevert(
            abi.encodeWithSelector(ProtocolConfig.ThresholdOutOfRange.selector, uint32(4), uint256(3))
        );
        config.setAttestorSet(set, 4);
        config.setAttestorSet(set, 3);
        vm.stopPrank();
        assertEq(config.attestorThreshold(), 3);
    }

    /// @dev Owned by a timelock, the config refuses windows that would let a
    ///      queued change land on a match that was open when it was queued.
    function test_theOwnersDelayMustOutlastAMatch() public {
        uint256 delay = config.matchLifetime() + 1;
        TimelockController timelock = _timelock(delay);
        vm.prank(owner);
        config.transferOwnership(address(timelock));
        vm.prank(address(timelock));
        config.acceptOwnership();

        bytes memory tooShort = abi.encodeWithSelector(ProtocolConfig.DelayTooShort.selector, delay, delay);
        ProtocolConfig.Params memory params = config.getParams();
        params.joinWindow += 1;
        vm.prank(address(timelock));
        vm.expectRevert(tooShort);
        config.setParams(params);

        vm.prank(address(timelock));
        vm.expectRevert(tooShort);
        config.setChallengeWindow(CHALLENGE_WINDOW + 1);
    }

    function test_theConfigCannotBeHandedToATimelockWithAShortDelay() public {
        uint256 lifetime = config.matchLifetime();
        TimelockController timelock = _timelock(lifetime);
        vm.prank(owner);
        config.transferOwnership(address(timelock));

        vm.prank(address(timelock));
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.DelayTooShort.selector, lifetime, lifetime));
        config.acceptOwnership();
    }

    function test_matchLifetimeCoversEveryPhase() public view {
        ProtocolConfig.Params memory params = config.getParams();
        assertEq(
            config.matchLifetime(),
            uint256(params.joinWindow) + 10 minutes + 1 hours + params.settleWindow + CHALLENGE_WINDOW
                + 48 hours
        );
    }

    function _timelock(uint256 delay) private returns (TimelockController) {
        address[] memory none = new address[](0);
        return new TimelockController(delay, none, none, address(this));
    }

    function test_joinAndSettleWindowsAreBounded() public {
        ProtocolConfig.Params memory params = config.getParams();
        params.settleWindow = 30 days + 1;
        vm.prank(owner);
        vm.expectRevert(ProtocolConfig.InvalidWindow.selector);
        config.setParams(params);

        params.settleWindow = 1 hours;
        params.joinWindow = 30 days + 1;
        vm.prank(owner);
        vm.expectRevert(ProtocolConfig.InvalidWindow.selector);
        config.setParams(params);
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

    function test_bridgeReceiverCanBeSetAndRemoved() public {
        address receiver = makeAddr("receiver");
        vm.startPrank(owner);
        vm.expectEmit(true, true, false, false, address(config));
        emit ProtocolConfig.BridgeReceiverUpdated(bridge, receiver);
        config.setBridgeReceiver(receiver);
        assertEq(config.bridgeReceiver(), receiver);

        config.setBridgeReceiver(address(0));
        assertEq(config.bridgeReceiver(), address(0));
        vm.stopPrank();
    }
}
