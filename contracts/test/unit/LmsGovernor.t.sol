// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";

import {LmsToken} from "../../src/governance/LmsToken.sol";
import {StakedLms} from "../../src/governance/StakedLms.sol";
import {LmsGovernor} from "../../src/governance/LmsGovernor.sol";

/// @dev The minimum quorum. Everything else in the governor is stock
///      OpenZeppelin and is exercised end to end in `DeployTest`.
contract LmsGovernorTest is Test {
    uint256 private constant SUPPLY = 100_000_000e18;
    uint256 private constant FLOOR = 1_000_000e18;
    string private constant DESCRIPTION = "Raise the floor";

    address private voter;
    LmsToken private lms;
    StakedLms private vault;
    TimelockController private timelock;
    LmsGovernor private governor;

    function setUp() public {
        voter = makeAddr("voter");
        lms = new LmsToken(address(this), SUPPLY);
        timelock = new TimelockController(0, new address[](0), new address[](1), address(this));
        vault = new StakedLms(lms, address(timelock), 7 days, 7 days);
        governor = new LmsGovernor(vault, timelock, 1 days, 5 days, 100_000e18, 4, FLOOR);
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));

        lms.transfer(voter, 10_000_000e18);
        vm.startPrank(voter);
        lms.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function test_quorum_isTheFloor_whileLittleIsStaked() public {
        _stake(2_000_000e18);
        // 4% of 2M is 80k: less than the proposal threshold.
        assertEq(governor.quorum(block.timestamp - 1), FLOOR);
    }

    function test_quorum_isTheFraction_onceEnoughIsStaked() public {
        _stake(10_000_000e18);
        assertEq(governor.quorum(block.timestamp - 1), FLOOR, "4% of 10M is still under the floor");

        lms.transfer(voter, 40_000_000e18);
        _stake(40_000_000e18);
        assertEq(governor.quorum(block.timestamp - 1), 2_000_000e18, "4% of 50M");
    }

    function test_setQuorumFloor_onlyThroughAProposal() public {
        vm.expectRevert(abi.encodeWithSelector(IGovernor.GovernorOnlyExecutor.selector, address(this)));
        governor.setQuorumFloor(0);
    }

    function test_constructor_capsTheFloorAtATenthOfTheSupply() public {
        uint256 max = SUPPLY / 10;
        assertEq(governor.maxQuorumFloor(), max);
        vm.expectRevert(abi.encodeWithSelector(LmsGovernor.QuorumFloorTooHigh.selector, max + 1, max));
        new LmsGovernor(vault, timelock, 1 days, 5 days, 100_000e18, 4, max + 1);
    }

    /// @dev Raising the floor by proposal leaves the quorum of a past
    ///      timepoint — a vote already under way — where it was.
    function test_setQuorumFloor_isCheckpointed() public {
        _stake(5_000_000e18);
        uint256 raised = 3_000_000e18;
        uint256 before = block.timestamp - 1;

        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(governor.setQuorumFloor, (raised));

        vm.prank(voter);
        uint256 id = governor.propose(targets, values, calls, DESCRIPTION);
        vm.warp(governor.proposalSnapshot(id) + 1);
        vm.prank(voter);
        governor.castVote(id, 1);
        vm.warp(governor.proposalDeadline(id) + 1);
        governor.queue(targets, values, calls, keccak256(bytes(DESCRIPTION)));
        governor.execute(targets, values, calls, keccak256(bytes(DESCRIPTION)));

        assertEq(governor.quorumFloor(), raised);
        assertEq(governor.quorumFloor(before), FLOOR);
        assertEq(governor.quorum(before), FLOOR);
        vm.warp(block.timestamp + 1);
        assertEq(governor.quorum(block.timestamp - 1), raised);
    }

    function _stake(uint256 amount) private {
        vm.prank(voter);
        vault.deposit(amount);
        vm.warp(block.timestamp + 1);
    }
}
