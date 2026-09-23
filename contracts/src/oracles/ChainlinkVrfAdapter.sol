// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IRandomnessOracle, IRandomnessConsumer} from "../interfaces/IRandomnessOracle.sol";
import {IVrfCoordinator, IVrfConsumer} from "../interfaces/IVrfCoordinator.sol";
import {ZeroAddress} from "../Errors.sol";

/// @title ChainlinkVrfAdapter
/// @notice Presents a Chainlink VRF v2.5 subscription as `IRandomnessOracle`.
/// @dev The game escrow never talks to Chainlink directly. Swapping in a
///      drand relay or a testnet mock is a config change, not a rewrite.
contract ChainlinkVrfAdapter is Ownable, IRandomnessOracle, IVrfConsumer {
    struct Pending {
        address consumer;
        bytes32 ourId;
        bool fulfilled;
    }

    IVrfCoordinator public coordinator;
    bytes32 public keyHash;
    uint256 public subId;
    uint16 public confirmations;
    uint32 public callbackGasLimit;

    uint256 private localNonce;
    mapping(uint256 vrfId => Pending) public pending;
    mapping(bytes32 ourId => uint256 vrfId) public vrfIdOf;

    event CoordinatorUpdated(address indexed coordinator, bytes32 keyHash, uint256 subId);
    event RandomnessRequested(bytes32 indexed requestId, uint256 indexed vrfId, address indexed consumer);

    error NotCoordinator(address caller);
    error UnknownRequest(uint256 requestId);
    error AlreadyFulfilled(uint256 requestId);
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

    /// @inheritdoc IRandomnessOracle
    function requestRandomness(bytes32 context) external returns (bytes32 requestId) {
        uint256 vrfId = coordinator.requestRandomWords(keyHash, subId, confirmations, callbackGasLimit, 1);
        requestId = keccak256(abi.encode(address(this), context, localNonce++));
        pending[vrfId] = Pending({consumer: msg.sender, ourId: requestId, fulfilled: false});
        vrfIdOf[requestId] = vrfId;
        emit RandomnessRequested(requestId, vrfId, msg.sender);
    }

    /// @inheritdoc IVrfConsumer
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        if (msg.sender != address(coordinator)) revert NotCoordinator(msg.sender);

        Pending storage item = pending[requestId];
        if (item.consumer == address(0)) revert UnknownRequest(requestId);
        if (item.fulfilled) revert AlreadyFulfilled(requestId);
        if (randomWords.length == 0) revert NoWords();

        item.fulfilled = true;
        IRandomnessConsumer(item.consumer).fulfillRandomness(item.ourId, bytes32(randomWords[0]));
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
