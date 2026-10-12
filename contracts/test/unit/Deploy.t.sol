// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {Deploy} from "../../script/Deploy.s.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {MockPoolManager} from "../../src/mocks/MockPoolManager.sol";

/// @dev Runs the real deploy script and checks where authority ends up. The
///      environment is process-wide and suites run in parallel, so every test
///      here sets the same values and no other suite reads them.
contract DeployTest is Test {
    uint256 private constant DEPLOYER_PK = 0xDE9107;

    address private deployer;
    address private safe;
    address private poolManager;
    Deploy.Deployment private d;

    function setUp() public {
        deployer = vm.addr(DEPLOYER_PK);
        safe = makeAddr("safe");
        vm.deal(deployer, 10 ether);
        vm.setEnv("DEPLOYER_PK", vm.toString(DEPLOYER_PK));
        vm.setEnv("SAFE", vm.toString(safe));
        poolManager = address(new MockPoolManager());
        vm.setEnv("POOL_MANAGER", vm.toString(poolManager));
        d = new Deploy().run();
    }

    function test_timelockOwnsConfig() public view {
        assertEq(d.config.owner(), address(d.timelock));
        assertEq(d.config.pendingOwner(), address(0));
        assertEq(d.timelock.getMinDelay(), 1 days);
    }

    function test_safeProposesAndCancels_deployerHoldsNothing() public view {
        TimelockController timelock = d.timelock;
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), safe));
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), safe));
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)));

        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), deployer));
        assertFalse(timelock.hasRole(timelock.CANCELLER_ROLE(), deployer));
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), deployer));
    }

    function test_safeHoldsGuardianTreasuryAndAvatars() public view {
        assertEq(d.config.guardian(), safe);
        assertEq(d.config.treasury(), safe);
        assertEq(d.avatars.owner(), safe);
    }

    function test_zapPointsAtEscrowAndPoolManager() public view {
        assertEq(address(d.zap.escrow()), address(d.escrow));
        assertEq(address(d.zap.poolManager()), poolManager);
    }

    function test_configChangeWaitsOutTheDelay() public {
        bytes memory call = abi.encodeCall(d.config.setAttestorThreshold, (1));

        vm.prank(deployer);
        vm.expectRevert();
        d.timelock.schedule(address(d.config), 0, call, bytes32(0), bytes32(0), 1 days);

        vm.prank(safe);
        d.timelock.schedule(address(d.config), 0, call, bytes32(0), bytes32(0), 1 days);

        vm.expectRevert();
        d.timelock.execute(address(d.config), 0, call, bytes32(0), bytes32(0));

        vm.warp(block.timestamp + 1 days);
        d.timelock.execute(address(d.config), 0, call, bytes32(0), bytes32(0));
        assertEq(d.config.attestorThreshold(), 1);
    }

    /// @dev Nothing in this suite sets `ORACLE`, so off a local node the script
    ///      must refuse rather than fall back to the anyone-picks-the-seed mock.
    function test_refusesTheMockOracleOffALocalChain() public {
        vm.chainId(11_155_111);
        Deploy script = new Deploy();
        vm.expectRevert(Deploy.MockOffLocal.selector);
        script.run();
    }

    function test_guardianPausesAtOnce_butCannotUnpause() public {
        vm.prank(safe);
        d.escrow.pause();
        assertTrue(d.escrow.paused());

        vm.prank(safe);
        vm.expectRevert(GameEscrow.NotGovernance.selector);
        d.escrow.unpause();
    }
}
