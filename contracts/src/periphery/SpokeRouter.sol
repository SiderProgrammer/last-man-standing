// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ZeroAddress} from "../Errors.sol";
import {IAcrossSpokePool} from "../vendor/across/IAcrossSpokePool.sol";

/// @title SpokeRouter
/// @notice Joins a hub lobby from a spoke chain, by bridging the stake with
///         Across to the hub's `BridgeJoinReceiver`.
///
/// @dev Holds nothing, ever: the ETH a join sends goes straight into the
///      SpokePool's deposit in the same call. No owner and no parameters;
///      replacing it means deploying another one.
///
///      The caller brings the quote. The fee comes from the Across API, which
///      the client asks with this router's `joinMessage` as the message and
///      the receiver as the recipient (the handler's gas is part of the fee).
///      `msg.value` is the input, and `quote.outputAmount` what arrives on the
///      hub, which Across delivers exactly or not at all: a fill is never
///      short, and an unfilled deposit is refunded here, in WETH, to the
///      caller, after `quote.fillDeadline`. So the output should be the stake;
///      the receiver credits anything above it to the player on the hub.
///
///      Who gets the seat. By default the caller, which only works if the
///      caller is the same account on the hub: an EOA, or an EOA delegated
///      under EIP-7702, whose code is a designator, not an account of its own.
///      A contract's address on this chain may belong to someone else on the
///      hub, or to no one, so a contract caller must name `hubRecipient`.
///      Naming someone else is allowed: paying for another player's seat only
///      ever credits them, like `GameEscrow.joinFor`.
contract SpokeRouter {
    /// @notice The fee terms the Across API quoted for this deposit.
    /// @param outputAmount What arrives on the hub: the stake.
    /// @param quoteTimestamp The quote's `timestamp`.
    /// @param fillDeadline The quote's `fillDeadline`.
    /// @param exclusiveRelayer The quote's `exclusiveRelayer`, often zero.
    /// @param exclusivityParameter The quote's `exclusivityDeadline`, an offset or a timestamp.
    struct Quote {
        uint256 outputAmount;
        uint32 quoteTimestamp;
        uint32 fillDeadline;
        address exclusiveRelayer;
        uint32 exclusivityParameter;
    }

    /// @dev The prefix of an EIP-7702 delegation designator.
    bytes3 private constant DELEGATION_PREFIX = 0xef0100;
    /// @dev A designator is the prefix and a 20-byte address.
    uint256 private constant DELEGATION_LENGTH = 23;

    IAcrossSpokePool public immutable spokePool;
    /// @notice This chain's WETH, the token Across moves for ETH.
    address public immutable weth;
    uint256 public immutable hubChainId;
    /// @notice `BridgeJoinReceiver` on the hub.
    address public immutable hubReceiver;
    /// @notice The hub's WETH: what the fill pays the receiver.
    address public immutable hubWeth;

    event JoinBridged(
        bytes32 indexed matchId,
        address indexed depositor,
        address indexed player,
        uint256 inputAmount,
        uint256 outputAmount
    );

    error HubRecipientRequired(address caller);
    error OutputExceedsInput(uint256 outputAmount, uint256 inputAmount);
    error NothingToBridge();

    constructor(
        IAcrossSpokePool spokePool_,
        address weth_,
        uint256 hubChainId_,
        address hubReceiver_,
        address hubWeth_
    ) {
        if (
            address(spokePool_) == address(0) || weth_ == address(0) || hubReceiver_ == address(0)
                || hubWeth_ == address(0)
        ) revert ZeroAddress();
        spokePool = spokePool_;
        weth = weth_;
        hubChainId = hubChainId_;
        hubReceiver = hubReceiver_;
        hubWeth = hubWeth_;
    }

    /// @notice Bridges `msg.value` to the hub to take a seat in `matchId`.
    /// @param hubRecipient Who gets the seat; zero for the caller (see the
    ///        contract notes for when that is refused).
    function join(bytes32 matchId, address hubRecipient, Quote calldata quote) external payable {
        address player = hubRecipient;
        if (player == address(0)) {
            if (msg.sender.code.length != 0 && !_isDelegated(msg.sender)) {
                revert HubRecipientRequired(msg.sender);
            }
            player = msg.sender;
        }
        if (quote.outputAmount == 0) revert NothingToBridge();
        if (quote.outputAmount > msg.value) revert OutputExceedsInput(quote.outputAmount, msg.value);

        _deposit(quote, joinMessage(matchId, player));
        emit JoinBridged(matchId, msg.sender, player, msg.value, quote.outputAmount);
    }

    /// @dev Its own frame: twelve arguments leave no room for `join`'s locals.
    function _deposit(Quote calldata quote, bytes memory message) private {
        spokePool.depositV3{value: msg.value}(
            msg.sender,
            hubReceiver,
            weth,
            hubWeth,
            msg.value,
            quote.outputAmount,
            hubChainId,
            quote.exclusiveRelayer,
            quote.quoteTimestamp,
            quote.fillDeadline,
            quote.exclusivityParameter,
            message
        );
    }

    /// @notice The message a join carries, which `BridgeJoinReceiver`
    ///         decodes: the lobby, the player, and this chain.
    function joinMessage(bytes32 matchId, address player) public view returns (bytes memory) {
        return abi.encode(matchId, player, uint32(block.chainid));
    }

    /// @dev Reads the code only when it is a designator's length, so a large
    ///      contract is never copied into memory to be refused.
    function _isDelegated(address account) private view returns (bool) {
        return account.code.length == DELEGATION_LENGTH && bytes3(account.code) == DELEGATION_PREFIX;
    }
}
