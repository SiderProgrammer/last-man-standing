// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {ICrossChainMessenger} from "./interfaces/ICrossChainMessenger.sol";
import {TransferFailed, ZeroAddress} from "./Errors.sol";

/// @title SpokeEscrow
/// @notice Spoke-chain gate for joining a hub match.
///
/// @dev The hub `GameEscrow` holds the prize pool. A player on this chain
///      stakes here; the messenger delivers the stake and the join payload to
///      the hub, which seats the player — or, if the seat can no longer be
///      taken, credits the stake back to the player on the hub. Either way the
///      value ends up the player's, and nothing is held here.
///
///      Payouts stay on the hub. There used to be a bridged way back out, but
///      it was a second irreversible transport path with the same
///      lost-in-transit failure mode as joining, to save a player one manual
///      bridge; and the hub's `withdrawFor` lets a keeper push a payout to a
///      player who holds no gas there.
contract SpokeEscrow is Ownable2Step, ReentrancyGuardTransient {
    address public messenger;
    uint32 public hubChainId;
    bytes32 public hubEscrow;

    event HubSet(uint32 hubChainId, bytes32 hubEscrow, address messenger);
    event JoinForwarded(bytes32 indexed matchId, address indexed player, uint128 stake);

    error InsufficientValue(uint256 sent, uint256 required);

    constructor(address owner_, address messenger_, uint32 hubChainId_, address hubEscrow_) Ownable(owner_) {
        _setHub(messenger_, hubChainId_, hubEscrow_);
    }

    function setHub(address messenger_, uint32 hubChainId_, address hubEscrow_) external onlyOwner {
        _setHub(messenger_, hubChainId_, hubEscrow_);
    }

    /// @notice What `join` costs for a given stake: the stake itself, delivered
    ///         on the hub, plus the transport fee.
    function quoteJoin(bytes32 matchId, uint128 stake) public view returns (uint256) {
        return
            ICrossChainMessenger(messenger)
                .quote(hubChainId, hubEscrow, abi.encode(matchId, msg.sender), stake);
    }

    /// @notice Stakes into a hub match. `msg.value` must cover `quoteJoin`;
    ///         anything above it is returned.
    /// @dev `stake` must be the lobby's stake on the hub. A wrong one is not
    ///      lost — the hub refunds a join it cannot seat — but it does not seat.
    function join(bytes32 matchId, uint128 stake) external payable nonReentrant {
        bytes memory payload = abi.encode(matchId, msg.sender);
        uint256 required = ICrossChainMessenger(messenger).quote(hubChainId, hubEscrow, payload, stake);
        if (msg.value < required) revert InsufficientValue(msg.value, required);

        ICrossChainMessenger(messenger).sendMessage{value: required}(hubChainId, hubEscrow, payload, stake);

        uint256 extra = msg.value - required;
        if (extra > 0) {
            (bool ok,) = msg.sender.call{value: extra}("");
            if (!ok) revert TransferFailed(msg.sender, extra);
        }

        emit JoinForwarded(matchId, msg.sender, stake);
    }

    function _setHub(address messenger_, uint32 hubChainId_, address hubEscrow_) private {
        if (messenger_ == address(0) || hubEscrow_ == address(0)) revert ZeroAddress();
        messenger = messenger_;
        hubChainId = hubChainId_;
        hubEscrow = bytes32(uint256(uint160(hubEscrow_)));
        emit HubSet(hubChainId_, hubEscrow, messenger_);
    }
}
