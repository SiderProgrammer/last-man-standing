// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {ProtocolConfig} from "./ProtocolConfig.sol";
import {PullPayable} from "./PullPayable.sol";
import {IRandomnessOracle, IRandomnessConsumer} from "./interfaces/IRandomnessOracle.sol";
import {ICrossChainMessenger, ICrossChainReceiver} from "./interfaces/ICrossChainMessenger.sol";
import {SettlementLib} from "./libraries/SettlementLib.sol";
import {SignatureLib} from "./libraries/SignatureLib.sol";
import {SeatSetLib} from "./libraries/SeatSetLib.sol";

/// @title GameEscrow
/// @notice Holds match stakes and pays out against an attested off-chain result.
///
/// @dev The game itself runs off-chain on an authoritative server; this
///      contract never sees a move. It is responsible for four things only:
///      taking stakes, fixing an unpredictable seed before play starts,
///      accepting a result signed by a quorum of attestors, and paying out.
///
///      Trust model. The attestor quorum is trusted for the *ordering* of a
///      result but not for its *contents*: the signed digest commits to a
///      history root, so anyone holding the seed and the published move log
///      can replay the match and prove a signed result was fabricated. The
///      seed is drawn from an oracle after the lobby closes, so neither the
///      server nor a player can pick moves against known rolls.
///
///      Value handling is pull-based throughout. Settlement only ever credits
///      an internal balance; nothing is transferred until the recipient calls
///      `withdraw` or bridges the balance out.
contract GameEscrow is EIP712, PullPayable, IRandomnessConsumer, ICrossChainReceiver {
    enum MatchStatus {
        None,
        /// @dev Accepting joins.
        Open,
        /// @dev Lobby closed, waiting on the randomness oracle.
        Pending,
        /// @dev Seed delivered; the server is running the match.
        Live,
        /// @dev Result attested and payouts credited.
        Settled,
        /// @dev Abandoned; every stake is refundable.
        Cancelled
    }

    /// @dev Terms are snapshotted when the lobby is created, so a governance
    ///      change cannot alter the deal a player already staked into.
    struct MatchInfo {
        uint128 stake;
        uint16 feeBps;
        uint16 minSeats;
        uint16 maxSeats;
        uint16 seatCount;
        MatchStatus status;
        uint64 joinDeadline;
        uint64 settleDeadline;
        uint64 settleWindow;
        address treasury;
        bytes32 rulesHash;
        bytes32 seed;
        bytes32 historyRoot;
    }

    uint16 private constant BPS_DENOMINATOR = 10_000;

    ProtocolConfig public immutable config;

    uint256 public matchNonce;

    mapping(bytes32 matchId => MatchInfo) private matchInfo;
    mapping(bytes32 matchId => address[]) private matchSeats;
    /// @notice Finishing order, best first. Populated only after settlement.
    mapping(bytes32 matchId => address[]) private matchRanking;
    /// @notice Payout schedule snapshotted at lobby creation, in basis points.
    mapping(bytes32 matchId => uint16[]) private matchPayoutBps;
    mapping(bytes32 matchId => mapping(address player => bool)) public hasSeat;
    /// @notice Chain a seat originated from. Zero means this chain.
    mapping(bytes32 matchId => mapping(address player => uint32)) public seatOrigin;
    /// @notice Oracle request handle back to the match it belongs to.
    mapping(bytes32 requestId => bytes32 matchId) public randomnessRequest;

    /// @notice Stakes held for matches that have not yet settled or cancelled.
    /// @dev This and `PullPayable.totalOwed` account for the entire contract
    ///      balance; the solvency invariant is
    ///      `address(this).balance == totalOwed + totalEscrowed`.
    uint256 public totalEscrowed;

    bool public paused;

    event MatchCreated(
        bytes32 indexed matchId, address indexed creator, uint128 stake, uint16 maxSeats, bytes32 rulesHash
    );
    event PlayerJoined(bytes32 indexed matchId, address indexed player, uint16 seat, uint32 originChainId);
    event MatchLocked(bytes32 indexed matchId, bytes32 indexed requestId, uint16 seatCount);
    event MatchStarted(bytes32 indexed matchId, bytes32 seed, uint64 settleDeadline);
    event MatchSettled(
        bytes32 indexed matchId, bytes32 indexed historyRoot, uint32 rounds, address indexed winner
    );
    event PayoutCredited(bytes32 indexed matchId, address indexed player, uint16 rank, uint256 amount);
    event FeeCredited(bytes32 indexed matchId, address indexed treasury, uint256 amount);
    event MatchCancelled(bytes32 indexed matchId, string reason);
    event WithdrawalBridged(address indexed account, uint32 indexed dstChainId, uint256 amount);
    event PausedSet(bool paused);

    error Paused();
    error NotGovernance();
    error NotGuardian();
    error UnknownMatch(bytes32 matchId);
    error WrongStatus(bytes32 matchId, MatchStatus expected, MatchStatus actual);
    error StakeOutOfRange(uint128 stake);
    error SeatsOutOfRange(uint16 maxSeats);
    error IncorrectStake(uint256 sent, uint128 required);
    error LobbyFull(bytes32 matchId);
    error AlreadyJoined(bytes32 matchId, address player);
    error JoinWindowClosed(bytes32 matchId);
    error NotEnoughPlayers(uint16 seatCount, uint16 minSeats);
    error LobbyNotReady(bytes32 matchId);
    error NotOracle(address caller);
    error UnknownRequest(bytes32 requestId);
    error UntrustedMessenger(uint32 srcChainId, address caller);
    error UntrustedPeer(uint32 srcChainId, bytes32 peer);
    error NoMessengerForChain(uint32 dstChainId);
    error QuorumNotMet(uint256 signers, uint32 threshold);
    error NotAnAttestor(address signer);
    error CannotCancelYet(bytes32 matchId);
    error RoundsOutOfRange(uint32 rounds);

    constructor(ProtocolConfig config_) EIP712("LastManStanding", "1") {
        config = config_;
    }

    modifier onlyGovernance() {
        if (msg.sender != config.owner()) revert NotGovernance();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    // --- Lobby -------------------------------------------------------------

    /// @notice Opens a lobby with terms fixed from the current configuration.
    /// @param stake Per-seat stake in wei.
    /// @param maxSeats Seats in the lobby.
    function createMatch(uint128 stake, uint16 maxSeats)
        external
        whenNotPaused
        returns (bytes32 matchId)
    {
        ProtocolConfig.Params memory params = config.getParams();

        if (stake < params.minStake || stake > params.maxStake) revert StakeOutOfRange(stake);
        if (maxSeats < params.minSeats || maxSeats > params.maxSeats) revert SeatsOutOfRange(maxSeats);

        matchId = keccak256(abi.encode(block.chainid, address(this), matchNonce++));

        matchInfo[matchId] = MatchInfo({
            stake: stake,
            feeBps: params.feeBps,
            minSeats: params.minSeats,
            maxSeats: maxSeats,
            seatCount: 0,
            status: MatchStatus.Open,
            joinDeadline: uint64(block.timestamp) + params.joinWindow,
            settleDeadline: 0,
            settleWindow: params.settleWindow,
            treasury: params.treasury,
            rulesHash: config.rulesHash(),
            seed: bytes32(0),
            historyRoot: bytes32(0)
        });
        matchPayoutBps[matchId] = config.getPayoutSchedule();

        emit MatchCreated(matchId, msg.sender, stake, maxSeats, matchInfo[matchId].rulesHash);
    }

    /// @notice Takes a seat by staking on this chain.
    function join(bytes32 matchId) external payable whenNotPaused {
        MatchInfo storage info = _open(matchId);
        if (msg.value != info.stake) revert IncorrectStake(msg.value, info.stake);
        _seat(matchId, info, msg.sender, 0);
    }

    /// @notice Takes a seat on behalf of a player whose stake arrived from another chain.
    /// @dev The transport delivers the staked value together with the message,
    ///      so the hub always holds the full prize pool. Both the calling
    ///      messenger and the originating peer contract are authenticated:
    ///      a trusted transport still relays messages from untrusted senders.
    function receiveMessage(uint32 srcChainId, bytes32 srcSender, bytes calldata payload)
        external
        payable
        whenNotPaused
    {
        if (config.messengerFor(srcChainId) != msg.sender) {
            revert UntrustedMessenger(srcChainId, msg.sender);
        }
        if (config.peerFor(srcChainId) != srcSender) revert UntrustedPeer(srcChainId, srcSender);

        (bytes32 matchId, address player) = abi.decode(payload, (bytes32, address));

        MatchInfo storage info = _open(matchId);
        if (msg.value != info.stake) revert IncorrectStake(msg.value, info.stake);
        _seat(matchId, info, player, srcChainId);
    }

    /// @notice Closes the lobby and asks the oracle for a seed.
    /// @dev Permissionless: anyone may close a full lobby, and anyone may close
    ///      an under-filled but quorate one once the join window has expired.
    ///      Randomness is requested only after the seat list is final, so no
    ///      player can decide whether to join based on the seed.
    function lockMatch(bytes32 matchId) external whenNotPaused returns (bytes32 requestId) {
        MatchInfo storage info = _open(matchId);

        bool full = info.seatCount == info.maxSeats;
        bool expired = block.timestamp >= info.joinDeadline;
        if (!full && !expired) revert LobbyNotReady(matchId);
        if (info.seatCount < info.minSeats) revert NotEnoughPlayers(info.seatCount, info.minSeats);

        info.status = MatchStatus.Pending;

        requestId = IRandomnessOracle(config.randomnessOracle()).requestRandomness(matchId);
        randomnessRequest[requestId] = matchId;

        emit MatchLocked(matchId, requestId, info.seatCount);
    }

    /// @inheritdoc IRandomnessConsumer
    function fulfillRandomness(bytes32 requestId, bytes32 randomness) external {
        if (msg.sender != config.randomnessOracle()) revert NotOracle(msg.sender);

        bytes32 matchId = randomnessRequest[requestId];
        if (matchId == bytes32(0)) revert UnknownRequest(requestId);
        delete randomnessRequest[requestId];

        MatchInfo storage info = matchInfo[matchId];
        if (info.status != MatchStatus.Pending) {
            revert WrongStatus(matchId, MatchStatus.Pending, info.status);
        }

        // Bind the seed to the match so one oracle response cannot seed two
        // matches, and so a zero response is still a usable seed.
        bytes32 seed = keccak256(abi.encode(randomness, matchId));
        uint64 settleDeadline = uint64(block.timestamp) + info.settleWindow;

        info.seed = seed;
        info.settleDeadline = settleDeadline;
        info.status = MatchStatus.Live;

        emit MatchStarted(matchId, seed, settleDeadline);
    }

    // --- Settlement --------------------------------------------------------

    /// @notice Settles a match against a result signed by a quorum of attestors.
    /// @param ranking Finishing order, best first. Must be exactly the seat set.
    /// @param signatures Concatenated 65-byte signatures in ascending signer order.
    function settle(
        bytes32 matchId,
        uint32 rounds,
        bytes32 historyRoot,
        address[] calldata ranking,
        bytes calldata signatures
    ) external nonReentrant whenNotPaused {
        MatchInfo storage info = matchInfo[matchId];
        if (info.status != MatchStatus.Live) {
            revert WrongStatus(matchId, MatchStatus.Live, info.status);
        }
        if (rounds == 0) revert RoundsOutOfRange(rounds);

        bytes32 digest = SettlementLib.toTypedDataHash(
            _domainSeparatorV4(), SettlementLib.hashMatchResult(matchId, rounds, historyRoot, ranking)
        );

        address[] memory signers = SignatureLib.recoverAscending(digest, signatures);
        uint32 threshold = config.attestorThreshold();
        if (signers.length < threshold) revert QuorumNotMet(signers.length, threshold);
        for (uint256 i = 0; i < signers.length; ++i) {
            if (!config.isAttestor(signers[i])) revert NotAnAttestor(signers[i]);
        }

        // Reject any ranking that is not exactly the seat set: without this a
        // quorum could redirect the pool to addresses that never staked.
        SeatSetLib.assertPermutation(matchSeats[matchId], ranking);

        info.status = MatchStatus.Settled;
        info.historyRoot = historyRoot;

        matchRanking[matchId] = ranking;

        totalEscrowed -= uint256(info.stake) * info.seatCount;
        _distribute(matchId, info, ranking);

        emit MatchSettled(matchId, historyRoot, rounds, ranking[0]);
    }

    function _distribute(bytes32 matchId, MatchInfo storage info, address[] calldata ranking) private {
        uint256 pool = uint256(info.stake) * info.seatCount;
        uint256 distributable = pool - (pool * info.feeBps) / BPS_DENOMINATOR;

        uint16[] memory schedule = matchPayoutBps[matchId];
        uint256 paid;

        for (uint256 i = 0; i < schedule.length; ++i) {
            uint256 amount = (distributable * schedule[i]) / BPS_DENOMINATOR;
            if (amount == 0) continue;
            paid += amount;
            _credit(ranking[i], amount);
            // Safe: `i` is bounded by the schedule length, itself bounded by
            // `minSeats <= ABSOLUTE_MAX_SEATS` (256).
            // forge-lint: disable-next-line(unsafe-typecast)
            emit PayoutCredited(matchId, ranking[i], uint16(i), amount);
        }

        // The treasury takes the fee plus whatever integer division left behind,
        // so the pool is always fully assigned and nothing can be stranded.
        uint256 remainder = pool - paid;
        if (remainder > 0) {
            _credit(info.treasury, remainder);
            emit FeeCredited(matchId, info.treasury, remainder);
        }
    }

    // --- Cancellation ------------------------------------------------------

    /// @notice Refunds every stake in a match that can no longer complete.
    /// @dev Permissionless once the relevant deadline has passed, so players
    ///      are never dependent on the operator to recover their stake.
    function cancelMatch(bytes32 matchId) external nonReentrant {
        MatchInfo storage info = matchInfo[matchId];
        string memory reason;

        if (info.status == MatchStatus.Open) {
            // An under-filled lobby that expired can never reach `minSeats`.
            if (block.timestamp < info.joinDeadline) revert CannotCancelYet(matchId);
            reason = "join window expired";
        } else if (info.status == MatchStatus.Pending) {
            // The oracle never answered.
            if (block.timestamp < info.joinDeadline + info.settleWindow) revert CannotCancelYet(matchId);
            reason = "randomness not delivered";
        } else if (info.status == MatchStatus.Live) {
            // No quorum produced a result in time.
            if (block.timestamp < info.settleDeadline) revert CannotCancelYet(matchId);
            reason = "settlement deadline passed";
        } else {
            revert WrongStatus(matchId, MatchStatus.Live, info.status);
        }

        info.status = MatchStatus.Cancelled;

        address[] memory seats = matchSeats[matchId];
        uint128 stake = info.stake;
        totalEscrowed -= uint256(stake) * seats.length;
        for (uint256 i = 0; i < seats.length; ++i) {
            _credit(seats[i], stake);
        }

        emit MatchCancelled(matchId, reason);
    }

    // --- Balances ----------------------------------------------------------

    /// @notice Sends the caller's balance to another chain through the transport.
    /// @dev `msg.value` pays the transport fee; the balance itself is forwarded
    ///      alongside the message. Used by players who staked from a spoke chain.
    function withdrawToChain(uint32 dstChainId) external payable nonReentrant returns (uint256 amount) {
        address messenger = config.messengerFor(dstChainId);
        if (messenger == address(0)) revert NoMessengerForChain(dstChainId);

        amount = _takeBalance(msg.sender);

        ICrossChainMessenger(messenger).sendMessage{value: amount + msg.value}(
            dstChainId, config.peerFor(dstChainId), abi.encode(msg.sender, amount)
        );

        emit WithdrawalBridged(msg.sender, dstChainId, amount);
    }

    // --- Governance --------------------------------------------------------

    /// @notice Halts new lobbies, joins, and settlement. Refunds stay open.
    /// @dev Open to the guardian, which skips the timelock delay, and to
    ///      governance, so a pause is still possible with no guardian set.
    ///      `cancelMatch` and `withdraw` are deliberately not gated: pausing
    ///      must never trap player funds.
    function pause() external {
        if (msg.sender != config.guardian() && msg.sender != config.owner()) revert NotGuardian();
        paused = true;
        emit PausedSet(true);
    }

    /// @notice Resumes play. Governance only, so it always waits out the timelock.
    /// @dev Deliberately not open to the guardian: lifting a pause that was put
    ///      in place to stop an exploit re-opens it. See `ProtocolConfig.guardian`.
    function unpause() external onlyGovernance {
        paused = false;
        emit PausedSet(false);
    }

    // --- Views -------------------------------------------------------------

    function getMatch(bytes32 matchId) external view returns (MatchInfo memory) {
        return matchInfo[matchId];
    }

    function getSeats(bytes32 matchId) external view returns (address[] memory) {
        return matchSeats[matchId];
    }

    function getRanking(bytes32 matchId) external view returns (address[] memory) {
        return matchRanking[matchId];
    }

    function getPayoutSchedule(bytes32 matchId) external view returns (uint16[] memory) {
        return matchPayoutBps[matchId];
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // --- Internal ----------------------------------------------------------

    function _open(bytes32 matchId) private view returns (MatchInfo storage info) {
        info = matchInfo[matchId];
        if (info.status == MatchStatus.None) revert UnknownMatch(matchId);
        if (info.status != MatchStatus.Open) {
            revert WrongStatus(matchId, MatchStatus.Open, info.status);
        }
    }

    function _seat(bytes32 matchId, MatchInfo storage info, address player, uint32 originChainId)
        private
    {
        if (block.timestamp >= info.joinDeadline) revert JoinWindowClosed(matchId);
        if (info.seatCount >= info.maxSeats) revert LobbyFull(matchId);
        if (hasSeat[matchId][player]) revert AlreadyJoined(matchId, player);

        hasSeat[matchId][player] = true;
        if (originChainId != 0) seatOrigin[matchId][player] = originChainId;

        uint16 seat = info.seatCount;
        matchSeats[matchId].push(player);
        info.seatCount = seat + 1;
        totalEscrowed += info.stake;

        emit PlayerJoined(matchId, player, seat, originChainId);
    }

}
