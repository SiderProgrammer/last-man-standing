// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IRandomnessOracle, IRandomnessConsumer} from "../interfaces/IRandomnessOracle.sol";
import {IVrfCoordinator, IVrfConsumer} from "../interfaces/IVrfCoordinator.sol";
import {UnknownRequest, ZeroAddress} from "../Errors.sol";

/// @title ChainlinkVrfAdapter
/// @notice Presents a Chainlink VRF v2.5 subscription as `IRandomnessOracle`.
/// @dev The game escrow never talks to Chainlink directly. Swapping in a
///      drand relay or a testnet mock is a config change, not a rewrite.
///
///      Every request is billed to the protocol's subscription, so only
///      registered consumers — in practice the escrow — may make one. Left
///      open, anyone could drain the subscription one request at a time.
contract ChainlinkVrfAdapter is Ownable2Step, IRandomnessOracle, IVrfConsumer {
    struct Pending {
        address consumer;
        bytes32 ourId;
        bytes32 context;
    }

    IVrfCoordinator public coordinator;
    bytes32 public keyHash;
    uint256 public subId;
    uint16 public confirmations;
    uint32 public callbackGasLimit;

    uint256 private localNonce;
    /// @notice Requests still waiting on the coordinator. Cleared on fulfilment.
    mapping(uint256 vrfId => Pending) public pending;
    mapping(bytes32 ourId => uint256 vrfId) public vrfIdOf;
    /// @notice Contracts allowed to request randomness on the subscription.
    mapping(address consumer => bool allowed) public isConsumer;

    event CoordinatorUpdated(address indexed coordinator, bytes32 keyHash, uint256 subId);
    event ConsumerUpdated(address indexed consumer, bool allowed);
    event RandomnessRequested(bytes32 indexed requestId, uint256 indexed vrfId, address indexed consumer);

    error NotCoordinator(address caller);
    error NotConsumer(address caller);
    error NoWords();

    constructor(
        address owner_,
        IVrfCoordinator coordinator_,
        bytes32 keyHash_,
        uint256 subId_,
        uint16 confirmations_,
        uint32 callbackGasLimit_
    ) Ownable(owner_) {
        _setCoordinator(coordinator_, keyHash_, subId_, confirmations_, callbackGasLimit_);
    }

    function setCoordinator(
        IVrfCoordinator coordinator_,
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
    function requestRandomness(bytes32 context) external returns (bytes32 requestId) {
        if (!isConsumer[msg.sender]) revert NotConsumer(msg.sender);

        uint256 vrfId = coordinator.requestRandomWords(keyHash, subId, confirmations, callbackGasLimit, 1);
        requestId = keccak256(abi.encode(address(this), context, localNonce++));
        pending[vrfId] = Pending({consumer: msg.sender, ourId: requestId, context: context});
        vrfIdOf[requestId] = vrfId;
        emit RandomnessRequested(requestId, vrfId, msg.sender);
    }

    /// @inheritdoc IVrfConsumer
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        if (msg.sender != address(coordinator)) revert NotCoordinator(msg.sender);

        Pending memory item = pending[requestId];
        if (item.consumer == address(0)) revert UnknownRequest(bytes32(requestId));
        if (randomWords.length == 0) revert NoWords();

        // Cleared rather than flagged: a fulfilled request needs no record, and
        // a cleared entry already reads as unknown to a second callback.
        delete pending[requestId];
        delete vrfIdOf[item.ourId];
        IRandomnessConsumer(item.consumer).fulfillRandomness(item.context, bytes32(randomWords[0]));
    }

    function _setCoordinator(
        IVrfCoordinator coordinator_,
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
