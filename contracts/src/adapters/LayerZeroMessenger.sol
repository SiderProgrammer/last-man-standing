// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {ICrossChainMessenger, ICrossChainReceiver} from "../interfaces/ICrossChainMessenger.sol";
import {ILayerZeroEndpoint, ILayerZeroReceiver, Origin} from "../interfaces/ILayerZeroEndpoint.sol";
import {ZeroAddress} from "../Errors.sol";

/// @title LayerZeroMessenger
/// @notice Adapts LayerZero v2 to the protocol's messenger interface, as an
///         OApp serving exactly one local application.
///
/// @dev Three things the transport does not do for us, done here:
///
///      **Who sent it.** LayerZero tells a receiver which remote *OApp* sent a
///      message — that is, the remote messenger — not who called it. Left at
///      that, any contract on a spoke could send a join through the spoke's
///      messenger and the hub would accept it as coming from its trusted peer.
///      So `sendMessage` accepts calls from the local `app` only, the envelope
///      carries that app's address, and `lzReceive` checks the remote messenger
///      against `peers` before handing the app's address on as `srcSender`.
///      The escrow's peer check then authenticates the originating contract.
///
///      **Which chain.** LayerZero numbers chains by endpoint id. The escrow
///      records where each seat came from and clients render it, so ids are
///      translated to EVM chain ids at this boundary and nowhere else.
///
///      **How much value.** The stake travels as native value delivered to
///      `lzReceive`, and the amount is set by the message's executor options.
///      Options are built per message from `deliverValue`, so every lobby's
///      stake arrives exactly — a fixed default would deliver the wrong amount
///      for every stake but one.
contract LayerZeroMessenger is Ownable2Step, ICrossChainMessenger, ILayerZeroReceiver {
    /// @dev `OptionsBuilder` constants from `@layerzerolabs/oapp-evm`.
    uint16 private constant OPTIONS_TYPE_3 = 3;
    uint8 private constant EXECUTOR_WORKER_ID = 1;
    uint8 private constant OPTION_TYPE_LZRECEIVE = 1;

    ILayerZeroEndpoint public immutable endpoint;
    /// @notice The one local contract this messenger sends for and delivers to.
    /// @dev Settable because a spoke and its messenger each need the other's
    ///      address at deployment; zero until set, which refuses all traffic.
    address public app;

    /// @notice Gas the executor gives `lzReceive` on the destination.
    uint128 public receiveGas;

    /// @notice Remote messenger per endpoint id. Messages from anything else are refused.
    mapping(uint32 eid => bytes32 peer) public peers;
    mapping(uint32 chainId => uint32 eid) public eidOf;
    mapping(uint32 eid => uint32 chainId) public chainIdOf;

    event AppSet(address indexed app);
    event PeerSet(uint32 indexed chainId, uint32 indexed eid, bytes32 peer);
    event ReceiveGasSet(uint128 gas);

    error NotApp(address caller);
    error NotEndpoint(address caller);
    error UnknownChain(uint32 chainId);
    error UntrustedPeer(uint32 eid, bytes32 sender);
    error WrongReceiver(bytes32 receiver);

    constructor(address owner_, ILayerZeroEndpoint endpoint_, address app_, uint128 receiveGas_) Ownable(owner_) {
        if (address(endpoint_) == address(0)) revert ZeroAddress();
        endpoint = endpoint_;
        app = app_;
        receiveGas = receiveGas_;
        emit AppSet(app_);
    }

    function setApp(address app_) external onlyOwner {
        if (app_ == address(0)) revert ZeroAddress();
        app = app_;
        emit AppSet(app_);
    }

    /// @notice Registers the messenger on `chainId`, reached at endpoint id `eid`.
    ///         A zero `peer` removes the route.
    function setPeer(uint32 chainId, uint32 eid, bytes32 peer) external onlyOwner {
        peers[eid] = peer;
        eidOf[chainId] = peer == bytes32(0) ? 0 : eid;
        chainIdOf[eid] = peer == bytes32(0) ? 0 : chainId;
        emit PeerSet(chainId, eid, peer);
    }

    function setReceiveGas(uint128 gas) external onlyOwner {
        receiveGas = gas;
        emit ReceiveGasSet(gas);
    }

    // ------------------------------------------------------------------ send

    /// @inheritdoc ICrossChainMessenger
    function sendMessage(uint32 dstChainId, bytes32 receiver, bytes calldata payload, uint128 deliverValue)
        external
        payable
        returns (bytes32 messageId)
    {
        if (msg.sender != app || app == address(0)) revert NotApp(msg.sender);
        ILayerZeroEndpoint.MessagingReceipt memory receipt =
            endpoint.send{value: msg.value}(_params(dstChainId, receiver, payload, deliverValue), msg.sender);
        messageId = receipt.guid;
    }

    /// @inheritdoc ICrossChainMessenger
    function quote(uint32 dstChainId, bytes32 receiver, bytes calldata payload, uint128 deliverValue)
        external
        view
        returns (uint256 nativeFee)
    {
        nativeFee = endpoint.quote(_params(dstChainId, receiver, payload, deliverValue), address(this)).nativeFee;
    }

    /// @notice The executor options for one message: `lzReceive` gas and value.
    function options(uint128 deliverValue) public view returns (bytes memory) {
        bytes memory option =
            deliverValue == 0 ? abi.encodePacked(receiveGas) : abi.encodePacked(receiveGas, deliverValue);
        return abi.encodePacked(
            OPTIONS_TYPE_3, EXECUTOR_WORKER_ID, uint16(option.length + 1), OPTION_TYPE_LZRECEIVE, option
        );
    }

    function _params(uint32 dstChainId, bytes32 receiver, bytes calldata payload, uint128 deliverValue)
        private
        view
        returns (ILayerZeroEndpoint.MessagingParams memory)
    {
        uint32 eid = eidOf[dstChainId];
        bytes32 peer = peers[eid];
        if (eid == 0 || peer == bytes32(0)) revert UnknownChain(dstChainId);
        return ILayerZeroEndpoint.MessagingParams({
            dstEid: eid,
            receiver: peer,
            // The app's own address rides along, so the far side can pass on
            // who actually sent this rather than which messenger carried it.
            message: abi.encode(bytes32(uint256(uint160(app))), receiver, payload),
            options: options(deliverValue),
            payInLzToken: false
        });
    }

    // --------------------------------------------------------------- receive

    /// @inheritdoc ILayerZeroReceiver
    function allowInitializePath(Origin calldata origin) external view returns (bool) {
        return origin.sender != bytes32(0) && peers[origin.srcEid] == origin.sender;
    }

    /// @inheritdoc ILayerZeroReceiver
    function nextNonce(uint32, bytes32) external pure returns (uint64) {
        return 0;
    }

    /// @inheritdoc ILayerZeroReceiver
    function lzReceive(Origin calldata origin, bytes32, bytes calldata message, address, bytes calldata)
        external
        payable
    {
        if (msg.sender != address(endpoint)) revert NotEndpoint(msg.sender);
        if (origin.sender == bytes32(0) || peers[origin.srcEid] != origin.sender) {
            revert UntrustedPeer(origin.srcEid, origin.sender);
        }

        (bytes32 srcApp, bytes32 receiver, bytes memory payload) = abi.decode(message, (bytes32, bytes32, bytes));
        if (app == address(0) || receiver != bytes32(uint256(uint160(app)))) revert WrongReceiver(receiver);

        ICrossChainReceiver(app).receiveMessage{value: msg.value}(chainIdOf[origin.srcEid], srcApp, payload);
    }
}
