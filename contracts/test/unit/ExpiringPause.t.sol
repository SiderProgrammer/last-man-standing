// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {ExpiringPause} from "../../src/ExpiringPause.sol";

/// @dev The guardian pauses at once but only for a week, and cannot renew a
///      pause back to back; governance extends or ends one. See `ExpiringPause`.
contract ExpiringPauseTest is Fixtures {
    address internal guardian;

    function setUp() public override {
        super.setUp();
        guardian = makeAddr("guardian");
        vm.prank(owner);
        config.setGuardian(guardian);
        vm.warp(1_000_000);
    }

    function test_aGuardianPauseEndsByItselfAfterAWeek() public {
        vm.expectEmit(address(escrow));
        emit ExpiringPause.Paused(guardian, uint64(block.timestamp) + 7 days);
        vm.prank(guardian);
        escrow.pause();
        assertTrue(escrow.paused());

        vm.warp(block.timestamp + 7 days - 1);
        assertTrue(escrow.paused());
        vm.warp(block.timestamp + 1);
        assertFalse(escrow.paused());
        // Nothing has to be called for play to resume.
        vm.prank(players[0]);
        escrow.createMatch(STAKE, 4);
    }

    function test_theGuardianWaitsAWeekAfterAPauseEndsBeforePausingAgain() public {
        vm.prank(guardian);
        escrow.pause();
        uint64 end = escrow.pausedUntil();

        vm.warp(end);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(ExpiringPause.GuardianCooldown.selector, end + 7 days));
        escrow.pause();

        vm.warp(end + 7 days);
        vm.prank(guardian);
        escrow.pause();
        assertTrue(escrow.paused());
    }

    function test_theGuardianCannotRenewAPauseThatIsStillOn() public {
        vm.prank(guardian);
        escrow.pause();
        uint64 end = escrow.pausedUntil();

        vm.warp(end - 1);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(ExpiringPause.GuardianCooldown.selector, end + 7 days));
        escrow.pause();
    }

    function test_theGuardianMayEndItsPauseEarly_whichStartsTheCooldown() public {
        vm.prank(guardian);
        escrow.pause();
        vm.warp(block.timestamp + 1 days);

        vm.expectEmit(address(escrow));
        emit ExpiringPause.Unpaused(guardian);
        vm.prank(guardian);
        escrow.unpause();
        assertFalse(escrow.paused());

        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(ExpiringPause.GuardianCooldown.selector, uint64(block.timestamp) + 7 days)
        );
        escrow.pause();
    }

    function test_governanceExtendsAPausePastAWeek_andTheGuardianCannotShortenIt() public {
        vm.prank(guardian);
        escrow.pause();

        uint64 until = uint64(block.timestamp + 30 days);
        vm.prank(owner);
        escrow.extendPause(until);
        assertEq(escrow.pausedUntil(), until);

        vm.warp(block.timestamp + 8 days);
        assertTrue(escrow.paused());
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(ExpiringPause.GuardianCooldown.selector, until + 7 days));
        escrow.pause();

        vm.prank(owner);
        escrow.unpause();
        assertFalse(escrow.paused());
    }

    function test_governanceMayPauseWithNoGuardianPauseFirst() public {
        vm.prank(owner);
        escrow.extendPause(uint64(block.timestamp + 1 hours));
        assertTrue(escrow.paused());
    }

    function test_anExtensionMustLengthenThePause() public {
        vm.prank(guardian);
        escrow.pause();
        uint64 current = escrow.pausedUntil();

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ExpiringPause.PauseNotExtended.selector, current, current));
        escrow.extendPause(current);

        vm.warp(current + 1 days);
        uint64 past = uint64(block.timestamp - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ExpiringPause.PauseNotExtended.selector, past, current));
        escrow.extendPause(past);
    }

    function test_onlyTheGuardianPauses_andOnlyGovernanceExtends() public {
        vm.prank(owner);
        vm.expectRevert(ExpiringPause.NotGuardian.selector);
        escrow.pause();

        vm.prank(players[0]);
        vm.expectRevert(ExpiringPause.NotGuardian.selector);
        escrow.pause();

        vm.prank(guardian);
        vm.expectRevert(ExpiringPause.NotGovernance.selector);
        escrow.extendPause(uint64(block.timestamp + 1 days));
    }

    function test_unpauseIsForTheGuardianOrGovernance_andOnlyWhilePaused() public {
        vm.prank(owner);
        vm.expectRevert(ExpiringPause.ExpectedPause.selector);
        escrow.unpause();

        vm.prank(guardian);
        escrow.pause();
        vm.prank(players[0]);
        vm.expectRevert(ExpiringPause.NotGovernance.selector);
        escrow.unpause();
    }
}
