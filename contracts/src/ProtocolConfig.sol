// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ZeroAddress} from "./Errors.sol";

/// @title ProtocolConfig
/// @notice Every governable parameter of the protocol, in one place.
/// @dev The owner is intended to be a `TimelockController` whose proposer is a
///      multisig, so parameter changes are queued in public before they take
///      effect. The one thing that cannot wait out the delay is an emergency
///      stop, which is why the `guardian` exists alongside the owner.
///      `GameEscrow` reads this contract but never writes to it, and it
///      snapshots the values that must not move underneath a running match.
contract ProtocolConfig is Ownable2Step {
    /// @notice Economic and lobby parameters.
    struct Params {
        /// @dev Protocol cut of the prize pool, in basis points.
        uint16 feeBps;
        /// @dev Smallest lobby that may start.
        uint16 minSeats;
        /// @dev Largest lobby that may be created.
        uint16 maxSeats;
        /// @dev Seconds a lobby may stay open before it can be cancelled.
        uint64 joinWindow;
        /// @dev Seconds after lock before a match may be force-refunded.
        uint64 settleWindow;
        uint128 minStake;
        uint128 maxStake;
        address treasury;
    }

    uint16 public constant BPS_DENOMINATOR = 10_000;
    /// @dev Hard ceiling on the protocol fee. Governance cannot exceed it.
    uint16 public constant MAX_FEE_BPS = 1_000;
    /// @dev Seat index is a uint8 in the commit preimage, so 256 is the cap.
    uint16 public constant ABSOLUTE_MAX_SEATS = 256;

    Params private params;

    /// @notice Digest of the off-chain rule set matches must be played under.
    /// @dev Mirrors `hashRules()` in `@lms/protocol`. Bumping it invalidates
    ///      results produced under the previous rules.
    bytes32 public rulesHash;

    /// @notice Share of the prize pool per finishing position, in basis points.
    uint16[] private payoutBps;

    /// @notice Seed source for new matches.
    address public randomnessOracle;

    /// @notice Addresses allowed to co-sign match results.
    mapping(address attestor => bool allowed) public isAttestor;
    uint32 public attestorCount;
    /// @notice Signatures required to settle a match.
    uint32 public attestorThreshold;

    /// @notice May pause the escrow immediately, without the timelock delay.
    /// @dev Pause only: resuming still goes through the owner. A compromised
    ///      guardian can therefore halt new play, which refunds survive, but
    ///      never lift a pause that was put in place to stop an exploit.
    address public guardian;

    /// @notice Trusted messenger per remote chain, for cross-chain joins.
    mapping(uint32 chainId => address messenger) public messengerFor;
    /// @notice Trusted peer contract per remote chain.
    mapping(uint32 chainId => bytes32 peer) public peerFor;

    event ParamsUpdated(Params params);
    event RulesHashUpdated(bytes32 indexed previous, bytes32 indexed current);
    event PayoutScheduleUpdated(uint16[] payoutBps);
    event RandomnessOracleUpdated(address indexed previous, address indexed current);
    event AttestorUpdated(address indexed attestor, bool allowed);
    event AttestorThresholdUpdated(uint32 previous, uint32 current);
    event RemoteChainUpdated(uint32 indexed chainId, address messenger, bytes32 peer);
    event GuardianUpdated(address indexed previous, address indexed current);

    error FeeTooHigh(uint16 feeBps);
    error InvalidSeatRange(uint16 minSeats, uint16 maxSeats);
    error InvalidStakeRange(uint128 minStake, uint128 maxStake);
    error InvalidWindow();
    error PayoutScheduleEmpty();
    error PayoutScheduleTooLong(uint256 length, uint16 minSeats);
    error PayoutScheduleNotExact(uint256 totalBps);
    error ThresholdOutOfRange(uint32 threshold, uint32 attestors);
    error InvalidRulesHash();

    constructor(address owner_, Params memory initialParams, uint16[] memory initialPayoutBps)
        Ownable(owner_)
    {
        _setParams(initialParams);
        _setPayoutSchedule(initialPayoutBps);
    }

    // --- Reads -------------------------------------------------------------

    function getParams() external view returns (Params memory) {
        return params;
    }

    function getPayoutSchedule() external view returns (uint16[] memory) {
        return payoutBps;
    }

    function feeBps() external view returns (uint16) {
        return params.feeBps;
    }

    function treasury() external view returns (address) {
        return params.treasury;
    }

    /// @notice Total basis points actually paid out to players.
    function payoutBpsTotal() external view returns (uint256 total) {
        uint256 length = payoutBps.length;
        for (uint256 i = 0; i < length; ++i) {
            total += payoutBps[i];
        }
    }

    // --- Governance --------------------------------------------------------

    function setParams(Params calldata newParams) external onlyOwner {
        _setParams(newParams);
    }

    /// @dev Zero is reserved for "never set": the escrow refuses to open a
    ///      lobby against it, so it must not be settable on purpose either.
    function setRulesHash(bytes32 newRulesHash) external onlyOwner {
        if (newRulesHash == bytes32(0)) revert InvalidRulesHash();
        emit RulesHashUpdated(rulesHash, newRulesHash);
        rulesHash = newRulesHash;
    }

    function setPayoutSchedule(uint16[] calldata newSchedule) external onlyOwner {
        _setPayoutSchedule(newSchedule);
    }

    function setRandomnessOracle(address oracle) external onlyOwner {
        if (oracle == address(0)) revert ZeroAddress();
        emit RandomnessOracleUpdated(randomnessOracle, oracle);
        randomnessOracle = oracle;
    }

    /// @dev The threshold is re-validated on every membership change so the
    ///      attestor set can never be shrunk below its own quorum.
    function setAttestor(address attestor, bool allowed) external onlyOwner {
        if (attestor == address(0)) revert ZeroAddress();
        if (isAttestor[attestor] == allowed) return;

        isAttestor[attestor] = allowed;
        attestorCount = allowed ? attestorCount + 1 : attestorCount - 1;

        if (attestorThreshold > attestorCount) {
            revert ThresholdOutOfRange(attestorThreshold, attestorCount);
        }
        emit AttestorUpdated(attestor, allowed);
    }

    function setAttestorThreshold(uint32 threshold) external onlyOwner {
        if (threshold == 0 || threshold > attestorCount) {
            revert ThresholdOutOfRange(threshold, attestorCount);
        }
        emit AttestorThresholdUpdated(attestorThreshold, threshold);
        attestorThreshold = threshold;
    }

    /// @notice Sets the emergency pauser. The zero address removes it.
    function setGuardian(address newGuardian) external onlyOwner {
        emit GuardianUpdated(guardian, newGuardian);
        guardian = newGuardian;
    }

    /// @notice Registers, or with zero arguments removes, a remote chain.
    function setRemoteChain(uint32 chainId, address messenger, bytes32 peer) external onlyOwner {
        messengerFor[chainId] = messenger;
        peerFor[chainId] = peer;
        emit RemoteChainUpdated(chainId, messenger, peer);
    }

    // --- Internal ----------------------------------------------------------

    function _setParams(Params memory newParams) private {
        if (newParams.feeBps > MAX_FEE_BPS) revert FeeTooHigh(newParams.feeBps);
        if (
            newParams.minSeats < 2 || newParams.maxSeats < newParams.minSeats
                || newParams.maxSeats > ABSOLUTE_MAX_SEATS
        ) {
            revert InvalidSeatRange(newParams.minSeats, newParams.maxSeats);
        }
        if (newParams.minStake == 0 || newParams.maxStake < newParams.minStake) {
            revert InvalidStakeRange(newParams.minStake, newParams.maxStake);
        }
        if (newParams.joinWindow == 0 || newParams.settleWindow == 0) revert InvalidWindow();
        if (newParams.treasury == address(0)) revert ZeroAddress();

        // A schedule that was valid for a bigger lobby must not survive a
        // reduction of `minSeats`.
        if (payoutBps.length > newParams.minSeats) {
            revert PayoutScheduleTooLong(payoutBps.length, newParams.minSeats);
        }

        params = newParams;
        emit ParamsUpdated(newParams);
    }

    function _setPayoutSchedule(uint16[] memory newSchedule) private {
        uint256 length = newSchedule.length;
        if (length == 0) revert PayoutScheduleEmpty();

        // Every lobby must have at least as many players as paid positions,
        // otherwise settlement would index past the ranking.
        if (params.minSeats != 0 && length > params.minSeats) {
            revert PayoutScheduleTooLong(length, params.minSeats);
        }

        // Must be exact. A schedule summing to less than 100% would silently
        // divert the shortfall to the treasury on every settlement.
        uint256 total;
        for (uint256 i = 0; i < length; ++i) {
            total += newSchedule[i];
        }
        if (total != BPS_DENOMINATOR) revert PayoutScheduleNotExact(total);

        payoutBps = newSchedule;
        emit PayoutScheduleUpdated(newSchedule);
    }
}
