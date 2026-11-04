// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MultisigPhase} from "../../src/governance/MultisigPhase.sol";
import {LmsToken} from "../../src/governance/LmsToken.sol";
import {StakedLms} from "../../src/governance/StakedLms.sol";
import {LiquidityReserve} from "../../src/governance/LiquidityReserve.sol";
import {RewardsDistributor} from "../../src/governance/RewardsDistributor.sol";
import {BridgeJoinReceiver} from "../../src/periphery/BridgeJoinReceiver.sol";
import {ZeroAddress} from "../../src/Errors.sol";

/// @dev Something the timelock owns, with a setting to change.
contract Owned is Ownable {
    uint256 public value;

    constructor(address owner_) Ownable(owner_) {}

    function set(uint256 value_) external onlyOwner {
        value = value_;
    }
}

contract MultisigPhaseTest is Test {
    uint256 private constant DELAY = 3 days;
    uint256 private constant PHASE = 365 days;

    address private safe = makeAddr("safe");
    address private governor = makeAddr("governor");
    TimelockController private timelock;
    MultisigPhase private phase;
    Owned private target;
    LmsToken private lms;

    function setUp() public {
        address[] memory none = new address[](0);
        address[] memory anyone = new address[](1);
        timelock = new TimelockController(DELAY, none, anyone, address(this));
        lms = new LmsToken(address(timelock), 1_000_000e18);
        phase = new MultisigPhase(timelock, safe, address(lms), block.timestamp + PHASE);

        timelock.grantRole(timelock.PROPOSER_ROLE(), address(phase));
        timelock.grantRole(timelock.CANCELLER_ROLE(), address(phase));
        timelock.grantRole(timelock.PROPOSER_ROLE(), governor);
        timelock.grantRole(timelock.CANCELLER_ROLE(), governor);
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), address(this));

        target = new Owned(address(timelock));
    }

    function test_constructor_boundsThePhaseEnd() public {
        vm.expectRevert(abi.encodeWithSelector(MultisigPhase.InvalidPhaseEnd.selector, block.timestamp));
        new MultisigPhase(timelock, safe, address(lms), block.timestamp);

        uint256 tooLate = block.timestamp + 2 * 365 days + 1;
        vm.expectRevert(abi.encodeWithSelector(MultisigPhase.InvalidPhaseEnd.selector, tooLate));
        new MultisigPhase(timelock, safe, address(lms), tooLate);

        vm.expectRevert(ZeroAddress.selector);
        new MultisigPhase(timelock, address(0), address(lms), block.timestamp + PHASE);

        vm.expectRevert(ZeroAddress.selector);
        new MultisigPhase(timelock, safe, address(0), block.timestamp + PHASE);
    }

    function test_safeSchedules_throughTheDelay_andAnyoneExecutes() public {
        bytes memory call = abi.encodeCall(Owned.set, (7));
        vm.prank(safe);
        phase.schedule(address(target), 0, call, bytes32(0), bytes32(0), DELAY);

        vm.expectRevert();
        timelock.execute(address(target), 0, call, bytes32(0), bytes32(0));

        vm.warp(block.timestamp + DELAY);
        timelock.execute(address(target), 0, call, bytes32(0), bytes32(0));
        assertEq(target.value(), 7);
    }

    function test_scheduleBatch() public {
        address[] memory targets = new address[](1);
        targets[0] = address(target);
        uint256[] memory values = new uint256[](1);
        bytes[] memory payloads = new bytes[](1);
        payloads[0] = abi.encodeCall(Owned.set, (9));

        vm.prank(safe);
        phase.scheduleBatch(targets, values, payloads, bytes32(0), bytes32(0), DELAY);
        vm.warp(block.timestamp + DELAY);
        timelock.executeBatch(targets, values, payloads, bytes32(0), bytes32(0));
        assertEq(target.value(), 9);
    }

    function test_onlyTheSafe() public {
        bytes memory call = abi.encodeCall(Owned.set, (1));
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MultisigPhase.NotSafe.selector, stranger));
        phase.schedule(address(target), 0, call, bytes32(0), bytes32(0), DELAY);
        vm.expectRevert(abi.encodeWithSelector(MultisigPhase.NotSafe.selector, stranger));
        phase.cancel(bytes32(0));
        vm.stopPrank();
    }

    function test_theSafeHoldsNoRoleItself() public {
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), safe));
        assertFalse(timelock.hasRole(timelock.CANCELLER_ROLE(), safe));

        bytes32 role = timelock.CANCELLER_ROLE();
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, safe, role)
        );
        timelock.cancel(bytes32(0));
    }

    /// @dev The veto: a governor proposal, queued, cancelled by the Safe.
    function test_safeVetoesAGovernorProposal_beforeTheEnd() public {
        bytes memory call = abi.encodeCall(Owned.set, (3));
        vm.prank(governor);
        timelock.schedule(address(target), 0, call, bytes32(0), bytes32(0), DELAY);
        bytes32 id = timelock.hashOperation(address(target), 0, call, bytes32(0), bytes32(0));

        vm.prank(safe);
        phase.cancel(id);
        assertFalse(timelock.isOperation(id));
    }

    function test_afterTheEnd_theSafeCanNeitherScheduleNorCancel() public {
        bytes memory call = abi.encodeCall(Owned.set, (3));
        vm.prank(governor);
        timelock.schedule(address(target), 0, call, bytes32(0), bytes32(0), DELAY);
        bytes32 id = timelock.hashOperation(address(target), 0, call, bytes32(0), bytes32(0));

        uint256 end = phase.phaseEnd();
        vm.warp(end);
        vm.startPrank(safe);
        vm.expectRevert(abi.encodeWithSelector(MultisigPhase.PhaseOver.selector, end));
        phase.cancel(id);
        vm.expectRevert(abi.encodeWithSelector(MultisigPhase.PhaseOver.selector, end));
        phase.schedule(address(target), 0, call, bytes32(0), bytes32(uint256(1)), DELAY);
        vm.stopPrank();

        timelock.execute(address(target), 0, call, bytes32(0), bytes32(0));
        assertEq(target.value(), 3, "the governor's proposal went through");
    }

    function test_retire_onlyAfterTheEnd_byAnyone_dropsBothRoles() public {
        uint256 end = phase.phaseEnd();
        vm.expectRevert(abi.encodeWithSelector(MultisigPhase.PhaseNotOver.selector, end));
        phase.retire();

        vm.warp(end);
        vm.prank(makeAddr("anyone"));
        phase.retire();
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), address(phase)));
        assertFalse(timelock.hasRole(timelock.CANCELLER_ROLE(), address(phase)));
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), governor), "governance carries on");
    }

    /// @dev A call that would only be ready after the phase is refused, batches included.
    function test_cannotScheduleACallReadyAfterTheEnd() public {
        uint256 end = phase.phaseEnd();
        bytes memory call = abi.encodeCall(Owned.set, (1));

        vm.warp(end - DELAY + 1);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(MultisigPhase.ReadyAfterPhase.selector, end + 1, end));
        phase.schedule(address(target), 0, call, bytes32(0), bytes32(0), DELAY);

        address[] memory targets = new address[](1);
        targets[0] = address(target);
        uint256[] memory values = new uint256[](1);
        bytes[] memory payloads = new bytes[](1);
        payloads[0] = call;
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(MultisigPhase.ReadyAfterPhase.selector, end + 1, end));
        phase.scheduleBatch(targets, values, payloads, bytes32(0), bytes32(0), DELAY);

        vm.warp(end - DELAY);
        vm.prank(safe);
        phase.schedule(address(target), 0, call, bytes32(0), bytes32(0), DELAY);
    }

    /// @dev The call the check alone cannot stop: ready before the end, left
    ///      unexecuted, and otherwise runnable by anyone for ever after.
    function test_retire_cancelsADormantCall() public {
        bytes memory call = abi.encodeCall(Owned.set, (666));
        vm.prank(safe);
        phase.schedule(address(target), 0, call, bytes32(0), bytes32(0), DELAY);
        bytes32 id = timelock.hashOperation(address(target), 0, call, bytes32(0), bytes32(0));

        vm.warp(phase.phaseEnd() + 400 days);
        assertTrue(timelock.isOperationReady(id), "ready, long after the phase");
        phase.retire();

        assertFalse(timelock.isOperation(id));
        vm.expectRevert();
        timelock.execute(address(target), 0, call, bytes32(0), bytes32(0));
        assertEq(target.value(), 0);
    }

    function test_retire_cancelsADormantBatch() public {
        address[] memory targets = new address[](1);
        targets[0] = address(target);
        uint256[] memory values = new uint256[](1);
        bytes[] memory payloads = new bytes[](1);
        payloads[0] = abi.encodeCall(Owned.set, (666));
        vm.prank(safe);
        phase.scheduleBatch(targets, values, payloads, bytes32(0), bytes32(0), DELAY);
        bytes32 id = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), bytes32(0));

        vm.warp(phase.phaseEnd());
        phase.retire();
        assertFalse(timelock.isOperation(id));
    }

    /// @dev Executed and already cancelled calls are skipped: cancelling either would revert.
    function test_retire_skipsWhatIsNoLongerPending() public {
        bytes memory executed = abi.encodeCall(Owned.set, (1));
        bytes memory cancelled = abi.encodeCall(Owned.set, (2));
        vm.startPrank(safe);
        phase.schedule(address(target), 0, executed, bytes32(0), bytes32(0), DELAY);
        phase.schedule(address(target), 0, cancelled, bytes32(0), bytes32(0), DELAY);
        phase.cancel(timelock.hashOperation(address(target), 0, cancelled, bytes32(0), bytes32(0)));
        // Scheduled again after its cancellation, so its id is listed twice.
        phase.schedule(address(target), 0, cancelled, bytes32(0), bytes32(0), DELAY);
        vm.stopPrank();

        vm.warp(block.timestamp + DELAY);
        timelock.execute(address(target), 0, executed, bytes32(0), bytes32(0));

        vm.warp(phase.phaseEnd());
        phase.retire();
        assertEq(target.value(), 1);
        assertTrue(
            timelock.isOperationDone(
                timelock.hashOperation(address(target), 0, executed, bytes32(0), bytes32(0))
            )
        );
        assertFalse(
            timelock.isOperation(
                timelock.hashOperation(address(target), 0, cancelled, bytes32(0), bytes32(0))
            )
        );
    }

    /// @dev Only what went through the phase: the governor's queue is not the Safe's to clear.
    function test_retire_leavesTheGovernorsProposalsAlone() public {
        bytes memory call = abi.encodeCall(Owned.set, (3));
        vm.prank(governor);
        timelock.schedule(address(target), 0, call, bytes32(0), bytes32(0), DELAY);
        bytes32 id = timelock.hashOperation(address(target), 0, call, bytes32(0), bytes32(0));

        vm.warp(phase.phaseEnd());
        phase.retire();
        assertTrue(timelock.isOperationReady(id));
    }

    /// @dev Thousands of calls cannot block `retire`: anyone can clear them in pieces first.
    function test_cancelLeftovers_inPieces_thenRetire() public {
        bytes32[] memory ids = new bytes32[](5);
        for (uint256 i = 0; i < ids.length; ++i) {
            bytes32 salt = bytes32(i);
            bytes memory call = abi.encodeCall(Owned.set, (i));
            vm.prank(safe);
            phase.schedule(address(target), 0, call, bytes32(0), salt, DELAY);
            ids[i] = timelock.hashOperation(address(target), 0, call, bytes32(0), salt);
        }

        uint256 end = phase.phaseEnd();
        vm.expectRevert(abi.encodeWithSelector(MultisigPhase.PhaseNotOver.selector, end));
        phase.cancelLeftovers(1);

        vm.warp(end);
        phase.cancelLeftovers(2);
        assertEq(phase.leftoversChecked(), 2);
        assertFalse(timelock.isOperation(ids[1]));
        assertTrue(timelock.isOperation(ids[2]));

        phase.cancelLeftovers(type(uint256).max);
        assertEq(phase.leftoversChecked(), ids.length);
        assertFalse(timelock.isOperation(ids[4]));

        phase.retire();
        assertFalse(timelock.hasRole(timelock.CANCELLER_ROLE(), address(phase)));
    }

    /// @dev "Remove the multisig's veto" revokes the role early, and the phase must still retire.
    function test_retire_stillWorks_withoutTheCancellerRole() public {
        bytes memory call = abi.encodeCall(Owned.set, (1));
        vm.prank(safe);
        phase.schedule(address(target), 0, call, bytes32(0), bytes32(0), DELAY);
        bytes32 id = timelock.hashOperation(address(target), 0, call, bytes32(0), bytes32(0));

        bytes32 role = timelock.CANCELLER_ROLE();
        vm.prank(address(timelock));
        timelock.revokeRole(role, address(phase));

        vm.warp(phase.phaseEnd());
        phase.retire();
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), address(phase)));
        assertTrue(timelock.isOperation(id), "nothing cancelled without the role");
    }

    /// @dev Granting itself a role, or a new proposer, goes through the
    ///      timelock as a call to itself.
    function test_cannotScheduleACallOnTheTimelock() public {
        bytes memory call = abi.encodeCall(timelock.grantRole, (timelock.PROPOSER_ROLE(), safe));
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                MultisigPhase.ForbiddenCall.selector, address(timelock), timelock.grantRole.selector
            )
        );
        phase.schedule(address(timelock), 0, call, bytes32(0), bytes32(0), DELAY);
    }

    function test_cannotMoveOrRenounceOwnership_evenInABatch() public {
        address[] memory targets = new address[](2);
        targets[0] = address(target);
        targets[1] = address(target);
        uint256[] memory values = new uint256[](2);
        bytes[] memory payloads = new bytes[](2);
        payloads[0] = abi.encodeCall(Owned.set, (1));
        payloads[1] = abi.encodeCall(Ownable.transferOwnership, (safe));

        vm.startPrank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                MultisigPhase.ForbiddenCall.selector, address(target), Ownable.transferOwnership.selector
            )
        );
        phase.scheduleBatch(targets, values, payloads, bytes32(0), bytes32(0), DELAY);

        bytes memory renounce = abi.encodeCall(Ownable.renounceOwnership, ());
        vm.expectRevert(
            abi.encodeWithSelector(
                MultisigPhase.ForbiddenCall.selector, address(target), Ownable.renounceOwnership.selector
            )
        );
        phase.schedule(address(target), 0, renounce, bytes32(0), bytes32(0), DELAY);
        vm.stopPrank();
    }

    /// @dev Any call on the token: a transfer of the treasury's LMS, or the
    ///      approval a stake of it would start with, even inside a batch.
    function test_cannotMoveTheTreasurysLms_evenInABatch() public {
        bytes memory transfer = abi.encodeCall(IERC20.transfer, (safe, 1e18));
        vm.startPrank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                MultisigPhase.ForbiddenCall.selector, address(lms), IERC20.transfer.selector
            )
        );
        phase.schedule(address(lms), 0, transfer, bytes32(0), bytes32(0), DELAY);

        address[] memory targets = new address[](2);
        targets[0] = address(target);
        targets[1] = address(lms);
        uint256[] memory values = new uint256[](2);
        bytes[] memory payloads = new bytes[](2);
        payloads[0] = abi.encodeCall(Owned.set, (1));
        payloads[1] = abi.encodeCall(IERC20.approve, (makeAddr("vault"), 1e18));
        vm.expectRevert(
            abi.encodeWithSelector(
                MultisigPhase.ForbiddenCall.selector, address(lms), IERC20.approve.selector
            )
        );
        phase.scheduleBatch(targets, values, payloads, bytes32(0), bytes32(0), DELAY);
        vm.stopPrank();
    }

    /// @dev The owner's ways to release LMS held elsewhere, on any target.
    function test_cannotReleaseLmsHeldElsewhere() public {
        address elsewhere = makeAddr("elsewhere");
        bytes[] memory calls = new bytes[](4);
        calls[0] = abi.encodeCall(RewardsDistributor.sweep, (safe));
        calls[1] = abi.encodeCall(StakedLms.sweepStray, (safe));
        calls[2] = abi.encodeCall(LiquidityReserve.setRecipient, (safe, true));
        calls[3] = abi.encodeCall(BridgeJoinReceiver.recover, (address(lms), safe, 1e18));

        vm.startPrank(safe);
        for (uint256 i = 0; i < calls.length; ++i) {
            vm.expectRevert(
                abi.encodeWithSelector(MultisigPhase.ForbiddenCall.selector, elsewhere, bytes4(calls[i]))
            );
            phase.schedule(elsewhere, 0, calls[i], bytes32(0), bytes32(0), DELAY);
        }
        vm.stopPrank();
    }

    /// @dev `recover` of anything but LMS stays the Safe's: the receiver's
    ///      stray ETH and other tokens.
    function test_recoverOfAnotherTokenOrEthIsAllowed() public {
        address elsewhere = makeAddr("elsewhere");
        vm.startPrank(safe);
        phase.schedule(
            elsewhere,
            0,
            abi.encodeCall(BridgeJoinReceiver.recover, (address(0), safe, 1 ether)),
            bytes32(0),
            bytes32(0),
            DELAY
        );
        phase.schedule(
            elsewhere,
            0,
            abi.encodeCall(BridgeJoinReceiver.recover, (makeAddr("weth"), safe, 1 ether)),
            bytes32(0),
            bytes32(0),
            DELAY
        );
        vm.stopPrank();
    }

    /// @dev A bare ETH transfer has no selector, and is allowed: the Safe may
    ///      spend the treasury's ETH.
    function test_aPlainTransferIsAllowed() public {
        vm.deal(address(timelock), 1 ether);
        address to = makeAddr("to");
        vm.prank(safe);
        phase.schedule(to, 1 ether, "", bytes32(0), bytes32(0), DELAY);
        vm.warp(block.timestamp + DELAY);
        timelock.execute(to, 1 ether, "", bytes32(0), bytes32(0));
        assertEq(to.balance, 1 ether);
    }
}
