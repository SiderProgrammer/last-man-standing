// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {GameEscrow} from "../GameEscrow.sol";
import {TransferFailed, ZeroAddress} from "../Errors.sol";
import {AcrossMessageHandler} from "../vendor/across/AcrossMessageHandler.sol";
import {IAcrossSpokePool} from "../vendor/across/IAcrossSpokePool.sol";
import {IWETH9} from "../vendor/across/IWETH9.sol";

/// @title BridgeJoinReceiver
/// @notice The hub end of a cross-chain join, and the way back out.
///
/// @dev In: a player on a spoke calls `SpokeRouter.join`, which deposits the
///      stake into Across with this contract as the recipient. A relayer
///      fills it on the hub, and the SpokePool pays this contract (in WETH:
///      it is a contract) and calls `handleV3AcrossMessage`. That unwraps the
///      WETH and hands the ETH to `GameEscrow.bridgeJoin`, which seats the
///      player or, if the seat is gone or too little arrived, credits it all
///      to them in the escrow. Either way the player's money ends up in the
///      escrow, as one balance with their winnings and refunds.
///
///      A revert in the handler would revert the fill, and an unfilled deposit
///      sits until its deadline (on testnet, for good). So once the caller is
///      known to be the SpokePool, the handler never reverts: what it cannot
///      route — another token, a message it cannot decode, an escrow that
///      refuses — stays here, with an `Unroutable` event naming it, for the
///      owner (the timelock) to `recover`. The router only ever sends WETH and
///      a well-formed message, so that is for deposits made some other way.
///
///      The SpokePool is trusted for the token and amount it reports; the
///      message is not trusted at all. Anyone can deposit to this contract
///      with any message, so a message is only ever someone paying real value
///      for a seat, which the escrow treats like `joinFor`.
///
///      Out: `withdrawToChainFor` bridges a player's whole escrow balance to
///      a chain and address they signed for, with Across's fee taken from it.
///      A relayer submits it and pays the hub gas, so a player who has never
///      held gas on the hub still gets their winnings and refunds home.
///
///      Holds nothing between transactions except what it could not route.
contract BridgeJoinReceiver is AcrossMessageHandler, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice A player's signed instruction to bridge their balance out.
    /// @param hubChainId This chain: the domain below has no chain id, so a
    ///        signature for another deployment cannot be replayed here.
    /// @param outputToken The token the fill pays on the destination: its WETH.
    /// @param maxFee The most of the balance that may go to Across, in wei.
    struct Withdrawal {
        address player;
        uint256 hubChainId;
        uint256 destinationChainId;
        address recipient;
        address outputToken;
        uint256 maxFee;
        uint256 nonce;
        uint256 deadline;
    }

    /// @notice The fee terms the Across API quoted, as `SpokeRouter.Quote`.
    struct Quote {
        uint256 outputAmount;
        uint32 quoteTimestamp;
        uint32 fillDeadline;
        address exclusiveRelayer;
        uint32 exclusivityParameter;
    }

    bytes32 public constant WITHDRAWAL_TYPEHASH = keccak256(
        "Withdrawal(address player,uint256 hubChainId,uint256 destinationChainId,address recipient,"
        "address outputToken,uint256 maxFee,uint256 nonce,uint256 deadline)"
    );
    /// @dev No chain id, on purpose: wallets refuse to sign typed data for a
    ///      chain they are not on, and the player signing this is usually on
    ///      a spoke. `Withdrawal.hubChainId` stands in for it.
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,address verifyingContract)");

    GameEscrow public immutable escrow;
    /// @notice The hub's Across SpokePool: the only caller of the handler.
    address public immutable spokePool;
    IWETH9 public immutable weth;

    /// @notice The nonce a player's next `Withdrawal` must carry.
    mapping(address player => uint256) public nonces;

    /// @notice Value that arrived but could not be routed; see `recover`.
    event Unroutable(address indexed token, uint256 amount, bytes message);
    event WithdrawnToChain(
        address indexed player,
        uint256 indexed destinationChainId,
        address recipient,
        uint256 amount,
        uint256 outputAmount
    );
    event Recovered(address indexed token, address indexed to, uint256 amount);

    error NotSpokePool(address caller);
    error UnexpectedSender(address sender);
    error WithdrawalExpired(uint256 deadline);
    error WrongHub(uint256 hubChainId);
    error WrongNonce(uint256 expected, uint256 given);
    error BadSignature();
    error BelowMinimum(uint256 amount, uint256 minimum);
    error OutputExceedsInput(uint256 outputAmount, uint256 inputAmount);
    error FeeTooHigh(uint256 fee, uint256 maxFee);

    constructor(address owner_, GameEscrow escrow_, IAcrossSpokePool spokePool_) Ownable(owner_) {
        if (address(escrow_) == address(0) || address(spokePool_) == address(0)) revert ZeroAddress();
        escrow = escrow_;
        spokePool = address(spokePool_);
        weth = IWETH9(spokePool_.wrappedNativeToken());
    }

    // --- In ------------------------------------------------------------------

    /// @inheritdoc AcrossMessageHandler
    function handleV3AcrossMessage(address tokenSent, uint256 amount, address, bytes memory message)
        external
        nonReentrant
    {
        if (msg.sender != spokePool) revert NotSpokePool(msg.sender);
        if (tokenSent != address(weth) || !_unwrap(amount)) {
            emit Unroutable(tokenSent, amount, message);
            return;
        }

        try this.decodeJoin(message) returns (bytes32 matchId, address player, uint32 originChainId) {
            if (player == address(0)) {
                emit Unroutable(address(0), amount, message);
                return;
            }
            try escrow.bridgeJoin{value: amount}(matchId, player, originChainId) {}
            catch {
                emit Unroutable(address(0), amount, message);
            }
        } catch {
            emit Unroutable(address(0), amount, message);
        }
    }

    /// @notice What a join's message holds; see `SpokeRouter.joinMessage`.
    /// @dev External so the handler can `try` it: a malformed message is
    ///      held, not a revert.
    function decodeJoin(bytes calldata message)
        external
        pure
        returns (bytes32 matchId, address player, uint32 originChainId)
    {
        return abi.decode(message, (bytes32, address, uint32));
    }

    /// @dev Across pays a contract in WETH. Should a pool ever send ETH
    ///      instead, there is no WETH to unwrap and the ETH is already here.
    function _unwrap(uint256 amount) private returns (bool) {
        if (weth.balanceOf(address(this)) >= amount) {
            try weth.withdraw(amount) {}
            catch {
                return false;
            }
        }
        return address(this).balance >= amount;
    }

    // --- Out -----------------------------------------------------------------

    /// @notice Bridges `w.player`'s whole escrow balance to `w.recipient` on
    ///         `w.destinationChainId`, as they signed. Anyone may submit it.
    /// @dev The submitter brings Across's quote for the balance. If the fill
    ///      never comes, Across refunds the deposit after `q.fillDeadline` to
    ///      the player on this chain, in WETH.
    function withdrawToChainFor(Withdrawal calldata w, Quote calldata q, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 amount)
    {
        if (block.timestamp > w.deadline) revert WithdrawalExpired(w.deadline);
        if (w.hubChainId != block.chainid) revert WrongHub(w.hubChainId);
        uint256 nonce = nonces[w.player];
        if (w.nonce != nonce) revert WrongNonce(nonce, w.nonce);
        if (!SignatureChecker.isValidSignatureNow(w.player, withdrawalDigest(w), signature)) {
            revert BadSignature();
        }
        nonces[w.player] = nonce + 1;

        amount = escrow.withdrawToBridge(w.player);
        uint256 minimum = escrow.MIN_WITHDRAW_FOR();
        if (amount < minimum) revert BelowMinimum(amount, minimum);
        if (q.outputAmount > amount) revert OutputExceedsInput(q.outputAmount, amount);
        if (amount - q.outputAmount > w.maxFee) revert FeeTooHigh(amount - q.outputAmount, w.maxFee);

        _deposit(w, q, amount);
        emit WithdrawnToChain(w.player, w.destinationChainId, w.recipient, amount, q.outputAmount);
    }

    /// @dev Its own frame: twelve arguments leave no room for the caller's locals.
    function _deposit(Withdrawal calldata w, Quote calldata q, uint256 amount) private {
        IAcrossSpokePool(spokePool).depositV3{value: amount}(
            w.player,
            w.recipient,
            address(weth),
            w.outputToken,
            amount,
            q.outputAmount,
            w.destinationChainId,
            q.exclusiveRelayer,
            q.quoteTimestamp,
            q.fillDeadline,
            q.exclusivityParameter,
            ""
        );
    }

    /// @notice The EIP-712 digest a player signs for `w`.
    function withdrawalDigest(Withdrawal calldata w) public view returns (bytes32) {
        return
            MessageHashUtils.toTypedDataHash(domainSeparator(), keccak256(abi.encode(WITHDRAWAL_TYPEHASH, w)));
    }

    function domainSeparator() public view returns (bytes32) {
        return
            keccak256(
                abi.encode(DOMAIN_TYPEHASH, keccak256("LastManStanding"), keccak256("1"), address(this))
            );
    }

    // --- Owner ---------------------------------------------------------------

    /// @notice Sends value that could not be routed to `to`: ETH when `token`
    ///         is zero. The owner is the timelock, so this takes a proposal.
    /// @dev Nothing a player is owed is ever held here, so this cannot touch
    ///      it: seats and credits live in the escrow.
    function recover(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed(to, amount);
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
        emit Recovered(token, to, amount);
    }

    /// @dev From WETH unwrapping, the escrow paying a withdrawal out, or the
    ///      SpokePool. Anything else is a mistake to refuse.
    receive() external payable {
        if (msg.sender != address(weth) && msg.sender != address(escrow) && msg.sender != spokePool) {
            revert UnexpectedSender(msg.sender);
        }
    }
}
