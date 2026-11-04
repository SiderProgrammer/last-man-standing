// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {GameEscrowHandler} from "./GameEscrowHandler.sol";
import {FeeRouterHandler} from "./FeeRouterHandler.sol";
import {LiquidityReserveHandler} from "./LiquidityReserveHandler.sol";
import {LmsGovernorHandler} from "./LmsGovernorHandler.sol";
import {LmsTokenHandler} from "./LmsTokenHandler.sol";
import {MultisigPhaseHandler} from "./MultisigPhaseHandler.sol";
import {RewardsDistributorHandler} from "./RewardsDistributorHandler.sol";
import {RewardVestingHandler} from "./RewardVestingHandler.sol";
import {StakedLmsHandler} from "./StakedLmsHandler.sol";
import {ChainlinkVrfAdapterHandler} from "./ChainlinkVrfAdapterHandler.sol";
import {BridgeJoinReceiverHandler} from "./BridgeJoinReceiverHandler.sol";
import {ZapJoinHandler} from "./ZapJoinHandler.sol";
import {ProtocolConfigHandler} from "./ProtocolConfigHandler.sol";
import {SessionKeyDelegateHandler} from "./SessionKeyDelegateHandler.sol";

/// @notice Inherits from all the handlers to expose all entry points in a single contract.
///         Manages environment changes (e.g. current actor, current token, mocks setup, etc.).
abstract contract Handlers is
    GameEscrowHandler,
    FeeRouterHandler,
    LiquidityReserveHandler,
    LmsGovernorHandler,
    LmsTokenHandler,
    MultisigPhaseHandler,
    RewardsDistributorHandler,
    RewardVestingHandler,
    StakedLmsHandler,
    ChainlinkVrfAdapterHandler,
    BridgeJoinReceiverHandler,
    ZapJoinHandler,
    ProtocolConfigHandler,
    SessionKeyDelegateHandler
{
    function setCurrentActor(uint256 entropy) public {
        actor = actors[entropy % actors.length];
    }
}
