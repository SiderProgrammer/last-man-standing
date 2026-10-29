// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {Deploy} from "../../script/Deploy.s.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {MockPoolManager} from "../../src/mocks/MockPoolManager.sol";
import {MockLayerZeroEndpoint} from "../../src/mocks/MockLayerZeroEndpoint.sol";
import {RewardsDistributor} from "../../src/governance/RewardsDistributor.sol";

/// @dev Reaches the script's chain-dependent defaults without running it.
contract DeployHarness is Deploy {
    function defaultStakerBps() external view returns (uint256) {
        return _defaultStakerBps();
    }

    function teamBeneficiary(address safe) external view returns (address) {
        return _teamBeneficiary(safe);
    }
}

/// @dev Runs the real deploy script and checks where authority ends up. The
///      environment is process-wide and suites run in parallel, so every test
///      here sets the same values and no other suite reads them.
contract DeployTest is Test {
    uint256 private constant DEPLOYER_PK = 0xDE9107;
    string private constant DESCRIPTION = "Move the guardian";

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
        vm.setEnv("MOCK_LZ", "true");
        d = new Deploy().run();
    }

    /// @dev Like the config: deployed by the script, then the timelock's,
    ///      accepted in the same batch that raised the delay.
    function test_hubMessengerServesTheEscrow_ownedAndConfiguredByTheTimelock() public view {
        assertTrue(address(d.hubLz) != address(0));
        assertEq(d.messenger, address(d.hubLz));
        assertEq(d.hubLz.app(), address(d.escrow));
        assertEq(d.hubLz.owner(), address(d.timelock));
        assertEq(d.hubLz.pendingOwner(), address(0));
        assertEq(
            MockLayerZeroEndpoint(address(d.hubLz.endpoint())).delegates(address(d.hubLz)),
            address(d.timelock)
        );
        assertEq(d.hubLz.receiveGas(), 350_000);
    }

    function test_timelockOwnsConfigVaultAndRouter() public view {
        assertEq(d.config.owner(), address(d.timelock));
        assertEq(d.config.pendingOwner(), address(0));
        assertEq(d.stakedLms.owner(), address(d.timelock));
        assertEq(d.feeRouter.owner(), address(d.timelock));
        assertEq(d.timelock.getMinDelay(), 1 days);
    }

    function test_governorProposes_safeOnlyCancels_deployerHoldsNothing() public view {
        TimelockController timelock = d.timelock;
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), address(d.governor)));
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), address(d.governor)));
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), safe));
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), safe));
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)));

        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), deployer));
        assertFalse(timelock.hasRole(timelock.CANCELLER_ROLE(), deployer));
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), deployer));
        assertEq(d.lms.balanceOf(deployer), 0);
        assertEq(d.stakedLms.balanceOf(deployer), 0);
    }

    function test_safeHoldsGuardianAvatarsAndTreasury_behindTheRouter() public view {
        assertEq(d.config.guardian(), safe);
        assertEq(d.avatars.owner(), safe);
        assertEq(d.config.treasury(), address(d.feeRouter));
        assertEq(d.feeRouter.treasury(), safe);
        assertEq(d.feeRouter.stakerBps(), 5_000);
    }

    function test_routerPaysTheVaultFromTheEscrow() public view {
        assertEq(address(d.feeRouter.escrow()), address(d.escrow));
        assertEq(address(d.feeRouter.vault()), address(d.stakedLms));
    }

    function test_supplyIsSplitAcrossTheFiveBuckets() public view {
        assertEq(d.lms.totalSupply(), 100_000_000e18);
        assertEq(d.lms.balanceOf(address(d.rewards)), 50_000_000e18, "play-mining");
        assertEq(d.lms.balanceOf(address(d.timelock)), 30_000_000e18, "treasury and reserve");
        assertEq(d.lms.balanceOf(address(d.teamVesting)), 15_000_000e18, "team");
        assertEq(d.lms.balanceOf(safe), 5_000_000e18, "liquidity");
        assertEq(d.lms.balanceOf(deployer), 0);
        assertEq(d.stakedLms.totalSupply(), 0, "nobody votes until play-mining pays: no seed either");
    }

    function test_teamVestsNothingForAYear_thenLinearlyOverThree() public {
        assertEq(d.teamVesting.owner(), safe, "the Safe stands in for the team on a local node");
        // `_handOver` moves the dry run's clock from 1 to 2 after the wallet is made.
        assertApproxEqAbs(d.teamVesting.start(), block.timestamp + 365 days, 1);
        assertEq(d.teamVesting.duration(), 3 * 365 days);

        address lms = address(d.lms);
        uint256 start = d.teamVesting.start();
        vm.warp(start);
        assertEq(d.teamVesting.releasable(lms), 0);
        vm.warp(start + (3 * 365 days) / 2);
        assertEq(d.teamVesting.releasable(lms), 7_500_000e18);
    }

    function test_playMiningIsWiredToTheEscrowAndFundedForItsBudget() public view {
        RewardsDistributor rewards = d.rewards;
        assertEq(rewards.owner(), address(d.timelock));
        assertEq(address(rewards.escrow()), address(d.escrow));
        assertEq(address(rewards.vault()), address(d.stakedLms));
        assertEq(rewards.firstEpoch(), block.timestamp / 7 days + 1, "the first full week after the deploy");
        assertEq(rewards.maxRewardPerEth(), 100_000e18);

        uint256 budget = rewards.totalBudget();
        assertLe(budget, d.lms.balanceOf(address(rewards)));
        assertApproxEqAbs(budget, 50_000_000e18, 1e6, "only rounding is left over");
    }

    function test_minimumStakeAndQuorumFloorSuitL1() public view {
        assertEq(d.config.getParams().minStake, 0.01 ether);
        assertEq(d.governor.quorumFloor(), 1_000_000e18);
        assertEq(d.governor.quorum(block.timestamp - 1), 1_000_000e18, "nothing staked: the floor applies");
    }

    function test_mainnetStartsWithNoFeeShareForStakers() public {
        DeployHarness harness = new DeployHarness();
        assertEq(harness.defaultStakerBps(), 5_000);
        vm.chainId(1);
        assertEq(harness.defaultStakerBps(), 0);
    }

    function test_offALocalChain_theTeamBeneficiaryIsRequired() public {
        DeployHarness harness = new DeployHarness();
        assertEq(harness.teamBeneficiary(safe), safe);
        vm.chainId(1);
        vm.expectRevert(Deploy.TeamBeneficiaryRequired.selector);
        harness.teamBeneficiary(safe);
    }

    function test_governorVotesWithStakedLms_andCooldownOutlastsExposure() public view {
        assertEq(address(d.governor.token()), address(d.stakedLms));
        assertEq(d.governor.timelock(), address(d.timelock));
        assertGt(d.stakedLms.cooldown(), d.governor.votingPeriod() + d.timelock.getMinDelay());
    }

    function test_zapPointsAtEscrowAndPoolManager() public view {
        assertEq(address(d.zap.escrow()), address(d.escrow));
        assertEq(address(d.zap.poolManager()), poolManager);
    }

    function test_safeCannotScheduleDirectly() public {
        bytes memory call = abi.encodeCall(d.config.setGuardian, (deployer));
        bytes32 role = d.timelock.PROPOSER_ROLE();

        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, safe, role)
        );
        d.timelock.schedule(address(d.config), 0, call, bytes32(0), bytes32(0), 1 days);
    }

    function test_proposal_stakeVoteQueueWaitExecute() public {
        address newGuardian = makeAddr("newGuardian");
        (uint256 id, address[] memory targets, uint256[] memory values, bytes[] memory calls) =
            _passGuardianProposal(newGuardian);

        d.governor.queue(targets, values, calls, keccak256(bytes(DESCRIPTION)));
        assertEq(uint8(d.governor.state(id)), uint8(IGovernor.ProposalState.Queued));

        bytes32 salt = bytes20(address(d.governor)) ^ keccak256(bytes(DESCRIPTION));
        bytes32 operation = d.timelock.hashOperationBatch(targets, values, calls, bytes32(0), salt);
        vm.expectRevert(
            abi.encodeWithSelector(
                TimelockController.TimelockUnexpectedOperationState.selector,
                operation,
                bytes32(1 << uint8(TimelockController.OperationState.Ready))
            )
        );
        d.governor.execute(targets, values, calls, keccak256(bytes(DESCRIPTION)));

        vm.warp(block.timestamp + d.timelock.getMinDelay());
        d.governor.execute(targets, values, calls, keccak256(bytes(DESCRIPTION)));

        assertEq(d.config.guardian(), newGuardian);
        assertEq(uint8(d.governor.state(id)), uint8(IGovernor.ProposalState.Executed));
    }

    function test_proposal_safeCanVetoWhileQueued() public {
        (uint256 id, address[] memory targets, uint256[] memory values, bytes[] memory calls) =
            _passGuardianProposal(makeAddr("newGuardian"));
        bytes32 descriptionHash = keccak256(bytes(DESCRIPTION));
        d.governor.queue(targets, values, calls, descriptionHash);

        // `GovernorTimelockControl` salts each operation with its own address.
        bytes32 salt = bytes20(address(d.governor)) ^ descriptionHash;
        bytes32 operation = d.timelock.hashOperationBatch(targets, values, calls, bytes32(0), salt);
        vm.prank(safe);
        d.timelock.cancel(operation);

        assertEq(uint8(d.governor.state(id)), uint8(IGovernor.ProposalState.Canceled));
        vm.warp(block.timestamp + d.timelock.getMinDelay());
        vm.expectRevert(
            abi.encodeWithSelector(
                IGovernor.GovernorUnexpectedProposalState.selector,
                id,
                IGovernor.ProposalState.Canceled,
                bytes32(
                    (1 << uint8(IGovernor.ProposalState.Succeeded))
                        | (1 << uint8(IGovernor.ProposalState.Queued))
                )
            )
        );
        d.governor.execute(targets, values, calls, descriptionHash);
        assertEq(d.config.guardian(), safe);
    }

    function test_proposal_unstakedLmsCannotVote() public {
        address holder = makeAddr("holder");
        vm.prank(safe);
        d.lms.transfer(holder, 1_000_000e18);
        vm.warp(block.timestamp + 1);

        assertEq(d.governor.getVotes(holder, block.timestamp - 1), 0);
        uint256 threshold = d.governor.proposalThreshold();
        vm.prank(holder);
        vm.expectRevert(
            abi.encodeWithSelector(IGovernor.GovernorInsufficientProposerVotes.selector, holder, 0, threshold)
        );
        d.governor.propose(new address[](1), new uint256[](1), new bytes[](1), DESCRIPTION);
    }

    /// @dev A lobby can open straight away, and the Safe that may veto a
    ///      result during the window is the guardian.
    function test_settlementIsWiredAndTheSafeMayVeto() public view {
        assertTrue(d.config.isComplete());
        assertEq(d.config.challengeWindow(), 1 hours);
        assertTrue(d.config.isAttestor(deployer));
        assertEq(d.config.guardian(), safe);
    }

    /// @dev `config/rules.json` → `Deploy` → the deployed hash, pinned to the
    ///      same vector `parity.test.ts` pins `hashRules(DEFAULT_RULES)` to.
    function test_deploysTheRulesTheServerPlays() public view {
        assertEq(d.config.rulesHash(), 0x07d102f371d483468baf28515199dc3b888d3604c16f48ae909ab07145044d93);
    }

    /// @dev Nothing in this suite sets `ORACLE`, so off a local node the script
    ///      must refuse rather than fall back to the anyone-picks-the-seed mock.
    function test_requiresARealOracleOffALocalChain() public {
        vm.chainId(11_155_111);
        Deploy script = new Deploy();
        vm.expectRevert(Deploy.OracleRequired.selector);
        script.run();
    }

    /// @dev `MOCKS=true` off a local node must be refused.
    function test_refusesTheMocksOffALocalChain() public {
        vm.chainId(11_155_111);
        Deploy script = new DeployWithMocks();
        vm.expectRevert(Deploy.MockOffLocal.selector);
        script.run();
    }

    /// @dev What the server reads; `setUp`'s run never wrote the file itself.
    ///      Built from that run rather than a fresh one, which would read
    ///      `config/rules.json` by absolute path and so cost gas that depends
    ///      on where the repository is checked out.
    function test_registryNamesEveryContract() public {
        Deploy.Deployment memory deployment = d;
        string memory json = new Deploy().registry(deployment);

        assertEq(vm.parseJsonUint(json, ".chainId"), block.chainid);
        assertEq(vm.parseJsonUint(json, ".deployBlock"), block.number);
        assertEq(vm.parseJsonAddress(json, ".contracts.escrow"), address(deployment.escrow));
        assertEq(vm.parseJsonAddress(json, ".contracts.config"), address(deployment.config));
        assertEq(vm.parseJsonAddress(json, ".contracts.governor"), address(deployment.governor));
        assertEq(vm.parseJsonAddress(json, ".contracts.timelock"), address(deployment.timelock));
        assertEq(vm.parseJsonAddress(json, ".contracts.zapJoin"), address(deployment.zap));
        assertEq(vm.parseJsonAddress(json, ".contracts.messenger"), deployment.messenger);
        assertEq(vm.parseJsonAddress(json, ".contracts.randomnessOracle"), deployment.oracle);
        assertEq(vm.parseJsonKeys(json, ".contracts").length, 15);
        assertFalse(vm.exists("deployments/31337.json"));
    }

    function test_guardianPausesAtOnce_forAWeek() public {
        vm.prank(safe);
        d.escrow.pause();
        assertTrue(d.escrow.paused());

        vm.warp(block.timestamp + d.escrow.GUARDIAN_PAUSE());
        assertFalse(d.escrow.paused());
    }

    /// @dev The Safe stakes enough of its supply to clear the threshold and
    ///      quorum on its own, proposes, and votes for it. Returns at the end
    ///      of the voting period, with the proposal `Succeeded`.
    function _passGuardianProposal(address newGuardian)
        private
        returns (uint256 id, address[] memory targets, uint256[] memory values, bytes[] memory calls)
    {
        vm.startPrank(safe);
        d.lms.approve(address(d.stakedLms), 1_000_000e18);
        d.stakedLms.deposit(1_000_000e18, safe);
        vm.stopPrank();
        // Votes are read one tick in the past.
        vm.warp(block.timestamp + 1);

        targets = new address[](1);
        targets[0] = address(d.config);
        values = new uint256[](1);
        calls = new bytes[](1);
        calls[0] = abi.encodeCall(d.config.setGuardian, (newGuardian));

        vm.prank(safe);
        id = d.governor.propose(targets, values, calls, DESCRIPTION);

        vm.warp(d.governor.proposalSnapshot(id) + 1);
        vm.prank(safe);
        d.governor.castVote(id, 1);

        vm.warp(d.governor.proposalDeadline(id) + 1);
        assertEq(uint8(d.governor.state(id)), uint8(IGovernor.ProposalState.Succeeded));
    }
}

/// @dev `Deploy` as if run with `MOCKS=true`.
contract DeployWithMocks is Deploy {
    function _mocks(bool) internal pure override returns (bool) {
        return true;
    }
}
