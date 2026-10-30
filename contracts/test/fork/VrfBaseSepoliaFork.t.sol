// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {ChainlinkVrfAdapter} from "../../src/oracles/ChainlinkVrfAdapter.sol";
import {IVRFCoordinatorV2Plus} from "../../src/vendor/chainlink/IVRFCoordinatorV2Plus.sol";

/// @dev Runs a lock against the real VRF v2.5 coordinator on Base Sepolia,
///      which is the only thing that proves the vendored request struct and
///      the native-payment `extraArgs` are what the coordinator accepts. The
///      unit suite runs against `MockVrfCoordinator` and cannot.
///
///      The test plays the Safe: it creates and funds a subscription in native
///      ETH and adds the adapter as a consumer. No node answers on a fork, so
///      the fulfilment is the coordinator's call, pranked.
///
///      Opt-in, because it needs an RPC:
///      `BASE_SEPOLIA_RPC_URL=… forge test --match-path test/fork/*`. Skipped otherwise.
contract VrfBaseSepoliaForkTest is Fixtures {
    IVRFCoordinatorV2Plus private constant COORDINATOR =
        IVRFCoordinatorV2Plus(0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE);
    /// @dev The 30 gwei lane, the only one on Base Sepolia.
    bytes32 private constant KEY_HASH = 0x9e1344a1247c8a1785d0a4681a27152bffdb43666ae5bf7d14d24a5efd44bf71;

    ChainlinkVrfAdapter private adapter;
    uint256 private subId;
    address private safe;

    function setUp() public override {
        string memory rpc = vm.envOr("BASE_SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        super.setUp();

        safe = makeAddr("safe");
        vm.deal(safe, 1 ether);
        vm.startPrank(safe);
        subId = COORDINATOR.createSubscription();
        COORDINATOR.fundSubscriptionWithNative{value: 0.5 ether}(subId);
        vm.stopPrank();

        adapter = new ChainlinkVrfAdapter(owner, COORDINATOR, KEY_HASH, subId, 3, 200_000);
        vm.prank(safe);
        COORDINATOR.addConsumer(subId, address(adapter));
        vm.startPrank(owner);
        adapter.setConsumer(address(escrow), true);
        config.setRandomnessOracle(address(adapter));
        vm.stopPrank();
    }

    function test_fork_theCoordinatorTakesTheRequestAndItsAnswerSeedsTheMatch() public {
        (, uint96 nativeBalance,, address subOwner, address[] memory consumers) =
            COORDINATOR.getSubscription(subId);
        assertEq(subOwner, safe);
        assertEq(nativeBalance, 0.5 ether);
        assertEq(consumers[0], address(adapter));

        bytes32 matchId = _createAndFill(4);
        uint256 vrfId = uint256(escrow.lockMatch(matchId));
        assertTrue(COORDINATOR.pendingRequestExists(subId));

        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256("node"));
        vm.prank(address(COORDINATOR));
        adapter.rawFulfillRandomWords(vrfId, words);

        GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
        assertEq(uint8(info.status), uint8(GameEscrow.MatchStatus.Live));
        assertEq(info.seed, keccak256(abi.encode(bytes32(words[0]), matchId)));
    }
}
