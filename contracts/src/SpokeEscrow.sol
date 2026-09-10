// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ICrossChainMessenger, ICrossChainReceiver} from "./interfaces/ICrossChainMessenger.sol";

/// @title SpokeEscrow
/// @notice Spoke-chain gate for joining a hub match and receiving payouts.
///
/// @dev The hub `GameEscrow` holds the prize pool. A player on this chain
///      stakes here; the messenger forwards the stake and the join payload
///      to the hub. After settlement the hub bridges the payout back and
///      this contract credits a pull-based balance.
contract SpokeEscrow is Ownable, ReentrancyGuard, ICrossChainReceiver {
    address public messenger;
    uint32 public hubChainId;
    bytes32 public hubEscrow;

    mapping(address account => uint256) public withdrawable;
    uint256 public totalOwed;

    event HubSet(uint32 hubChainId, bytes32 hubEscrow, address messenger);
    event JoinForwarded(bytes32 indexed matchId, address indexed player, uint128 stake);
    event PayoutCredited(address indexed player, uint256 amount);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);

    error ZeroAddress();
    error UntrustedMessenger(address caller);
    error UntrustedPeer(uint32 srcChainId, bytes32 srcSender);
    error InsufficientValue(uint256 sent, uint256 required);
    error IncorrectPayout(uint256 sent, uint256 expected);
    error NothingToWithdraw();
    error TransferFailed(address to, uint256 amount);

    constructor(address owner_, address messenger_, uint32 hubChainId_, address hubEscrow_)
        Ownable(owner_)
    {
        _setHub(messenger_, hubChainId_, hubEscrow_);
    }

    function setHub(address messenger_, uint32 hubChainId_, address hubEscrow_) external onlyOwner {
        _setHub(messenger_, hubChainId_, hubEscrow_);
    }

    /// @notice Stakes into a hub match. `msg.value` must cover the stake plus the transport fee.
    function join(bytes32 matchId, uint128 stake) external payable nonReentrant {
        if (messenger == address(0) || hubEscrow == bytes32(0)) revert ZeroAddress();

        bytes memory payload = abi.encode(matchId, msg.sender);
        uint256 fee = ICrossChainMessenger(messenger).quote(hubChainId, hubEscrow, payload);
        uint256 required = uint256(stake) + fee;
        if (msg.value < required) revert InsufficientValue(msg.value, required);

        ICrossChainMessenger(messenger).sendMessage{value: required}(hubChainId, hubEscrow, payload);

        uint256 extra = msg.value - required;
        if (extra > 0) {
            (bool ok,) = msg.sender.call{value: extra}("");
            if (!ok) revert TransferFailed(msg.sender, extra);
        }

        emit JoinForwarded(matchId, msg.sender, stake);
    }

    /// @inheritdoc ICrossChainReceiver
    function receiveMessage(uint32 srcChainId, bytes32 srcSender, bytes calldata payload)
        external
        payable
    {
        if (msg.sender != messenger) revert UntrustedMessenger(msg.sender);
        if (srcChainId != hubChainId || srcSender != hubEscrow) {
            revert UntrustedPeer(srcChainId, srcSender);
        }

        (address player, uint256 amount) = abi.decode(payload, (address, uint256));
        if (msg.value != amount) revert IncorrectPayout(msg.value, amount);

        withdrawable[player] += amount;
        totalOwed += amount;
        emit PayoutCredited(player, amount);
    }

    function withdraw(address to) external nonReentrant returns (uint256 amount) {
        amount = withdrawable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        withdrawable[msg.sender] = 0;
        totalOwed -= amount;

        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed(to, amount);

        emit Withdrawn(msg.sender, to, amount);
    }

    function _setHub(address messenger_, uint32 hubChainId_, address hubEscrow_) private {
        if (messenger_ == address(0) || hubEscrow_ == address(0)) revert ZeroAddress();
        messenger = messenger_;
        hubChainId = hubChainId_;
        hubEscrow = bytes32(uint256(uint160(hubEscrow_)));
        emit HubSet(hubChainId_, hubEscrow, messenger_);
    }
}
