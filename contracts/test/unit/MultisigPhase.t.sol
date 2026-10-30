// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {MultisigPhase} from "../../src/governance/MultisigPhase.sol";
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

    function setUp() public {
        address[] memory none = new address[](0);
        address[] memory anyone = new address[](1);
        timelock = new TimelockController(DELAY, none, anyone, address(this));
        phase = new MultisigPhase(timelock, safe, block.timestamp + PHASE);

        timelock.grantRole(timelock.PROPOSER_ROLE(), address(phase));
        timelock.grantRole(timelock.CANCELLER_ROLE(), address(phase));
        timelock.grantRole(timelock.PROPOSER_ROLE(), governor);
        timelock.grantRole(timelock.CANCELLER_ROLE(), governor);
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), address(this));

        target = new Owned(address(timelock));
    }

    function test_constructor_boundsThePhaseEnd() public {
        vm.expectRevert(abi.encodeWithSelector(MultisigPhase.InvalidPhaseEnd.selector, block.timestamp));
        new MultisigPhase(timelock, safe, block.timestamp);

        uint256 tooLate = block.timestamp + 2 * 365 days + 1;
        vm.expectRevert(abi.encodeWithSelector(MultisigPhase.InvalidPhaseEnd.selector, tooLate));
        new MultisigPhase(timelock, safe, tooLate);

        vm.expectRevert(ZeroAddress.selector);
        new MultisigPhase(timelock, address(0), block.timestamp + PHASE);
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

    /// @dev A bare ETH transfer has no selector, and is allowed.
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
