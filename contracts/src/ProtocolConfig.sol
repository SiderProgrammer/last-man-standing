// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {BPS_DENOMINATOR, DISPUTE_EXTENSION, LOCK_GRACE, RANDOMNESS_TIMEOUT} from "./Constants.sol";
import {ZeroAddress} from "./Errors.sol";

/// @title ProtocolConfig
/// @notice Every governable parameter of the protocol, in one place.
/// @dev The owner is intended to be a `TimelockController` whose proposer is a
///      multisig, so parameter changes are queued in public before they take
///      effect. The one thing that cannot wait out the delay is an emergency
///      stop, which is why the `guardian` exists alongside the owner.
///      `GameEscrow` reads this contract but never writes to it, and it
///      snapshots the values that must not move underneath a running match:
///      the terms when a lobby opens, the oracle and attestor set when it locks.
///
///      A change queued in the timelock must not reach a match that was already
///      open when it was queued, so the owner's delay has to outlast a whole
///      match. That is checked here whenever the windows or the owner change;
///      see `matchLifetime`.
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

    /// @notice The attestor set new matches lock under. Every change makes a
    ///         new version; a match keeps the one it locked under.
    /// @dev Zero means no set yet.
    uint32 public attestorSetVersion;
    mapping(uint32 version => address[]) private attestorsOf;
    mapping(uint32 version => mapping(address attestor => bool)) private attestorIn;
    /// @notice Signatures from `version`'s set required to settle a match.
    mapping(uint32 version => uint32) public thresholdOf;

    /// @notice May pause the escrow, and veto a proposed result, immediately,
    ///         without the timelock delay.
    /// @dev Both only ever stop money moving: resuming still goes through the
    ///      owner, and a veto refunds every stake rather than redirecting it. A
    ///      compromised guardian can therefore halt play and void results, but
    ///      never take a stake or lift a pause put in place to stop an exploit.
    address public guardian;

    /// @notice Seconds a proposed result waits before it pays out, during
    ///         which the guardian may veto it. See `GameEscrow.veto`.
    /// @dev Snapshotted into each lobby at creation, like the other terms.
    uint64 public challengeWindow;

    /// @dev Longest a lobby may stay open, or a match run.
    uint64 public constant MAX_WINDOW = 30 days;
    /// @dev Longest a payout may be held for review.
    uint64 public constant MAX_CHALLENGE_WINDOW = 7 days;

    /// @notice Trusted messenger per remote chain, for cross-chain joins.
    mapping(uint32 chainId => address messenger) public messengerFor;
    /// @notice Trusted peer contract per remote chain.
    mapping(uint32 chainId => bytes32 peer) public peerFor;

    event ParamsUpdated(Params params);
    event RulesHashUpdated(bytes32 indexed previous, bytes32 indexed current);
    event PayoutScheduleUpdated(uint16[] payoutBps);
    event RandomnessOracleUpdated(address indexed previous, address indexed current);
    event AttestorSetUpdated(uint32 indexed version, address[] attestors, uint32 threshold);
    event RemoteChainUpdated(uint32 indexed chainId, address messenger, bytes32 peer);
    event GuardianUpdated(address indexed previous, address indexed current);
    event ChallengeWindowUpdated(uint64 previous, uint64 current);

    error FeeTooHigh(uint16 feeBps);
    error InvalidSeatRange(uint16 minSeats, uint16 maxSeats);
    error InvalidStakeRange(uint128 minStake, uint128 maxStake);
    error InvalidWindow();
    error PayoutScheduleEmpty();
    error PayoutScheduleTooLong(uint256 length, uint16 minSeats);
    error PayoutScheduleNotExact(uint256 totalBps);
    error ThresholdOutOfRange(uint32 threshold, uint256 attestors);
    error DuplicateAttestor(address attestor);
    error DelayTooShort(uint256 delay, uint256 matchLifetime);
    error InvalidRulesHash();
    error InvalidChallengeWindow(uint64 window);

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

    /// @notice Whether `account` is in the current attestor set.
    function isAttestor(address account) external view returns (bool) {
        return attestorIn[attestorSetVersion][account];
    }

    /// @notice Signatures the current attestor set requires.
    function attestorThreshold() external view returns (uint32) {
        return thresholdOf[attestorSetVersion];
    }

    function isAttestorAt(uint32 version, address account) external view returns (bool) {
        return attestorIn[version][account];
    }

    function getAttestors(uint32 version) external view returns (address[] memory) {
        return attestorsOf[version];
    }

    /// @notice The longest a match can take from its lobby opening to its
    ///         payout: joining, the lock grace, waiting on the seed, playing,
    ///         the challenge window and a dispute.
    function matchLifetime() public view returns (uint256) {
        return uint256(params.joinWindow) + LOCK_GRACE + RANDOMNESS_TIMEOUT + params.settleWindow
            + challengeWindow + DISPUTE_EXTENSION;
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

    /// @notice Replaces the attestor set with a new version.
    /// @dev Matches already locked keep the version they locked under, so a
    ///      key removed here can still settle those. That is what the timelock
    ///      delay covers: every such match ends before the change executes.
    function setAttestorSet(address[] calldata attestors, uint32 threshold) external onlyOwner {
        if (threshold == 0 || threshold > attestors.length) {
            revert ThresholdOutOfRange(threshold, attestors.length);
        }
        uint32 version = attestorSetVersion + 1;
        for (uint256 i = 0; i < attestors.length; ++i) {
            address attestor = attestors[i];
            if (attestor == address(0)) revert ZeroAddress();
            if (attestorIn[version][attestor]) revert DuplicateAttestor(attestor);
            attestorIn[version][attestor] = true;
        }
        attestorsOf[version] = attestors;
        thresholdOf[version] = threshold;
        attestorSetVersion = version;
        emit AttestorSetUpdated(version, attestors, threshold);
    }

    /// @notice Sets the emergency pauser. The zero address removes it.
    function setGuardian(address newGuardian) external onlyOwner {
        emit GuardianUpdated(guardian, newGuardian);
        guardian = newGuardian;
    }

    /// @dev Long enough for someone to replay a disputed match and the guardian
    ///      to act on it; short enough that winners are not kept waiting. Never
    ///      zero: a zero window would pay out before anyone could object.
    function setChallengeWindow(uint64 window) external onlyOwner {
        if (window == 0 || window > MAX_CHALLENGE_WINDOW) revert InvalidChallengeWindow(window);
        emit ChallengeWindowUpdated(challengeWindow, window);
        challengeWindow = window;
        _checkDelay();
    }

    /// @notice True once everything a lobby needs from the config is set.
    function isComplete() external view returns (bool) {
        return rulesHash != bytes32(0) && randomnessOracle != address(0) && challengeWindow != 0
            && attestorSetVersion != 0;
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
        if (
            newParams.joinWindow == 0 || newParams.settleWindow == 0 || newParams.joinWindow > MAX_WINDOW
                || newParams.settleWindow > MAX_WINDOW
        ) revert InvalidWindow();
        if (newParams.treasury == address(0)) revert ZeroAddress();

        // A schedule that was valid for a bigger lobby must not survive a
        // reduction of `minSeats`.
        if (payoutBps.length > newParams.minSeats) {
            revert PayoutScheduleTooLong(payoutBps.length, newParams.minSeats);
        }

        params = newParams;
        emit ParamsUpdated(newParams);
        _checkDelay();
    }

    /// @dev Also runs when ownership moves, so the config can never be handed
    ///      to a timelock whose delay is too short.
    function _transferOwnership(address newOwner) internal override {
        super._transferOwnership(newOwner);
        _checkDelay();
    }

    /// @dev The owner's delay must outlast a match, or a change queued while a
    ///      match is open could execute before it ends. An owner with no code
    ///      has no delay to read: that is a development deployment, or the
    ///      deploy script before it hands the config over.
    function _checkDelay() private view {
        address currentOwner = owner();
        if (currentOwner.code.length == 0) return;
        uint256 delay = TimelockController(payable(currentOwner)).getMinDelay();
        uint256 lifetime = matchLifetime();
        if (delay <= lifetime) revert DelayTooShort(delay, lifetime);
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
