// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {VRFV2PlusClient} from "./VRFV2PlusClient.sol";

// Vendored from smartcontractkit/chainlink, contracts/src/v0.8/vrf/dev/interfaces/
// IVRFSubscriptionV2Plus.sol and IVRFCoordinatorV2Plus.sol (@chainlink/contracts 1.x),
// merged into one file and run through forge fmt. Signatures unchanged.

/// @notice The IVRFSubscriptionV2Plus interface defines the subscription
/// @notice related methods implemented by the V2Plus coordinator.
interface IVRFSubscriptionV2Plus {
    /**
     * @notice Add a consumer to a VRF subscription.
     * @param subId - ID of the subscription
     * @param consumer - New consumer which can use the subscription
     */
    function addConsumer(uint256 subId, address consumer) external;

    /**
     * @notice Remove a consumer from a VRF subscription.
     * @param subId - ID of the subscription
     * @param consumer - Consumer to remove from the subscription
     */
    function removeConsumer(uint256 subId, address consumer) external;

    /**
     * @notice Cancel a subscription
     * @param subId - ID of the subscription
     * @param to - Where to send the remaining LINK to
     */
    function cancelSubscription(uint256 subId, address to) external;

    /**
     * @notice Accept subscription owner transfer.
     * @param subId - ID of the subscription
     * @dev will revert if original owner of subId has
     * not requested that msg.sender become the new owner.
     */
    function acceptSubscriptionOwnerTransfer(uint256 subId) external;

    /**
     * @notice Request subscription owner transfer.
     * @param subId - ID of the subscription
     * @param newOwner - proposed new owner of the subscription
     */
    function requestSubscriptionOwnerTransfer(uint256 subId, address newOwner) external;

    /**
     * @notice Create a VRF subscription.
     * @return subId - A unique subscription id.
     * @dev You can manage the consumer set dynamically with addConsumer/removeConsumer.
     * @dev Note to fund the subscription with LINK, use transferAndCall. For example
     * @dev  LINKTOKEN.transferAndCall(
     * @dev    address(COORDINATOR),
     * @dev    amount,
     * @dev    abi.encode(subId));
     * @dev Note to fund the subscription with Native, use fundSubscriptionWithNative. Be sure
     * @dev  to send Native with the call, for example:
     * @dev COORDINATOR.fundSubscriptionWithNative{value: amount}(subId);
     */
    function createSubscription() external returns (uint256 subId);

    /**
     * @notice Get a VRF subscription.
     * @param subId - ID of the subscription
     * @return balance - LINK balance of the subscription in juels.
     * @return nativeBalance - native balance of the subscription in wei.
     * @return reqCount - Requests count of subscription.
     * @return owner - owner of the subscription.
     * @return consumers - list of consumer address which are able to use this subscription.
     */
    function getSubscription(uint256 subId)
        external
        view
        returns (
            uint96 balance,
            uint96 nativeBalance,
            uint64 reqCount,
            address owner,
            address[] memory consumers
        );

    /*
     * @notice Check to see if there exists a request commitment consumers
     * for all consumers and keyhashes for a given sub.
     * @param subId - ID of the subscription
     * @return true if there exists at least one unfulfilled request for the subscription, false
     * otherwise.
     */
    function pendingRequestExists(uint256 subId) external view returns (bool);

    /**
     * @notice Paginate through all active VRF subscriptions.
     * @param startIndex index of the subscription to start from
     * @param maxCount maximum number of subscriptions to return, 0 to return all
     * @dev the order of IDs in the list is **not guaranteed**, therefore, if making successive calls, one
     * @dev should consider keeping the blockheight constant to ensure a holistic picture of the contract state
     */
    function getActiveSubscriptionIds(uint256 startIndex, uint256 maxCount)
        external
        view
        returns (uint256[] memory);

    /**
     * @notice Fund a subscription with native.
     * @param subId - ID of the subscription
     * @notice This method expects msg.value to be greater than or equal to 0.
     */
    function fundSubscriptionWithNative(uint256 subId) external payable;
}

// Interface that enables consumers of VRFCoordinatorV2Plus to be future-proof for upgrades
// This interface is supported by subsequent versions of VRFCoordinatorV2Plus
interface IVRFCoordinatorV2Plus is IVRFSubscriptionV2Plus {
    /**
     * @notice Request a set of random words.
     * @param req - a struct containing following fields for randomness request:
     * keyHash - Corresponds to a particular oracle job which uses
     * that key for generating the VRF proof. Different keyHash's have different gas price
     * ceilings, so you can select a specific one to bound your maximum per request cost.
     * subId  - The ID of the VRF subscription. Must be funded
     * with the minimum subscription balance required for the selected keyHash.
     * requestConfirmations - How many blocks you'd like the
     * oracle to wait before responding to the request. See SECURITY CONSIDERATIONS
     * for why you may want to request more. The acceptable range is
     * [minimumRequestBlockConfirmations, 200].
     * callbackGasLimit - How much gas you'd like to receive in your
     * fulfillRandomWords callback. Note that gasleft() inside fulfillRandomWords
     * may be slightly less than this amount because of gas used calling the function
     * (argument decoding etc.), so you may need to request slightly more than you expect
     * to have inside fulfillRandomWords. The acceptable range is
     * [0, maxGasLimit]
     * numWords - The number of uint256 random values you'd like to receive
     * in your fulfillRandomWords callback. Note these numbers are expanded in a
     * secure way by the VRFCoordinator from a single random value supplied by the oracle.
     * extraArgs - abi-encoded extra args
     * @return requestId - A unique identifier of the request. Can be used to match
     * a request to a response in fulfillRandomWords.
     */
    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req)
        external
        returns (uint256 requestId);
}
