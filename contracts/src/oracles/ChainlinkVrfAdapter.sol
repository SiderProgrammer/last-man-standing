// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IRandomnessOracle, IRandomnessConsumer} from "../interfaces/IRandomnessOracle.sol";
import {IVRFCoordinatorV2Plus} from "../vendor/chainlink/IVRFCoordinatorV2Plus.sol";
import {VRFV2PlusClient} from "../vendor/chainlink/VRFV2PlusClient.sol";
import {UnknownRequest, ZeroAddress} from "../Errors.sol";

/// @title ChainlinkVrfAdapter
/// @notice Presents a Chainlink VRF v2.5 subscription as `IRandomnessOracle`.
/// @dev The game escrow never talks to Chainlink directly. Swapping in a
///      drand relay or a testnet mock is a config change, not a rewrite.
///
///      Requests are paid in native ETH (`nativePayment: true`), so nobody has
///      to keep LINK topped up. The subscription belongs to the Safe; this
///      adapter is one of its consumers. Every request is billed to that
///      subscription, so only registered consumers — in practice the escrow —
///      may make one. Left open, anyone could drain it one request at a time.
///
///      The coordinator's callback never reverts. VRF does not retry a failed
///      fulfilment, so a revert would lose the word for good. The word is
///      stored first and then delivered; if delivery fails, `deliver` retries
///      it, and anyone may call that.
contract ChainlinkVrfAdapter is Ownable2Step, IRandomnessOracle {
    struct Request {
        address consumer;
        /// @dev Set once the coordinator answers. A word can be zero.
        bool answered;
        bytes32 context;
        bytes32 word;
    }

    IVRFCoordinatorV2Plus public coordinator;
    bytes32 public keyHash;
    uint256 public subId;
    uint16 public confirmations;
    uint32 public callbackGasLimit;

    /// @notice Requests not yet delivered, by VRF request id. Cleared on delivery.
    mapping(uint256 vrfId => Request) public requests;
    /// @notice Contracts allowed to request randomness on the subscription.
    mapping(address consumer => bool allowed) public isConsumer;

    event CoordinatorUpdated(address indexed coordinator, bytes32 keyHash, uint256 subId);
    event ConsumerUpdated(address indexed consumer, bool allowed);
    event RandomnessRequested(uint256 indexed vrfId, address indexed consumer, bytes32 context);
    event RandomnessDelivered(uint256 indexed vrfId);
    /// @notice The consumer reverted on delivery. The word is kept for `deliver`.
    event DeliveryFailed(uint256 indexed vrfId, bytes reason);

    error NotCoordinator(address caller);
    error NotConsumer(address caller);
    error NotAnswered(uint256 vrfId);

    constructor(
        address owner_,
        IVRFCoordinatorV2Plus coordinator_,
        bytes32 keyHash_,
        uint256 subId_,
        uint16 confirmations_,
        uint32 callbackGasLimit_
    ) Ownable(owner_) {
        _setCoordinator(coordinator_, keyHash_, subId_, confirmations_, callbackGasLimit_);
    }

    function setCoordinator(
        IVRFCoordinatorV2Plus coordinator_,
        bytes32 keyHash_,
        uint256 subId_,
        uint16 confirmations_,
        uint32 callbackGasLimit_
    ) external onlyOwner {
        _setCoordinator(coordinator_, keyHash_, subId_, confirmations_, callbackGasLimit_);
    }

    function setConsumer(address consumer, bool allowed) external onlyOwner {
        if (consumer == address(0)) revert ZeroAddress();
        isConsumer[consumer] = allowed;
        emit ConsumerUpdated(consumer, allowed);
    }

    /// @inheritdoc IRandomnessOracle
    /// @return requestId The VRF request id.
    function requestRandomness(bytes32 context) external returns (bytes32 requestId) {
        if (!isConsumer[msg.sender]) revert NotConsumer(msg.sender);

        uint256 vrfId = coordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subId,
                requestConfirmations: confirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: 1,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: true}))
            })
        );
        requests[vrfId] = Request({consumer: msg.sender, answered: false, context: context, word: bytes32(0)});
        emit RandomnessRequested(vrfId, msg.sender, context);
        return bytes32(vrfId);
    }

    /// @notice The coordinator's callback. Stores the word, then delivers it.
    /// @dev Reverts only for a caller other than the coordinator. An unknown
    ///      or repeated request, or an empty answer, is ignored.
    function rawFulfillRandomWords(uint256 vrfId, uint256[] calldata randomWords) external {
        if (msg.sender != address(coordinator)) revert NotCoordinator(msg.sender);

        Request storage request = requests[vrfId];
        if (request.consumer == address(0) || request.answered || randomWords.length == 0) return;
        request.answered = true;
        request.word = bytes32(randomWords[0]);
        _deliver(vrfId, request);
    }

    /// @notice Delivers a stored word whose delivery failed.
    /// @dev Permissionless: it can only hand the consumer the word the
    ///      coordinator gave, for the request it was given for.
    function deliver(uint256 vrfId) external {
        Request storage request = requests[vrfId];
        if (request.consumer == address(0)) revert UnknownRequest(bytes32(vrfId));
        if (!request.answered) revert NotAnswered(vrfId);
        _deliver(vrfId, request);
    }

    function _deliver(uint256 vrfId, Request storage request) private {
        try IRandomnessConsumer(request.consumer).fulfillRandomness(request.context, request.word) {
            delete requests[vrfId];
            emit RandomnessDelivered(vrfId);
        } catch (bytes memory reason) {
            emit DeliveryFailed(vrfId, reason);
        }
    }

    function _setCoordinator(
        IVRFCoordinatorV2Plus coordinator_,
        bytes32 keyHash_,
        uint256 subId_,
        uint16 confirmations_,
        uint32 callbackGasLimit_
    ) private {
        if (address(coordinator_) == address(0)) revert ZeroAddress();
        coordinator = coordinator_;
        keyHash = keyHash_;
        subId = subId_;
        confirmations = confirmations_;
        callbackGasLimit = callbackGasLimit_;
        emit CoordinatorUpdated(address(coordinator_), keyHash_, subId_);
    }
}
