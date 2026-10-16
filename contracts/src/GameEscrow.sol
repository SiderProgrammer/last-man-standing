// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {ProtocolConfig} from "./ProtocolConfig.sol";
import {PullPayable} from "./PullPayable.sol";
import {ZeroAddress} from "./Errors.sol";
import {IRandomnessOracle, IRandomnessConsumer} from "./interfaces/IRandomnessOracle.sol";
import {ICrossChainReceiver} from "./interfaces/ICrossChainMessenger.sol";
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
///      Trust model. A result is signed by a quorum of allowlisted attestors
///      and then waits out a challenge window before it pays. The signed
///      digest commits to a history root, which commits to every round, so
///      anyone holding the published rounds can replay the match off-chain and
///      see whether the result follows from them. During the window the
///      guardian may veto a result, which refunds every stake: disputes are
///      decided by that replay and the guardian acting on it, not on-chain.
///      The seed is drawn from an oracle after the lobby closes, and each
///      round's rolls also depend on every player's revealed salt.
///
///      Value handling is pull-based throughout. Settlement only ever credits
///      an internal balance; nothing is transferred until the recipient — or
///      anyone, on their behalf and to their address — withdraws it.
contract GameEscrow is EIP712, PullPayable, IRandomnessConsumer, ICrossChainReceiver {
    enum MatchStatus {
        None,
        /// @dev Accepting joins.
        Open,
        /// @dev Lobby closed, waiting on the randomness oracle.
        Pending,
        /// @dev Seed delivered; the server is running the match.
        Live,
        /// @dev Result final and payouts credited.
        Settled,
        /// @dev Abandoned, or its result vetoed; every stake is refundable.
        Cancelled,
        /// @dev Result signed and open to a veto until `challengeDeadline`.
        ///      Last in the list so the earlier values keep their numbers.
        Proposed
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
        /// @dev Snapshotted at creation, like the rest of the terms.
        uint64 challengeWindow;
        uint64 challengeDeadline;
        uint32 rounds;
        /// @dev The ranking of a proposed result, by hash: it is in
        ///      `ResultProposed`, and whoever finalises passes it back.
        bytes32 rankingHash;
    }

    /// @notice Why a seat could not be taken. `None` means it could.
    enum JoinFailure {
        None,
        Paused,
        UnknownMatch,
        NotOpen,
        WindowClosed,
        LobbyFull,
        AlreadyJoined,
        WrongStake
    }

    uint16 private constant BPS_DENOMINATOR = 10_000;

    ProtocolConfig public immutable config;

    uint256 public matchNonce;

    mapping(bytes32 matchId => MatchInfo) private matchInfo;
    mapping(bytes32 matchId => address[]) private matchSeats;
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
    event ResultProposed(
        bytes32 indexed matchId,
        bytes32 indexed historyRoot,
        uint32 rounds,
        address[] ranking,
        uint64 challengeDeadline
    );
    event MatchSettled(
        bytes32 indexed matchId, bytes32 indexed historyRoot, uint32 rounds, address indexed winner
    );
    event ResultVetoed(bytes32 indexed matchId, address indexed by);
    event PayoutCredited(bytes32 indexed matchId, address indexed player, uint16 rank, uint256 amount);
    event FeeCredited(bytes32 indexed matchId, address indexed treasury, uint256 amount);
    event MatchCancelled(bytes32 indexed matchId, string reason);
    /// @notice A cross-chain stake arrived for a seat that could no longer be
    ///         taken, and was credited back to the player here instead.
    event JoinRefunded(bytes32 indexed matchId, address indexed player, uint256 amount, JoinFailure reason);
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
    error QuorumNotMet(uint256 signers, uint32 threshold);
    error NotAnAttestor(address signer);
    error CannotCancelYet(bytes32 matchId);
    error RoundsOutOfRange(uint32 rounds);
    error ConfigIncomplete();
    error ChallengeWindowOpen(uint64 deadline);
    error ChallengeWindowClosed(uint64 deadline);
    error RankingMismatch();

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

        // A config deploys with none of these set. A lobby opened against it
        // could never be seeded, would snapshot a rule set nobody plays
        // under, or could never settle.
        if (!config.isComplete()) revert ConfigIncomplete();
        bytes32 rulesHash = config.rulesHash();

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
            rulesHash: rulesHash,
            seed: bytes32(0),
            historyRoot: bytes32(0),
            challengeWindow: config.challengeWindow(),
            challengeDeadline: 0,
            rounds: 0,
            rankingHash: bytes32(0)
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

    /// @notice Takes a seat for `player`, with the stake paid by the caller.
    /// @dev For periphery contracts that acquire the stake on the player's
    ///      behalf, such as `ZapJoin` swapping a token into ETH. The seat, any
    ///      refund and any payout all belong to `player`; the caller gets
    ///      nothing back. That is also why it needs no consent from `player`:
    ///      being paid into a lobby can only ever credit them, never charge them.
    function joinFor(bytes32 matchId, address player) external payable whenNotPaused {
        if (player == address(0)) revert ZeroAddress();
        MatchInfo storage info = _open(matchId);
        if (msg.value != info.stake) revert IncorrectStake(msg.value, info.stake);
        _seat(matchId, info, player, 0);
    }

    /// @notice Takes a seat on behalf of a player whose stake arrived from another chain.
    /// @dev The transport delivers the staked value together with the message,
    ///      so the hub always holds the full prize pool. Both the calling
    ///      messenger and the originating peer contract are authenticated:
    ///      a trusted transport still relays messages from untrusted senders.
    ///
    ///      Once authenticated, this never reverts. The stake has already left
    ///      the spoke; a revert here would leave it with the transport, stuck.
    ///      If the seat cannot be taken — the lobby filled or closed while the
    ///      message was in flight, the stake was wrong, the escrow is paused —
    ///      the value is credited to the player on this chain instead, to
    ///      withdraw like any other refund.
    function receiveMessage(uint32 srcChainId, bytes32 srcSender, bytes calldata payload)
        external
        payable
    {
        if (config.messengerFor(srcChainId) != msg.sender) {
            revert UntrustedMessenger(srcChainId, msg.sender);
        }
        if (config.peerFor(srcChainId) != srcSender) revert UntrustedPeer(srcChainId, srcSender);

        (bytes32 matchId, address player) = abi.decode(payload, (bytes32, address));

        MatchInfo storage info = matchInfo[matchId];
        JoinFailure failure = _joinFailure(matchId, info, player, msg.value);
        if (failure != JoinFailure.None) {
            _credit(player, msg.value);
            emit JoinRefunded(matchId, player, msg.value, failure);
            return;
        }
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

    /// @notice Proposes a match result signed by a quorum of attestors.
    /// @dev Pays nothing yet. The result is open to `veto` until
    ///      `challengeDeadline`; after that anyone may `finalize` it.
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

        _checkQuorum(
            SettlementLib.toTypedDataHash(
                _domainSeparatorV4(), SettlementLib.hashMatchResult(matchId, rounds, historyRoot, ranking)
            ),
            signatures
        );

        // Reject any ranking that is not exactly the seat set: without this a
        // quorum could redirect the pool to addresses that never staked.
        SeatSetLib.assertPermutation(matchSeats[matchId], ranking);

        uint64 deadline = uint64(block.timestamp) + info.challengeWindow;
        info.status = MatchStatus.Proposed;
        info.historyRoot = historyRoot;
        info.rounds = rounds;
        info.challengeDeadline = deadline;
        info.rankingHash = keccak256(abi.encode(ranking));

        emit ResultProposed(matchId, historyRoot, rounds, ranking, deadline);
    }

    /// @dev Reverts unless `signatures` over `digest` come from a quorum of
    ///      allowlisted attestors.
    function _checkQuorum(bytes32 digest, bytes calldata signatures) private view {
        address[] memory signers = SignatureLib.recoverAscending(digest, signatures);
        uint32 threshold = config.attestorThreshold();
        if (signers.length < threshold) revert QuorumNotMet(signers.length, threshold);
        for (uint256 i = 0; i < signers.length; ++i) {
            if (!config.isAttestor(signers[i])) revert NotAnAttestor(signers[i]);
        }
    }

    /// @notice Pays out a proposed result once its challenge window has closed unvetoed.
    /// @dev Permissionless, and deliberately not paused: a pause must never
    ///      hold a result that has already survived its challenge window.
    /// @param ranking The ranking from `ResultProposed`.
    function finalize(bytes32 matchId, address[] calldata ranking) external nonReentrant {
        MatchInfo storage info = matchInfo[matchId];
        if (info.status != MatchStatus.Proposed) {
            revert WrongStatus(matchId, MatchStatus.Proposed, info.status);
        }
        if (block.timestamp < info.challengeDeadline) revert ChallengeWindowOpen(info.challengeDeadline);
        if (keccak256(abi.encode(ranking)) != info.rankingHash) revert RankingMismatch();

        info.status = MatchStatus.Settled;
        totalEscrowed -= uint256(info.stake) * info.seatCount;
        _distribute(matchId, info, ranking);

        emit MatchSettled(matchId, info.historyRoot, info.rounds, ranking[0]);
    }

    /// @notice Throws out a proposed result and refunds every stake.
    /// @dev For a result that a replay of its published rounds does not
    ///      support. The replay happens off-chain; this is the guardian acting
    ///      on it, inside the window. Open to governance too, as `pause` is,
    ///      so a veto is still possible with no guardian set.
    ///
    ///      It can only refund, never redirect: the worst a compromised
    ///      guardian can do is void honest results, and every player keeps
    ///      their stake. Never paused: a veto must always be possible in time.
    function veto(bytes32 matchId) external nonReentrant {
        if (msg.sender != config.guardian() && msg.sender != config.owner()) revert NotGuardian();
        MatchInfo storage info = matchInfo[matchId];
        if (info.status != MatchStatus.Proposed) {
            revert WrongStatus(matchId, MatchStatus.Proposed, info.status);
        }
        if (block.timestamp >= info.challengeDeadline) revert ChallengeWindowClosed(info.challengeDeadline);

        _refundAll(matchId, info);
        emit ResultVetoed(matchId, msg.sender);
        emit MatchCancelled(matchId, "result vetoed");
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

    /// @dev EIP-712 type of an abort: the quorum agreeing a live match cannot finish.
    bytes32 private constant MATCH_ABORT_TYPEHASH = keccak256("MatchAbort(bytes32 matchId)");

    /// @notice Cancels a live match at once and refunds every stake, on the
    ///         word of a quorum of attestors.
    /// @dev For when the server lost the match — a restart drops a room's
    ///      state, and a half-played match cannot be resumed honestly. Without
    ///      this the players would wait out `settleDeadline` for the same
    ///      refund `cancelMatch` gives them then.
    ///
    ///      It gives the quorum no power it lacked: by refusing to sign a
    ///      result it could always force exactly this outcome, at the
    ///      deadline. Aborting only gets everyone their stake back sooner.
    function abortMatch(bytes32 matchId, bytes calldata signatures) external nonReentrant {
        MatchInfo storage info = matchInfo[matchId];
        if (info.status != MatchStatus.Live) {
            revert WrongStatus(matchId, MatchStatus.Live, info.status);
        }
        _checkQuorum(
            SettlementLib.toTypedDataHash(
                _domainSeparatorV4(), keccak256(abi.encode(MATCH_ABORT_TYPEHASH, matchId))
            ),
            signatures
        );
        _refundAll(matchId, info);
        emit MatchCancelled(matchId, "aborted by attestors");
    }

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

        _refundAll(matchId, info);
        emit MatchCancelled(matchId, reason);
    }

    /// @dev Cancels the match and credits every seat its stake back.
    function _refundAll(bytes32 matchId, MatchInfo storage info) private {
        info.status = MatchStatus.Cancelled;

        address[] memory seats = matchSeats[matchId];
        uint128 stake = info.stake;
        totalEscrowed -= uint256(stake) * seats.length;
        for (uint256 i = 0; i < seats.length; ++i) {
            _credit(seats[i], stake);
        }
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

    /// @dev The same conditions `join` reverts on, as a value: the
    ///      cross-chain path must refund rather than revert.
    function _joinFailure(bytes32 matchId, MatchInfo storage info, address player, uint256 value)
        private
        view
        returns (JoinFailure)
    {
        if (paused) return JoinFailure.Paused;
        if (info.status == MatchStatus.None) return JoinFailure.UnknownMatch;
        if (info.status != MatchStatus.Open) return JoinFailure.NotOpen;
        if (block.timestamp >= info.joinDeadline) return JoinFailure.WindowClosed;
        if (info.seatCount >= info.maxSeats) return JoinFailure.LobbyFull;
        if (hasSeat[matchId][player]) return JoinFailure.AlreadyJoined;
        if (value != info.stake) return JoinFailure.WrongStake;
        return JoinFailure.None;
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
