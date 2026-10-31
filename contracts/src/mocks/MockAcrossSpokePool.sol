// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAcrossSpokePool} from "../vendor/across/IAcrossSpokePool.sol";
import {AcrossMessageHandler} from "../vendor/across/AcrossMessageHandler.sol";
import {IWETH9} from "../vendor/across/IWETH9.sol";

/// @notice Test double for an Across SpokePool, both ends of it.
/// @dev `depositV3` checks what the pinned SpokePool checks and records the
///      deposit. `fill` plays a relayer on the destination: it pays the
///      recipient the way the real pool does — the wrapped token to a
///      contract, ETH to an EOA or a 7702-delegated account — and then calls
///      the recipient's handler. A handler revert reverts the fill, as there.
///      Nothing here moves a deposit to another chain: a test, or
///      `npm run dev:fork`, reads deposits on one chain and fills them on
///      the other.
contract MockAcrossSpokePool {
    using SafeERC20 for IERC20;

    struct Deposit {
        address depositor;
        address recipient;
        address inputToken;
        address outputToken;
        uint256 inputAmount;
        uint256 outputAmount;
        uint256 destinationChainId;
        address exclusiveRelayer;
        uint32 quoteTimestamp;
        uint32 fillDeadline;
        uint32 exclusivityParameter;
        bytes message;
    }

    IWETH9 public immutable weth;
    uint32 public depositQuoteTimeBuffer = 1 hours;
    uint32 public fillDeadlineBuffer = 6 hours;

    Deposit[] private deposits;

    event FundsDeposited(
        uint256 indexed depositId,
        address indexed depositor,
        address recipient,
        uint256 destinationChainId,
        uint256 inputAmount,
        uint256 outputAmount,
        bytes message
    );
    event FilledRelay(address indexed recipient, address outputToken, uint256 amount, bytes message);

    error InvalidOutputToken();
    error InvalidQuoteTimestamp();
    error InvalidFillDeadline();
    error MsgValueDoesNotMatchInputAmount();
    error ExpiredFillDeadline();
    error UnknownFunction(bytes4 selector);

    constructor(IWETH9 weth_) {
        weth = weth_;
    }

    function wrappedNativeToken() external view returns (address) {
        return address(weth);
    }

    /// @notice `IAcrossSpokePool.depositV3`, taken in the fallback.
    /// @dev Decoding twelve arguments onto the stack is too deep for the
    ///      legacy code generator, which this repository builds with (Across
    ///      builds with via-IR). So the call's arguments are read as one
    ///      `Deposit` instead: they are encoded exactly as a tuple of their
    ///      types, and an offset word in front makes that tuple a `Deposit`.
    fallback() external payable {
        if (msg.sig != IAcrossSpokePool.depositV3.selector) revert UnknownFunction(msg.sig);
        _deposit(abi.decode(bytes.concat(bytes32(uint256(32)), msg.data[4:]), (Deposit)));
    }

    /// @dev Plain ETH, as a relayer's float.
    receive() external payable {}

    function _deposit(Deposit memory d) private {
        if (d.outputToken == address(0)) revert InvalidOutputToken();
        if (block.timestamp < d.quoteTimestamp || block.timestamp - d.quoteTimestamp > depositQuoteTimeBuffer)
        {
            revert InvalidQuoteTimestamp();
        }
        if (d.fillDeadline > block.timestamp + fillDeadlineBuffer) revert InvalidFillDeadline();

        if (d.inputToken == address(weth) && msg.value > 0) {
            if (msg.value != d.inputAmount) revert MsgValueDoesNotMatchInputAmount();
            weth.deposit{value: msg.value}();
        } else {
            if (msg.value != 0) revert MsgValueDoesNotMatchInputAmount();
            IERC20(d.inputToken).safeTransferFrom(msg.sender, address(this), d.inputAmount);
        }

        deposits.push(d);
        emit FundsDeposited(
            deposits.length - 1,
            d.depositor,
            d.recipient,
            d.destinationChainId,
            d.inputAmount,
            d.outputAmount,
            d.message
        );
    }

    /// @notice Pays `amount` of `outputToken` to `recipient`, then calls its
    ///         handler if there is a message: one relayer fill.
    /// @dev For the wrapped native token the relayer sends ETH with the call;
    ///      any other token is pulled from the caller.
    function fill(
        address recipient,
        address outputToken,
        uint256 amount,
        uint32 fillDeadline,
        bytes calldata message
    ) external payable {
        if (fillDeadline < block.timestamp) revert ExpiredFillDeadline();
        if (outputToken == address(weth)) {
            if (msg.value != amount) revert MsgValueDoesNotMatchInputAmount();
            if (recipient.code.length == 0 || _isDelegated(recipient)) {
                (bool ok,) = recipient.call{value: amount}("");
                require(ok);
            } else {
                weth.deposit{value: amount}();
                IERC20(address(weth)).safeTransfer(recipient, amount);
            }
        } else {
            IERC20(outputToken).safeTransferFrom(msg.sender, recipient, amount);
        }

        if (message.length > 0 && recipient.code.length > 0) {
            AcrossMessageHandler(recipient).handleV3AcrossMessage(outputToken, amount, msg.sender, message);
        }
        emit FilledRelay(recipient, outputToken, amount, message);
    }

    function depositCount() external view returns (uint256) {
        return deposits.length;
    }

    function getDeposit(uint256 id) external view returns (Deposit memory) {
        return deposits[id];
    }

    function _isDelegated(address account) private view returns (bool) {
        return account.code.length == 23 && bytes3(account.code) == 0xef0100;
    }
}
