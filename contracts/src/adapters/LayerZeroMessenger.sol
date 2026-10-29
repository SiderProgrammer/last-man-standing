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
///      for every stake but one. The executor caps that value per destination
///      (`nativeCap`); a stake above the cap fails `quote` on the spoke, before
///      anything is sent.
///
///      **When delivery fails.** If `lzReceive` reverts, LayerZero's executor
///      keeps the value it was paid to deliver and only reports the failure;
///      the message stays retryable, but whoever retries has to bring the
///      stake again. So once a message is authenticated, this never reverts:
///      a delivery the app refuses — the hub's remote-chain config not set
///      yet, a peer registered wrong, an app not set — is *parked* here with
///      its value, and `retry` hands it to the app again, at no cost but gas,
///      once the config is fixed. The app makes every decision; parking only
///      keeps the money on the right chain while it cannot.
contract LayerZeroMessenger is Ownable2Step, ICrossChainMessenger, ILayerZeroReceiver {
    /// @dev `OptionsBuilder` constants from `@layerzerolabs/oapp-evm`.
    uint16 private constant OPTIONS_TYPE_3 = 3;
    uint8 private constant EXECUTOR_WORKER_ID = 1;
    uint8 private constant OPTION_TYPE_LZRECEIVE = 1;

    /// @notice Gas held back from the app's call, to park the delivery if the
    ///         call fails: one storage write and an event.
    uint256 public constant PARK_GAS = 80_000;
    /// @notice The least gas the app's call is given: a hub join is about
    ///         120k for the first seat in a lobby.
    /// @dev Without a floor, a delivery executed with too little gas would
    ///      fail inside the app and park, though it would have seated with
    ///      enough. Anyone may execute a verified message, and gas estimation
    ///      lands on exactly that cheapest "success", so short-gassed calls
    ///      revert instead and leave the message to be executed properly.
    uint256 public constant APP_GAS = 140_000;
    /// @notice The least `receiveGas` may be: the app's floor and the park
    ///         reserve, plus what the endpoint spends before calling here.
    uint128 public constant MIN_RECEIVE_GAS = 300_000;

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

    /// @notice Deliveries the app refused, by LayerZero guid: a hash of what
    ///         `retry` must be given. The full delivery is in `DeliveryParked`.
    mapping(bytes32 guid => bytes32 delivery) public parked;
    /// @notice Value held for parked deliveries. Nothing else is ever held.
    uint256 public totalParked;

    event AppSet(address indexed app);
    event PeerSet(uint32 indexed chainId, uint32 indexed eid, bytes32 peer);
    event ReceiveGasSet(uint128 gas);
    event DeliveryParked(
        bytes32 indexed guid, uint32 srcChainId, bytes32 srcApp, bytes payload, uint256 value, bytes reason
    );
    event DeliveryRetried(bytes32 indexed guid);

    error NotApp(address caller);
    error NotEndpoint(address caller);
    error UnknownChain(uint32 chainId);
    error UntrustedPeer(uint32 eid, bytes32 sender);
    error NotParked(bytes32 guid);
    error ReceiveGasTooLow(uint128 gas);
    error NotEnoughGas(uint256 available, uint256 needed);

    /// @dev `owner_` is also made the endpoint delegate, as `OAppCore` does,
    ///      so the owner can set this OApp's verifiers and libraries.
    constructor(address owner_, ILayerZeroEndpoint endpoint_, address app_, uint128 receiveGas_)
        Ownable(owner_)
    {
        if (address(endpoint_) == address(0)) revert ZeroAddress();
        if (receiveGas_ < MIN_RECEIVE_GAS) revert ReceiveGasTooLow(receiveGas_);
        endpoint = endpoint_;
        app = app_;
        receiveGas = receiveGas_;
        endpoint_.setDelegate(owner_);
        emit AppSet(app_);
    }

    /// @notice Who may configure this OApp on the endpoint. Hand it over with
    ///         ownership: the owner's timelock should hold both.
    function setDelegate(address delegate) external onlyOwner {
        endpoint.setDelegate(delegate);
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
        if (gas < MIN_RECEIVE_GAS) revert ReceiveGasTooLow(gas);
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
        nativeFee =
        endpoint.quote(_params(dstChainId, receiver, payload, deliverValue), address(this)).nativeFee;
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
    /// @dev Reverts only on a message that is not from a trusted peer — the
    ///      endpoint never opens such a path, so no value can be riding on
    ///      one — or on a call with less gas than `APP_GAS` plus `PARK_GAS`,
    ///      which the executor never makes: it gives `receiveGas`, which is
    ///      at least `MIN_RECEIVE_GAS`. Anything else reaches the app or is
    ///      parked.
    function lzReceive(Origin calldata origin, bytes32 guid, bytes calldata message, address, bytes calldata)
        external
        payable
    {
        if (msg.sender != address(endpoint)) revert NotEndpoint(msg.sender);
        if (origin.sender == bytes32(0) || peers[origin.srcEid] != origin.sender) {
            revert UntrustedPeer(origin.srcEid, origin.sender);
        }
        if (gasleft() < APP_GAS + PARK_GAS) revert NotEnoughGas(gasleft(), APP_GAS + PARK_GAS);

        (bytes32 srcApp, bytes32 receiver, bytes memory payload) =
            abi.decode(message, (bytes32, bytes32, bytes));
        uint32 srcChainId = chainIdOf[origin.srcEid];

        address target = app;
        if (target == address(0) || receiver != bytes32(uint256(uint160(target)))) {
            _park(guid, srcChainId, srcApp, payload, msg.value, "wrong receiver");
            return;
        }
        try ICrossChainReceiver(target).receiveMessage{value: msg.value, gas: gasleft() - PARK_GAS}(
            srcChainId, srcApp, payload
        ) {}
        catch (bytes memory reason) {
            _park(guid, srcChainId, srcApp, payload, msg.value, reason);
        }
    }

    /// @notice Hands a parked delivery to the app again. Anyone may call it,
    ///         and it costs no value: the stake is already here.
    /// @dev Reverts, and stays parked, if the app still refuses it. The app
    ///      authenticates the delivery exactly as it would have on arrival.
    function retry(bytes32 guid, uint32 srcChainId, bytes32 srcApp, bytes calldata payload, uint256 value)
        external
    {
        if (parked[guid] != _deliveryHash(srcChainId, srcApp, payload, value)) revert NotParked(guid);
        delete parked[guid];
        totalParked -= value;
        ICrossChainReceiver(app).receiveMessage{value: value}(srcChainId, srcApp, payload);
        emit DeliveryRetried(guid);
    }

    function _park(
        bytes32 guid,
        uint32 srcChainId,
        bytes32 srcApp,
        bytes memory payload,
        uint256 value,
        bytes memory reason
    ) private {
        parked[guid] = _deliveryHash(srcChainId, srcApp, payload, value);
        totalParked += value;
        emit DeliveryParked(guid, srcChainId, srcApp, payload, value, reason);
    }

    function _deliveryHash(uint32 srcChainId, bytes32 srcApp, bytes memory payload, uint256 value)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(srcChainId, srcApp, payload, value));
    }
}
