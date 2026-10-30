// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "../helpers/Fixtures.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {ChainlinkVrfAdapter} from "../../src/oracles/ChainlinkVrfAdapter.sol";
import {MockVrfCoordinator} from "../../src/mocks/MockVrfCoordinator.sol";
import {IVRFCoordinatorV2Plus} from "../../src/vendor/chainlink/IVRFCoordinatorV2Plus.sol";
import {VRFV2PlusClient} from "../../src/vendor/chainlink/VRFV2PlusClient.sol";
import {UnknownRequest} from "../../src/Errors.sol";

contract ChainlinkVrfAdapterTest is Fixtures {
    bytes32 internal constant KEY_HASH = keccak256("key hash");
    uint256 internal constant SUB_ID = 7;

    MockVrfCoordinator internal coordinator;
    ChainlinkVrfAdapter internal adapter;

    function setUp() public override {
        super.setUp();
        coordinator = new MockVrfCoordinator();
        adapter = new ChainlinkVrfAdapter(
            owner, IVRFCoordinatorV2Plus(address(coordinator)), KEY_HASH, SUB_ID, 3, 200_000
        );
        vm.startPrank(owner);
        config.setRandomnessOracle(address(adapter));
        adapter.setConsumer(address(escrow), true);
        vm.stopPrank();
    }

    function test_requestsOneWordPaidInNativeEth() public {
        bytes32 matchId = _createAndFill(4);
        escrow.lockMatch(matchId);

        (
            bytes32 keyHash,
            uint256 subId,
            uint16 requestConfirmations,
            uint32 callbackGasLimit,
            uint32 numWords,
            bytes memory extraArgs
        ) = coordinator.lastRequest();
        assertEq(keyHash, KEY_HASH);
        assertEq(subId, SUB_ID);
        assertEq(requestConfirmations, 3);
        assertEq(callbackGasLimit, 200_000);
        assertEq(numWords, 1);
        assertEq(
            extraArgs,
            abi.encodeWithSelector(bytes4(keccak256("VRF ExtraArgsV1")), VRFV2PlusClient.ExtraArgsV1(true))
        );
    }

    function test_deliversTheSeedToTheEscrow() public {
        bytes32 matchId = _createAndFill(4);
        uint256 vrfId = uint256(escrow.lockMatch(matchId));
        (address consumer,, bytes32 context,) = adapter.requests(vrfId);
        assertEq(consumer, address(escrow));
        assertEq(context, matchId);

        vm.expectEmit(address(adapter));
        emit ChainlinkVrfAdapter.RandomnessDelivered(vrfId);
        coordinator.fulfill(vrfId, uint256(keccak256("vrf")));

        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Live));
        assertEq(escrow.getMatch(matchId).seed, keccak256(abi.encode(keccak256("vrf"), matchId)));
        // A delivered request leaves nothing behind.
        (consumer,,,) = adapter.requests(vrfId);
        assertEq(consumer, address(0));
    }

    function test_refusesUnregisteredConsumers() public {
        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkVrfAdapter.NotConsumer.selector, players[0]));
        adapter.requestRandomness(bytes32(uint256(1)));
    }

    function test_onlyTheCoordinatorAnswers() public {
        bytes32 matchId = _createAndFill(4);
        uint256 vrfId = uint256(escrow.lockMatch(matchId));
        uint256[] memory words = new uint256[](1);

        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkVrfAdapter.NotCoordinator.selector, players[0]));
        adapter.rawFulfillRandomWords(vrfId, words);
    }

    /// @dev VRF does not retry a reverted callback, so the adapter never
    ///      reverts to the coordinator: an unknown, repeated or empty answer is
    ///      ignored.
    function test_theCallbackIgnoresAnUnknownRepeatedOrEmptyAnswer() public {
        bytes32 matchId = _createAndFill(4);
        uint256 vrfId = uint256(escrow.lockMatch(matchId));
        uint256[] memory words = new uint256[](1);
        words[0] = 2;

        vm.startPrank(address(coordinator));
        adapter.rawFulfillRandomWords(vrfId + 1, words);
        adapter.rawFulfillRandomWords(vrfId, new uint256[](0));
        vm.stopPrank();
        assertEq(uint8(escrow.getMatch(matchId).status), uint8(GameEscrow.MatchStatus.Pending));

        coordinator.fulfill(vrfId, 1);
        bytes32 seed = escrow.getMatch(matchId).seed;
        vm.prank(address(coordinator));
        adapter.rawFulfillRandomWords(vrfId, words);
        assertEq(escrow.getMatch(matchId).seed, seed);
    }

    /// @dev A consumer that reverts does not lose the word: it is stored, and
    ///      anyone can deliver it once the consumer accepts it.
    function test_aFailedDeliveryKeepsTheWordForARetry() public {
        RefusingConsumer consumer = new RefusingConsumer(adapter);
        vm.prank(owner);
        adapter.setConsumer(address(consumer), true);
        uint256 vrfId = consumer.ask(keccak256("context"));

        vm.recordLogs();
        coordinator.fulfill(vrfId, 5);
        assertEq(vm.getRecordedLogs()[0].topics[0], ChainlinkVrfAdapter.DeliveryFailed.selector);
        (, bool answered,, bytes32 word) = adapter.requests(vrfId);
        assertTrue(answered);
        assertEq(word, bytes32(uint256(5)));

        consumer.accept();
        vm.prank(players[3]);
        adapter.deliver(vrfId);
        assertEq(consumer.received(), bytes32(uint256(5)));
        assertEq(consumer.context(), keccak256("context"));

        vm.expectRevert(abi.encodeWithSelector(UnknownRequest.selector, bytes32(vrfId)));
        adapter.deliver(vrfId);
    }

    function test_deliverNeedsAnAnswer() public {
        bytes32 matchId = _createAndFill(4);
        uint256 vrfId = uint256(escrow.lockMatch(matchId));
        vm.expectRevert(abi.encodeWithSelector(ChainlinkVrfAdapter.NotAnswered.selector, vrfId));
        adapter.deliver(vrfId);
    }
}

/// @dev Refuses every delivery until told to accept.
contract RefusingConsumer {
    ChainlinkVrfAdapter private immutable adapter;
    bool private accepting;
    bytes32 public context;
    bytes32 public received;

    constructor(ChainlinkVrfAdapter adapter_) {
        adapter = adapter_;
    }

    function ask(bytes32 context_) external returns (uint256) {
        return uint256(adapter.requestRandomness(context_));
    }

    function accept() external {
        accepting = true;
    }

    function fulfillRandomness(bytes32 context_, bytes32 randomness) external {
        require(accepting, "not yet");
        context = context_;
        received = randomness;
    }
}
