// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The slice of LayerZero v2's `EndpointV2` the messenger adapter uses.
/// @dev Shapes follow `ILayerZeroEndpointV2` and `ILayerZeroReceiver` from
///      `@layerzerolabs/lz-evm-protocol-v2`. Kept local rather than vendored so
///      the build has no extra dependency; check them against that package
///      before the first testnet deployment (`docs/TODO.md` §2.1).
struct Origin {
    uint32 srcEid;
    bytes32 sender;
    uint64 nonce;
}

interface ILayerZeroEndpoint {
    struct MessagingParams {
        uint32 dstEid;
        bytes32 receiver;
        bytes message;
        bytes options;
        bool payInLzToken;
    }

    struct MessagingFee {
        uint256 nativeFee;
        uint256 lzTokenFee;
    }

    struct MessagingReceipt {
        bytes32 guid;
        uint64 nonce;
        MessagingFee fee;
    }

    function send(MessagingParams calldata params, address refundAddress)
        external
        payable
        returns (MessagingReceipt memory);

    function quote(MessagingParams calldata params, address sender) external view returns (MessagingFee memory);
}

/// @notice LayerZero v2 receive path, implemented by an OApp.
interface ILayerZeroReceiver {
    /// @dev Whether the endpoint may open a channel from `origin`. An OApp
    ///      allows exactly its configured peers.
    function allowInitializePath(Origin calldata origin) external view returns (bool);

    /// @dev Zero means unordered delivery, which is all this adapter needs.
    function nextNonce(uint32 srcEid, bytes32 sender) external view returns (uint64);

    function lzReceive(
        Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address executor,
        bytes calldata extraData
    ) external payable;
}
