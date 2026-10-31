// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {DeploySpoke} from "../../script/DeploySpoke.s.sol";
import {MockAcrossSpokePool} from "../../src/mocks/MockAcrossSpokePool.sol";

/// @dev Runs the real spoke deploy on the local spoke chain, where it brings
///      its own mock SpokePool. The environment is process-wide and suites
///      run in parallel, so this sets only what `Deploy.t.sol` sets to the
///      same value (`DEPLOYER_PK`) or what no other script reads (`HUB_*`),
///      and never `SPOKE_OWNER` or `SPOKE_POOL`.
contract DeploySpokeTest is Test {
    uint256 private constant DEPLOYER_PK = 0xDE9107;
    uint256 private constant HUB_CHAIN = 84_532;
    uint256 private constant LOCAL_SPOKE = 31_338;
    /// @dev Base Sepolia's WETH, from `config/across.json`.
    address private constant HUB_WETH = 0x4200000000000000000000000000000000000006;

    address private hubReceiver;
    DeploySpoke.SpokeDeployment private d;

    function setUp() public {
        hubReceiver = makeAddr("hubReceiver");
        vm.deal(vm.addr(DEPLOYER_PK), 10 ether);
        vm.setEnv("DEPLOYER_PK", vm.toString(DEPLOYER_PK));
        vm.setEnv("HUB_CHAIN_ID", vm.toString(HUB_CHAIN));
        vm.setEnv("HUB_RECEIVER", vm.toString(hubReceiver));

        vm.chainId(LOCAL_SPOKE);
        d = new DeploySpoke().run();
    }

    function test_theRouterBridgesToTheHubReceiver() public view {
        assertEq(address(d.router.spokePool()), d.spokePool);
        assertEq(d.router.weth(), d.weth);
        assertEq(d.router.hubChainId(), HUB_CHAIN);
        assertEq(d.router.hubReceiver(), hubReceiver);
        assertEq(d.router.hubWeth(), HUB_WETH, "the hub's WETH comes from the address book");
    }

    /// @dev A local node has no Across: the script brings a mock pool.
    function test_onALocalNode_theSpokePoolIsAMock() public view {
        assertEq(address(MockAcrossSpokePool(payable(d.spokePool)).weth()), d.weth);
        assertEq(d.avatars.owner(), vm.addr(DEPLOYER_PK));
    }

    function test_registryNamesEveryContract() public {
        string memory json = new DeploySpoke().registry(d);
        assertEq(vm.parseJsonUint(json, ".chainId"), LOCAL_SPOKE);
        assertEq(vm.parseJsonAddress(json, ".contracts.spokeRouter"), address(d.router));
        assertEq(vm.parseJsonAddress(json, ".contracts.acrossSpokePool"), d.spokePool);
        assertEq(vm.parseJsonAddress(json, ".contracts.weth"), d.weth);
        assertEq(vm.parseJsonAddress(json, ".contracts.avatars"), address(d.avatars));
    }

    function test_offALocalChain_theSpokeOwnerIsRequired() public {
        vm.chainId(421_614);
        DeploySpoke script = new DeploySpoke();
        vm.expectRevert(DeploySpoke.OwnerRequired.selector);
        script.run();
    }

    function test_theHubCannotBeThisChain() public {
        vm.chainId(HUB_CHAIN);
        DeploySpoke script = new DeploySpoke();
        vm.expectRevert(DeploySpoke.HubRequired.selector);
        script.run();
    }
}
