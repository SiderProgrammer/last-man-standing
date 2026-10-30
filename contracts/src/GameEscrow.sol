// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ProtocolConfig} from "./ProtocolConfig.sol";
import {PullPayable} from "./PullPayable.sol";
import {ExpiringPause} from "./ExpiringPause.sol";
import {
    BPS_DENOMINATOR,
    DISPUTE_EXTENSION,
    LOCK_GRACE,
    MAX_DISCOUNT_BPS,
    RANDOMNESS_TIMEOUT,
    SEQUENCER_GRACE_PERIOD
} from "./Constants.sol";
import {UnknownMatch, UntrustedMessenger, UntrustedPeer, ZeroAddress} from "./Errors.sol";
import {IRandomnessOracle, IRandomnessConsumer} from "./interfaces/IRandomnessOracle.sol";
import {ICrossChainReceiver} from "./interfaces/ICrossChainMessenger.sol";
import {IFeeLedger} from "./interfaces/IFeeLedger.sol";
import {ISequencerUptimeFeed} from "./interfaces/ISequencerUptimeFeed.sol";
import {SettlementLib} from "./libraries/SettlementLib.sol";
import {SignatureLib} from "./libraries/SignatureLib.sol";

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
///      round's rolls also depend on every commitment sealed in it.
///
///      Value handling is pull-based throughout. Settlement only ever credits
///      an internal balance; nothing is transferred until the recipient — or
///      anyone, on their behalf and to their address — withdraws it.
///
///      Fee accounting. When a match settles, every seat's fee is added to two
///      running totals for the current fee epoch (`FEE_EPOCH`, Unix weeks):
///      the player's own and the epoch's. Only a settled match pays its fee,
///      so only a settled match counts — counting at join instead would let a
///      player join a lobby that can never fill, claim rewards on the fee, and
///      cancel for a full refund afterwards. And since a total only ever grows
///      while its epoch is the current one, it is final the moment the epoch
///      ends. The escrow does nothing with them; they exist so a rewards
///      contract can pay players in proportion to the fees they paid, entirely
///      on-chain.
///
///      Fee discount. A seat may pay up to `MAX_DISCOUNT_BPS` of its fee in
///      LMS instead of ETH, at the config's `lmsPerEthDiscount` (`joinWithLms`).
///      It stakes that much less ETH; the prize pool is the same, and the
///      treasury's cut is smaller by the discount. The LMS is held here, against
///      the seat, until the match ends: burned when it settles, refunded with
///      the stake when it is cancelled, vetoed or aborted. Fee totals count
///      only the ETH part, the net fee.
contract GameEscrow is
    EIP712,
    PullPayable,
    ExpiringPause,
    IRandomnessConsumer,
    ICrossChainReceiver,
    IFeeLedger
{
    enum MatchStatus {
        None,
        /// @dev Accepting joins.
        Open,
        /// @dev Lobby closed, waiting on the randomness oracle.
        Pending,
        /// @dev Seed delivered; the server is running the match.
        Live,
        /// @dev Result signed and open to a veto until `deadline`.
        Proposed,
        /// @dev Result final and payouts credited.
        Settled,
        /// @dev Abandoned, or its result vetoed; every stake is refundable.
        Cancelled
    }

    /// @notice The deal a lobby is opened on, fixed from the config at that
    ///         moment so a governance change cannot alter it for a player who
    ///         already staked.
    /// @dev Stored once under a `termsId` and shared by every lobby opened on
    ///      the same terms, which in practice is every lobby between two
    ///      governance changes. Never modified once stored.
    struct Terms {
        /// @dev Digest of the off-chain rule set; see `ProtocolConfig.rulesHash`.
        bytes32 rulesHash;
        address treasury;
        uint16 feeBps;
        uint16 minSeats;
        uint64 joinWindow;
        uint64 settleWindow;
        uint64 challengeWindow;
        /// @dev Share of the pool per finishing position, in basis points.
        uint16[] payoutBps;
    }

    /// @dev Six slots. The first two are packed; `deadline` is the deadline
    ///      of the current phase: the seed's while Pending, the result's while
    ///      Live, the challenge window's while Proposed.
    struct MatchInfo {
        uint128 stake;
        uint32 termsId;
        uint16 maxSeats;
        uint16 seatCount;
        MatchStatus status;
        uint40 joinDeadline;
        /// @dev Snapshotted at lock: the oracle asked for the seed, and the
        ///      attestor set that signs the result.
        address oracle;
        uint32 attestorSetVersion;
        uint40 deadline;
        uint16 rounds;
        /// @dev A seat has disputed the proposed result and the guardian has
        ///      not dismissed it: `deadline` is `DISPUTE_EXTENSION` later.
        bool disputed;
        bytes32 seed;
        bytes32 historyRoot;
        /// @dev The ranking of a proposed result, by hash: it is in
        ///      `ResultProposed`, and whoever finalises passes it back.
        bytes32 rankingHash;
        /// @dev Hash of the archived transcript the result came from. Anyone
        ///      can fetch the transcript by it and replay the match.
        bytes32 transcriptHash;
    }

    /// @dev Part of a seat's fee paid in LMS, or a match's total of them.
    struct Discount {
        /// @dev ETH off the fee.
        uint128 eth;
        /// @dev LMS paid for it, held until the match ends.
        uint128 lms;
    }

    /// @notice Why a match was cancelled and every stake refunded.
    enum CancelReason {
        /// @dev Past its join deadline without enough seats, or not locked in time.
        JoinWindowExpired,
        /// @dev Locked, but the oracle never delivered a seed.
        RandomnessNotDelivered,
        /// @dev Live, but no result was proposed before the settle deadline.
        SettlementDeadlinePassed,
        /// @dev The guardian or governance vetoed the proposed result.
        ResultVetoed,
        /// @dev The attestors aborted a match the server could not finish.
        AbortedByAttestors
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

    /// @notice Length of a fee epoch. Epoch `n` is `[n * FEE_EPOCH, (n + 1) * FEE_EPOCH)`.
    uint256 public constant FEE_EPOCH = 7 days;

    ProtocolConfig public immutable config;

    uint256 public matchNonce;

    /// @notice Terms stored so far. Also the latest `termsId`, since ids start at 1.
    uint32 public termsCount;
    mapping(uint32 termsId => Terms) private terms;
    mapping(bytes32 termsHash => uint32 termsId) private termsIdOf;

    mapping(bytes32 matchId => MatchInfo) private matchInfo;
    mapping(bytes32 matchId => address[]) private matchSeats;
    /// @dev A seat's position in `matchSeats`, plus one. Zero means no seat.
    mapping(bytes32 matchId => mapping(address player => uint256)) private seatNumber;
    /// @notice Chain a seat originated from. Zero means this chain.
    mapping(bytes32 matchId => mapping(address player => uint32)) public seatOrigin;

    /// @notice Fees `player` paid in matches that settled during `epoch`.
    mapping(address player => mapping(uint256 epoch => uint256)) public feesPaid;
    /// @notice Fees every player paid in matches that settled during `epoch`.
    mapping(uint256 epoch => uint256) public epochFees;

    mapping(bytes32 matchId => mapping(address player => Discount)) private seatDiscount;
    /// @dev Every seat's discount in a match, added up. Zero for nearly every
    ///      match, which then never reads `seatDiscount`.
    mapping(bytes32 matchId => Discount) private matchDiscount;
    /// @dev Seats that have disputed the match's result, one bit per seat
    ///      number less one: each may dispute once.
    mapping(bytes32 matchId => uint256) private disputedSeats;
    /// @notice LMS held against seats of matches that have not ended.
    uint256 public totalLmsEscrowed;

    /// @notice Stakes held for matches that have not yet settled or cancelled.
    /// @dev This and `PullPayable.totalOwed` account for the entire contract
    ///      balance; the solvency invariant is
    ///      `address(this).balance == totalOwed + totalEscrowed`.
    uint256 public totalEscrowed;

    event TermsStored(uint32 indexed termsId, Terms terms);
    event MatchCreated(
        bytes32 indexed matchId,
        address indexed creator,
        uint128 stake,
        uint16 maxSeats,
        uint32 indexed termsId,
        bytes32 rulesHash
    );
    event PlayerJoined(bytes32 indexed matchId, address indexed player, uint16 seat, uint32 originChainId);
    event MatchLocked(bytes32 indexed matchId, bytes32 indexed requestId, uint16 seatCount);
    event MatchStarted(bytes32 indexed matchId, bytes32 seed, uint40 settleDeadline);
    event ResultProposed(
        bytes32 indexed matchId,
        bytes32 indexed historyRoot,
        uint32 rounds,
        bytes32 transcriptHash,
        address[] ranking,
        uint40 challengeDeadline
    );
    event MatchSettled(
        bytes32 indexed matchId, bytes32 indexed historyRoot, uint32 rounds, address indexed winner
    );
    event ResultVetoed(bytes32 indexed matchId, address indexed by);
    /// @param evidenceHash Hash of the player's evidence bundle, published off-chain.
    event ResultDisputed(
        bytes32 indexed matchId, address indexed player, bytes32 evidenceHash, uint40 challengeDeadline
    );
    event DisputeDismissed(bytes32 indexed matchId, address indexed by, uint40 challengeDeadline);
    event PayoutCredited(bytes32 indexed matchId, address indexed player, uint16 rank, uint256 amount);
    event FeeCredited(bytes32 indexed matchId, address indexed treasury, uint256 amount);
    event MatchCancelled(bytes32 indexed matchId, CancelReason reason);
    /// @notice A cross-chain stake arrived for a seat that could no longer be
    ///         taken, and was credited back to the player here instead.
    event JoinRefunded(bytes32 indexed matchId, address indexed player, uint256 amount, JoinFailure reason);
    event FeeDiscounted(bytes32 indexed matchId, address indexed player, uint256 ethOff, uint256 lmsPaid);
    event LmsBurned(bytes32 indexed matchId, uint256 amount);
    event LmsRefunded(bytes32 indexed matchId, address indexed player, uint256 amount);

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
    error QuorumNotMet(uint256 signers, uint32 threshold);
    error NotAnAttestor(address signer);
    error CannotCancelYet(bytes32 matchId);
    error RoundsOutOfRange(uint32 rounds);
    error ConfigIncomplete();
    error ChallengeWindowOpen(uint40 deadline);
    error ChallengeWindowClosed(uint40 deadline);
    error RankingMismatch();
    error NotAPermutation();
    error SequencerDown();
    error SequencerGracePeriod(uint256 until);
    error NotSeated(bytes32 matchId, address caller);
    error AlreadyDisputed(bytes32 matchId, address player);
    error NotDisputed(bytes32 matchId);
    error DiscountOff();
    error NoDiscount(uint256 lmsIn);

    using SafeERC20 for IERC20;

    constructor(ProtocolConfig config_) EIP712("LastManStanding", "1") {
        config = config_;
    }

    // --- Lobby -------------------------------------------------------------

    /// @notice Opens a lobby with terms fixed from the current configuration.
    /// @param stake Per-seat stake in wei.
    /// @param maxSeats Seats in the lobby.
    function createMatch(uint128 stake, uint16 maxSeats) external whenNotPaused returns (bytes32 matchId) {
        // A config deploys with none of these set. A lobby opened against it
        // could never be seeded, would snapshot a rule set nobody plays
        // under, or could never settle.
        if (!config.isComplete()) revert ConfigIncomplete();

        ProtocolConfig.Params memory params = config.getParams();
        if (stake < params.minStake || stake > params.maxStake) revert StakeOutOfRange(stake);
        if (maxSeats < params.minSeats || maxSeats > params.maxSeats) revert SeatsOutOfRange(maxSeats);

        (uint32 termsId, bytes32 rulesHash) = _currentTerms(params);
        matchId = keccak256(abi.encode(block.chainid, address(this), matchNonce++));

        MatchInfo storage info = matchInfo[matchId];
        info.stake = stake;
        info.termsId = termsId;
        info.maxSeats = maxSeats;
        info.status = MatchStatus.Open;
        info.joinDeadline = SafeCast.toUint40(block.timestamp + params.joinWindow);

        emit MatchCreated(matchId, msg.sender, stake, maxSeats, termsId, rulesHash);
    }

    /// @dev The id of the current terms, storing them first if no lobby has
    ///      been opened on them yet.
    function _currentTerms(ProtocolConfig.Params memory params)
        private
        returns (uint32 termsId, bytes32 rulesHash)
    {
        rulesHash = config.rulesHash();
        Terms memory current = Terms({
            rulesHash: rulesHash,
            treasury: params.treasury,
            feeBps: params.feeBps,
            minSeats: params.minSeats,
            joinWindow: params.joinWindow,
            settleWindow: params.settleWindow,
            challengeWindow: config.challengeWindow(),
            payoutBps: config.getPayoutSchedule()
        });
        bytes32 termsHash = keccak256(abi.encode(current));
        termsId = termsIdOf[termsHash];
        if (termsId != 0) return (termsId, rulesHash);

        termsId = ++termsCount;
        terms[termsId] = current;
        termsIdOf[termsHash] = termsId;
        emit TermsStored(termsId, current);
    }

    /// @notice Takes a seat by staking on this chain.
    function join(bytes32 matchId) external payable whenNotPaused {
        MatchInfo storage info = _open(matchId);
        if (msg.value != info.stake) revert IncorrectStake(msg.value, info.stake);
        _seat(matchId, info, msg.sender, 0, info.stake);
    }

    /// @notice Takes a seat paying part of its fee in LMS: up to `lmsIn`,
    ///         and never more than buys `MAX_DISCOUNT_BPS` of the fee.
    /// @dev Send the stake less the discount, which `quoteLmsDiscount` gives.
    ///      The caller must have approved the LMS.
    function joinWithLms(bytes32 matchId, uint256 lmsIn) external payable whenNotPaused {
        _joinWithLms(matchId, lmsIn);
    }

    /// @notice `joinWithLms`, with the LMS allowance granted by an EIP-2612
    ///         signature. The permit is attempted, not required, as in
    ///         `StakedLms.depositWithPermit`.
    function joinWithLmsPermit(
        bytes32 matchId,
        uint256 lmsIn,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external payable whenNotPaused {
        address token = config.lmsToken();
        if (token != address(0)) {
            try IERC20Permit(token).permit(msg.sender, address(this), lmsIn, deadline, v, r, s) {} catch {}
        }
        _joinWithLms(matchId, lmsIn);
    }

    /// @notice What `lmsIn` LMS takes off a seat's fee in `matchId` now, and
    ///         how much of it would be used: no more than buys the most
    ///         discount allowed.
    function quoteLmsDiscount(bytes32 matchId, uint256 lmsIn)
        public
        view
        returns (uint256 discount, uint256 lmsUsed)
    {
        uint256 rate = config.lmsPerEthDiscount();
        if (rate == 0 || config.lmsToken() == address(0)) return (0, 0);
        MatchInfo storage info = matchInfo[matchId];
        uint256 fee = (uint256(info.stake) * terms[info.termsId].feeBps) / BPS_DENOMINATOR;
        uint256 maxDiscount = (fee * MAX_DISCOUNT_BPS) / BPS_DENOMINATOR;

        discount = Math.mulDiv(lmsIn, 1 ether, rate);
        if (discount < maxDiscount) return (discount, lmsIn);
        return (maxDiscount, Math.mulDiv(maxDiscount, rate, 1 ether, Math.Rounding.Ceil));
    }

    function _joinWithLms(bytes32 matchId, uint256 lmsIn) private {
        MatchInfo storage info = _open(matchId);
        address token = config.lmsToken();
        if (token == address(0) || config.lmsPerEthDiscount() == 0) revert DiscountOff();
        (uint256 discount, uint256 lmsUsed) = quoteLmsDiscount(matchId, lmsIn);
        if (discount == 0) revert NoDiscount(lmsIn);

        // Less than the stake: at most half of a fee of at most 10% of it.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 due = info.stake - uint128(discount);
        if (msg.value != due) revert IncorrectStake(msg.value, due);
        _seat(matchId, info, msg.sender, 0, due);

        // Both fit: the discount is under the stake, a uint128, and the LMS
        // is bounded by the token's supply.
        // forge-lint: disable-next-line(unsafe-typecast)
        Discount memory seat = Discount({eth: uint128(discount), lms: uint128(lmsUsed)});
        seatDiscount[matchId][msg.sender] = seat;
        Discount storage total = matchDiscount[matchId];
        total.eth += seat.eth;
        total.lms += seat.lms;
        totalLmsEscrowed += lmsUsed;

        IERC20(token).safeTransferFrom(msg.sender, address(this), lmsUsed);
        emit FeeDiscounted(matchId, msg.sender, discount, lmsUsed);
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
        _seat(matchId, info, player, 0, info.stake);
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
    function receiveMessage(uint32 srcChainId, bytes32 srcSender, bytes calldata payload) external payable {
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
        _seat(matchId, info, player, srcChainId, info.stake);
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
        uint16 minSeats = terms[info.termsId].minSeats;
        if (info.seatCount < minSeats) revert NotEnoughPlayers(info.seatCount, minSeats);

        // Every write before the call: the oracle answers with the match id,
        // so nothing about the request has to be recorded after it returns.
        address oracle = config.randomnessOracle();
        info.status = MatchStatus.Pending;
        info.oracle = oracle;
        info.attestorSetVersion = config.attestorSetVersion();
        info.deadline = SafeCast.toUint40(block.timestamp + RANDOMNESS_TIMEOUT);
        requestId = IRandomnessOracle(oracle).requestRandomness(matchId);

        emit MatchLocked(matchId, requestId, info.seatCount);
    }

    /// @inheritdoc IRandomnessConsumer
    /// @dev Only a Pending match takes a seed, so a second answer, or a late
    ///      one for a match already cancelled, reverts.
    ///      The oracle is the one the match asked, not the current one: an
    ///      oracle change must not strand a match already waiting on a seed.
    function fulfillRandomness(bytes32 matchId, bytes32 randomness) external {
        MatchInfo storage info = matchInfo[matchId];
        if (msg.sender != info.oracle || msg.sender == address(0)) revert NotOracle(msg.sender);

        if (info.status != MatchStatus.Pending) {
            revert WrongStatus(matchId, MatchStatus.Pending, info.status);
        }

        // Bind the seed to the match so one oracle response cannot seed two
        // matches, and so a zero response is still a usable seed.
        bytes32 seed = keccak256(abi.encode(randomness, matchId));
        uint40 settleDeadline = SafeCast.toUint40(block.timestamp + terms[info.termsId].settleWindow);

        info.seed = seed;
        info.deadline = settleDeadline;
        info.status = MatchStatus.Live;

        emit MatchStarted(matchId, seed, settleDeadline);
    }

    // --- Settlement --------------------------------------------------------

    /// @notice Proposes a match result signed by a quorum of attestors.
    /// @dev Pays nothing yet. The result is open to `veto` until
    ///      `challengeDeadline`; after that anyone may `finalize` it.
    /// @param transcriptHash Hash of the transcript the server archived before
    ///        settling: the evidence anyone can replay the result from.
    /// @param ranking Finishing order, best first. Must be exactly the seat set.
    /// @param signatures Concatenated 65-byte signatures in ascending signer order.
    function settle(
        bytes32 matchId,
        uint32 rounds,
        bytes32 historyRoot,
        bytes32 transcriptHash,
        address[] calldata ranking,
        bytes calldata signatures
    ) external nonReentrant whenNotPaused {
        MatchInfo storage info = matchInfo[matchId];
        if (info.status != MatchStatus.Live) {
            revert WrongStatus(matchId, MatchStatus.Live, info.status);
        }
        if (rounds == 0 || rounds > type(uint16).max) revert RoundsOutOfRange(rounds);

        _checkQuorum(
            info.attestorSetVersion,
            _hashTypedDataV4(
                SettlementLib.hashMatchResult(matchId, rounds, historyRoot, transcriptHash, ranking)
            ),
            signatures
        );
        _assertSeatSet(matchId, info.seatCount, ranking);

        uint40 deadline = SafeCast.toUint40(block.timestamp + terms[info.termsId].challengeWindow);
        info.status = MatchStatus.Proposed;
        info.historyRoot = historyRoot;
        // Checked against the uint16 range above.
        // forge-lint: disable-next-line(unsafe-typecast)
        info.rounds = uint16(rounds);
        info.deadline = deadline;
        info.rankingHash = keccak256(abi.encode(ranking));
        info.transcriptHash = transcriptHash;

        emit ResultProposed(matchId, historyRoot, rounds, transcriptHash, ranking, deadline);
    }

    /// @dev Reverts unless `signatures` over `digest` come from a quorum of
    ///      the attestor set the match locked under.
    function _checkQuorum(uint32 version, bytes32 digest, bytes calldata signatures) private view {
        address[] memory signers = SignatureLib.recoverAscending(digest, signatures);
        uint32 threshold = config.thresholdOf(version);
        // A zero threshold would accept an empty signature blob.
        if (threshold == 0 || signers.length < threshold) revert QuorumNotMet(signers.length, threshold);
        for (uint256 i = 0; i < signers.length; ++i) {
            if (!config.isAttestorAt(version, signers[i])) revert NotAnAttestor(signers[i]);
        }
    }

    /// @dev Reverts unless `ranking` is exactly the match's seats, each once:
    ///      without this a quorum could redirect the pool to addresses that
    ///      never staked. Seat numbers run from 1 to at most 256, so one word
    ///      marks every seat seen.
    function _assertSeatSet(bytes32 matchId, uint256 seatCount, address[] calldata ranking) private view {
        if (ranking.length != seatCount) revert NotAPermutation();
        uint256 seen;
        for (uint256 i = 0; i < ranking.length; ++i) {
            uint256 number = seatNumber[matchId][ranking[i]];
            if (number == 0) revert NotAPermutation();
            uint256 bit = 1 << (number - 1);
            if (seen & bit != 0) revert NotAPermutation();
            seen |= bit;
        }
    }

    /// @notice Pays out a proposed result once its challenge window has closed unvetoed.
    /// @dev Permissionless, and deliberately not paused: a pause must never
    ///      hold a result that has already survived its challenge window.
    ///
    ///      Not while the L2 sequencer is down, nor for `SEQUENCER_GRACE_PERIOD`
    ///      after it comes back: nobody could veto during the outage, so
    ///      without this it would quietly shorten the challenge window.
    /// @param ranking The ranking from `ResultProposed`.
    function finalize(bytes32 matchId, address[] calldata ranking) external nonReentrant {
        MatchInfo storage info = matchInfo[matchId];
        if (info.status != MatchStatus.Proposed) {
            revert WrongStatus(matchId, MatchStatus.Proposed, info.status);
        }
        if (block.timestamp < info.deadline) revert ChallengeWindowOpen(info.deadline);
        if (keccak256(abi.encode(ranking)) != info.rankingHash) revert RankingMismatch();
        _checkSequencer();

        info.status = MatchStatus.Settled;
        Discount memory discount = matchDiscount[matchId];
        totalEscrowed -= uint256(info.stake) * info.seatCount - discount.eth;
        Terms storage matchTerms = terms[info.termsId];
        _distribute(matchId, info, matchTerms, ranking, discount.eth);
        _recordFees(matchId, info.stake, matchTerms.feeBps, ranking, discount.eth != 0);

        if (discount.lms != 0) {
            totalLmsEscrowed -= discount.lms;
            ERC20Burnable(config.lmsToken()).burn(discount.lms);
            emit LmsBurned(matchId, discount.lms);
        }

        emit MatchSettled(matchId, info.historyRoot, info.rounds, ranking[0]);
    }

    function _checkSequencer() private view {
        address feed = config.sequencerUptimeFeed();
        if (feed == address(0)) return;
        (, int256 answer, uint256 startedAt,,) = ISequencerUptimeFeed(feed).latestRoundData();
        if (answer != 0) revert SequencerDown();
        uint256 until = startedAt + SEQUENCER_GRACE_PERIOD;
        if (block.timestamp < until) revert SequencerGracePeriod(until);
    }

    /// @dev Adds every seat's net fee — what it paid in ETH — to this epoch's
    ///      totals, now that it is paid. `ranking` was checked against the seat
    ///      set when it was proposed, and again by hash above, so it is exactly
    ///      the seats.
    function _recordFees(
        bytes32 matchId,
        uint128 stake,
        uint16 feeBps,
        address[] calldata ranking,
        bool discounted
    ) private {
        uint256 fee = (uint256(stake) * feeBps) / BPS_DENOMINATOR;
        if (fee == 0) return;
        uint256 epoch = block.timestamp / FEE_EPOCH;
        uint256 total;
        for (uint256 i = 0; i < ranking.length; ++i) {
            address player = ranking[i];
            uint256 net = discounted ? fee - seatDiscount[matchId][player].eth : fee;
            feesPaid[player][epoch] += net;
            total += net;
        }
        epochFees[epoch] += total;
    }

    /// @notice Throws out a proposed result and refunds every stake.
    /// @dev For a result that a replay of its transcript does not support,
    ///      usually one a player has disputed. The replay happens off-chain;
    ///      this is the guardian acting on it, inside the window. Open to
    ///      governance too, as `pause` is, so a veto is still possible with no
    ///      guardian set.
    ///
    ///      It can only refund, never redirect: the worst a compromised
    ///      guardian can do is void honest results, and every player keeps
    ///      their stake. Never paused: a veto must always be possible in time.
    function veto(bytes32 matchId) external nonReentrant {
        _onlyGuardianOrGovernance();
        MatchInfo storage info = matchInfo[matchId];
        if (info.status != MatchStatus.Proposed) {
            revert WrongStatus(matchId, MatchStatus.Proposed, info.status);
        }
        if (block.timestamp >= info.deadline) revert ChallengeWindowClosed(info.deadline);

        _refundAll(matchId, info);
        emit ResultVetoed(matchId, msg.sender);
        emit MatchCancelled(matchId, CancelReason.ResultVetoed);
    }

    /// @notice Disputes a proposed result: holds back its payout by
    ///         `DISPUTE_EXTENSION` for the guardian to look at it.
    /// @dev Any seated player, once each, while the result can still be
    ///      vetoed. The first open dispute extends the deadline; one already
    ///      open does not extend it again. Nothing on-chain checks the
    ///      evidence: the guardian reads it, replays the transcript, and then
    ///      vetoes or dismisses. A guardian that does neither lets the result
    ///      finalise when the extension runs out, which is the liveness
    ///      assumption this rests on.
    ///
    ///      Never paused: a player must always be able to object in time.
    /// @param evidenceHash Hash of the evidence bundle the player published.
    function dispute(bytes32 matchId, bytes32 evidenceHash) external {
        MatchInfo storage info = matchInfo[matchId];
        if (info.status != MatchStatus.Proposed) {
            revert WrongStatus(matchId, MatchStatus.Proposed, info.status);
        }
        if (block.timestamp >= info.deadline) revert ChallengeWindowClosed(info.deadline);
        uint256 number = seatNumber[matchId][msg.sender];
        if (number == 0) revert NotSeated(matchId, msg.sender);
        uint256 bit = 1 << (number - 1);
        uint256 seen = disputedSeats[matchId];
        if (seen & bit != 0) revert AlreadyDisputed(matchId, msg.sender);
        disputedSeats[matchId] = seen | bit;

        if (!info.disputed) {
            info.disputed = true;
            info.deadline = SafeCast.toUint40(info.deadline + uint256(DISPUTE_EXTENSION));
        }
        emit ResultDisputed(matchId, msg.sender, evidenceHash, info.deadline);
    }

    /// @notice The guardian's answer to a dispute it finds unfounded: the
    ///         result goes back to its own challenge deadline, or may be
    ///         finalised at once if that has passed.
    /// @dev Open to governance too, as `veto` is. A player who has not yet
    ///      disputed may still do so before the restored deadline.
    function dismissDispute(bytes32 matchId) external {
        _onlyGuardianOrGovernance();
        MatchInfo storage info = matchInfo[matchId];
        if (info.status != MatchStatus.Proposed) {
            revert WrongStatus(matchId, MatchStatus.Proposed, info.status);
        }
        if (!info.disputed) revert NotDisputed(matchId);
        if (block.timestamp >= info.deadline) revert ChallengeWindowClosed(info.deadline);

        info.disputed = false;
        // Extended exactly once while disputed, so this is the deadline it had.
        uint256 restored = info.deadline - uint256(DISPUTE_EXTENSION);
        info.deadline = SafeCast.toUint40(Math.max(restored, block.timestamp));
        emit DisputeDismissed(matchId, msg.sender, info.deadline);
    }

    /// @dev The pool is the full stakes, as if nobody had a discount: the
    ///      prizes do not depend on how seats paid. The ETH actually held is
    ///      `discountEth` less, which comes out of the treasury's cut.
    function _distribute(
        bytes32 matchId,
        MatchInfo storage info,
        Terms storage matchTerms,
        address[] calldata ranking,
        uint256 discountEth
    ) private {
        uint256 pool = uint256(info.stake) * info.seatCount;
        uint256 distributable = pool - (pool * matchTerms.feeBps) / BPS_DENOMINATOR;

        uint16[] memory schedule = matchTerms.payoutBps;
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
        // Less the discounts, which never exceed half the fee.
        uint256 remainder = pool - paid - discountEth;
        if (remainder > 0) {
            address treasury = matchTerms.treasury;
            _credit(treasury, remainder);
            emit FeeCredited(matchId, treasury, remainder);
        }
    }

    // --- Cancellation ------------------------------------------------------

    /// @dev EIP-712 type of an abort: the quorum agreeing a live match cannot finish.
    bytes32 private constant MATCH_ABORT_TYPEHASH = keccak256("MatchAbort(bytes32 matchId)");

    /// @notice Cancels a live match at once and refunds every stake, on the
    ///         word of a quorum of attestors.
    /// @dev For when the server lost the match — a restart drops a room's
    ///      state, and a half-played match cannot be resumed honestly. Without
    ///      this the players would wait out the settle deadline for the same
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
            info.attestorSetVersion,
            _hashTypedDataV4(keccak256(abi.encode(MATCH_ABORT_TYPEHASH, matchId))),
            signatures
        );
        _refundAll(matchId, info);
        emit MatchCancelled(matchId, CancelReason.AbortedByAttestors);
    }

    /// @notice Refunds every stake in a match that can no longer complete.
    /// @dev Permissionless once the relevant deadline has passed, so players
    ///      are never dependent on the operator to recover their stake.
    ///
    ///      A lobby that reached `minSeats` is one that should start, so past
    ///      its join deadline it can only be locked for `LOCK_GRACE`. Without
    ///      that, a seated player who expects to lose could cancel it in the
    ///      same block as the lock and race it.
    function cancelMatch(bytes32 matchId) external nonReentrant {
        MatchInfo storage info = matchInfo[matchId];
        CancelReason reason;

        if (info.status == MatchStatus.Open) {
            uint256 cancellableAt = info.joinDeadline;
            if (info.seatCount >= terms[info.termsId].minSeats) cancellableAt += LOCK_GRACE;
            if (block.timestamp < cancellableAt) revert CannotCancelYet(matchId);
            reason = CancelReason.JoinWindowExpired;
        } else if (info.status == MatchStatus.Pending) {
            // The oracle never answered.
            if (block.timestamp < info.deadline) revert CannotCancelYet(matchId);
            reason = CancelReason.RandomnessNotDelivered;
        } else if (info.status == MatchStatus.Live) {
            // No quorum produced a result in time.
            if (block.timestamp < info.deadline) revert CannotCancelYet(matchId);
            reason = CancelReason.SettlementDeadlinePassed;
        } else {
            revert WrongStatus(matchId, MatchStatus.Live, info.status);
        }

        _refundAll(matchId, info);
        emit MatchCancelled(matchId, reason);
    }

    /// @dev Cancels the match and credits every seat what it paid back: its
    ///      stake, less any discount, and the LMS that paid for the discount.
    function _refundAll(bytes32 matchId, MatchInfo storage info) private {
        info.status = MatchStatus.Cancelled;

        address[] memory seats = matchSeats[matchId];
        uint128 stake = info.stake;
        Discount memory total = matchDiscount[matchId];
        totalEscrowed -= uint256(stake) * seats.length - total.eth;
        if (total.eth == 0) {
            for (uint256 i = 0; i < seats.length; ++i) {
                _credit(seats[i], stake);
            }
            return;
        }

        totalLmsEscrowed -= total.lms;
        IERC20 lms = IERC20(config.lmsToken());
        for (uint256 i = 0; i < seats.length; ++i) {
            Discount memory seat = seatDiscount[matchId][seats[i]];
            _credit(seats[i], stake - seat.eth);
            // Pushed rather than credited: LMS has no transfer hooks, so a
            // recipient cannot make this revert.
            if (seat.lms != 0) {
                lms.safeTransfer(seats[i], seat.lms);
                emit LmsRefunded(matchId, seats[i], seat.lms);
            }
        }
    }

    // --- Governance --------------------------------------------------------

    /// @dev The guardian pauses at once, for a week at most; see
    ///      `ExpiringPause`. A pause halts new lobbies, joins, locking and
    ///      settlement. `finalize`, `veto`, `cancelMatch` and withdrawals are
    ///      never paused: a pause must never trap player funds or hold a result
    ///      that has survived its challenge window.
    function _isGuardian(address account) internal view override returns (bool) {
        return account == config.guardian();
    }

    function _isGovernance(address account) internal view override returns (bool) {
        return account == config.owner();
    }

    function _onlyGuardianOrGovernance() private view {
        if (!_isGuardian(msg.sender) && !_isGovernance(msg.sender)) revert NotGuardian();
    }

    // --- Views -------------------------------------------------------------

    function hasSeat(bytes32 matchId, address player) public view returns (bool) {
        return seatNumber[matchId][player] != 0;
    }

    function getMatch(bytes32 matchId) external view returns (MatchInfo memory) {
        return matchInfo[matchId];
    }

    function getTerms(uint32 termsId) external view returns (Terms memory) {
        return terms[termsId];
    }

    /// @notice The terms a match was opened on.
    function getMatchTerms(bytes32 matchId) external view returns (Terms memory) {
        return terms[matchInfo[matchId].termsId];
    }

    function getSeats(bytes32 matchId) external view returns (address[] memory) {
        return matchSeats[matchId];
    }

    /// @notice ETH off `player`'s fee in `matchId`, and the LMS paid for it.
    function getSeatDiscount(bytes32 matchId, address player) external view returns (Discount memory) {
        return seatDiscount[matchId][player];
    }

    function getPayoutSchedule(bytes32 matchId) external view returns (uint16[] memory) {
        return terms[matchInfo[matchId].termsId].payoutBps;
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
        if (paused()) return JoinFailure.Paused;
        if (info.status == MatchStatus.None) return JoinFailure.UnknownMatch;
        if (info.status != MatchStatus.Open) return JoinFailure.NotOpen;
        if (block.timestamp >= info.joinDeadline) return JoinFailure.WindowClosed;
        if (info.seatCount >= info.maxSeats) return JoinFailure.LobbyFull;
        if (hasSeat(matchId, player)) return JoinFailure.AlreadyJoined;
        if (value != info.stake) return JoinFailure.WrongStake;
        return JoinFailure.None;
    }

    /// @param paid ETH the seat paid: the stake, less any discount.
    function _seat(
        bytes32 matchId,
        MatchInfo storage info,
        address player,
        uint32 originChainId,
        uint256 paid
    ) private {
        if (block.timestamp >= info.joinDeadline) revert JoinWindowClosed(matchId);
        if (info.seatCount >= info.maxSeats) revert LobbyFull(matchId);
        if (hasSeat(matchId, player)) revert AlreadyJoined(matchId, player);

        uint16 seat = info.seatCount;
        seatNumber[matchId][player] = uint256(seat) + 1;
        if (originChainId != 0) seatOrigin[matchId][player] = originChainId;

        matchSeats[matchId].push(player);
        info.seatCount = seat + 1;
        totalEscrowed += paid;

        emit PlayerJoined(matchId, player, seat, originChainId);
    }
}
