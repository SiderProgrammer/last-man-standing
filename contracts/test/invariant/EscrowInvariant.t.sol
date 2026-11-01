// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {BPS_DENOMINATOR, DISPUTE_EXTENSION, LOCK_GRACE} from "../../src/Constants.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {ProtocolConfig} from "../../src/ProtocolConfig.sol";
import {MockRandomnessOracle} from "../../src/mocks/MockRandomnessOracle.sol";
import {MockAcrossSpokePool} from "../../src/mocks/MockAcrossSpokePool.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {BridgeJoinReceiver} from "../../src/periphery/BridgeJoinReceiver.sol";
import {IAcrossSpokePool} from "../../src/vendor/across/IAcrossSpokePool.sol";
import {IWETH9} from "../../src/vendor/across/IWETH9.sol";
import {LmsToken} from "../../src/governance/LmsToken.sol";
import {SettlementHarness} from "../helpers/SettlementHarness.sol";
import {Attest} from "../helpers/Attest.sol";
import {Fixtures} from "../helpers/Fixtures.sol";

/// @dev Actor that drives GameEscrow through random sequences of public calls,
///      on many matches at once.
///
///      Every action picks a match, a player and a moment for which the call
///      is allowed, and does nothing when there is none, so the escrow is never
///      called to fail: the campaign runs with `fail_on_revert`, and any revert
///      is a bug in the escrow or in a precondition here. The one exception is
///      `guardianPause`, which tries whenever it is called and checks the
///      outcome against a model of the cooldown.
contract EscrowHandler is Test {
    GameEscrow public immutable escrow;
    MockRandomnessOracle public immutable oracle;
    SettlementHarness public immutable harness;
    MockAcrossSpokePool public immutable pool;
    address public immutable receiver;
    LmsToken public immutable lms;
    address public immutable governance;
    uint64 public immutable challengeWindow;

    address[] public actors;
    uint256[] internal attestorPks;

    uint128 public constant STAKE = 0.05 ether;
    /// @dev The config's matchmaker and guardian; `setUp` names them.
    address public constant MATCHMAKER = address(0x3A7C4);
    address public constant GUARDIAN = address(0x6A2D);
    uint32 public constant REMOTE_CHAIN = 421_614;
    address private constant RELAYER = address(0x7E1A7E);

    /// @dev Every match the campaign opened, the request that will seed it,
    ///      and the ranking proposed for it.
    bytes32[] public matchIds;
    mapping(bytes32 matchId => bytes32) private requestOf;
    mapping(bytes32 matchId => address[]) private proposedRanking;

    /// @dev Every fee epoch a match settled in, and which epoch that was for
    ///      each match, plus one (zero: not settled).
    uint256[] public epochs;
    mapping(uint256 epoch => bool) private seenEpoch;
    mapping(bytes32 matchId => uint256) public settledInEpochPlusOne;

    /// @dev Ghost: what fills with an unreadable message left in the receiver.
    uint256 public unroutable;

    /// @dev The challenge deadline as the rules give it, worked out here
    ///      rather than read: the window from the proposal, 48 hours more while
    ///      a dispute is open, and back (not before now) once dismissed.
    struct Challenge {
        uint256 proposedAt;
        uint256 deadline;
        bool disputed;
        /// @dev Seats that have disputed, one bit per seat index.
        uint256 disputedSeats;
        uint256 finalizedAt;
        uint256 deadlineAtFinalize;
        bool disputedAtFinalize;
    }

    mapping(bytes32 matchId => Challenge) private challenge;

    /// @dev The pause as the rules give it: what `pausedUntil` should be, the
    ///      latest end a guardian pause set and a governance extension set,
    ///      and every guardian pause the escrow got wrong.
    uint256 public modelPausedUntil;
    uint256 public guardianPauseEnd;
    uint256 public governancePauseEnd;
    uint256 public guardianPauseMismatches;

    /// @dev How far the campaign got, per action that changes a match's state.
    uint256 public locked;
    uint256 public proposed;
    uint256 public finalized;
    uint256 public vetoed;
    uint256 public disputed;
    uint256 public cancelled;
    uint256 public aborted;
    /// @dev Exits taken while play was paused: a veto, dispute, finalize,
    ///      cancellation or withdrawal, none of which a pause may block.
    uint256 public exitsWhilePaused;

    constructor(
        GameEscrow escrow_,
        MockRandomnessOracle oracle_,
        SettlementHarness harness_,
        MockAcrossSpokePool pool_,
        address receiver_,
        LmsToken lms_,
        address governance_,
        uint64 challengeWindow_,
        address[] memory actors_,
        uint256[] memory attestorPks_
    ) {
        escrow = escrow_;
        oracle = oracle_;
        harness = harness_;
        pool = pool_;
        receiver = receiver_;
        lms = lms_;
        governance = governance_;
        challengeWindow = challengeWindow_;
        actors = actors_;
        attestorPks = attestorPks_;
    }

    /// @dev What the fuzzer calls: the actions below, and nothing else here.
    function actions() external pure returns (bytes4[] memory selectors) {
        selectors = new bytes4[](19);
        selectors[0] = this.createMatch.selector;
        selectors[1] = this.createMatchmade.selector;
        selectors[2] = this.join.selector;
        selectors[3] = this.crossChainJoin.selector;
        selectors[4] = this.junkFill.selector;
        selectors[5] = this.lock.selector;
        selectors[6] = this.fulfill.selector;
        selectors[7] = this.settle.selector;
        selectors[8] = this.finalize.selector;
        selectors[9] = this.veto.selector;
        selectors[10] = this.dispute.selector;
        selectors[11] = this.dismissDispute.selector;
        selectors[12] = this.abort.selector;
        selectors[13] = this.cancel.selector;
        selectors[14] = this.withdraw.selector;
        selectors[15] = this.withdrawFor.selector;
        selectors[16] = this.guardianPause.selector;
        selectors[17] = this.governancePause.selector;
        selectors[18] = this.unpause.selector;
    }

    function matchCount() external view returns (uint256) {
        return matchIds.length;
    }

    function epochCount() external view returns (uint256) {
        return epochs.length;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function challengeOf(bytes32 matchId) external view returns (Challenge memory) {
        return challenge[matchId];
    }

    // --- Lobbies -----------------------------------------------------------

    /// @dev Players open a lobby when there are fewer than two to join, so
    ///      seats gather in a few lobbies rather than one in each of many.
    function createMatch(uint256 who, uint16 seats) public {
        _resume();
        if (_joinableLobbies() >= 2) return;
        vm.prank(actors[who % actors.length]);
        matchIds.push(escrow.createMatch(STAKE, uint16(bound(seats, 4, 8))));
    }

    /// @dev A matchmade lobby for the actors `mask` picks, at least four of
    ///      them, on the same terms as `createMatch`. Bridged stakes for
    ///      anyone else are credited back.
    function createMatchmade(uint256 mask, uint16 seats) public {
        _resume();
        if (_joinableLobbies() >= 2) return;
        mask = bound(mask, 0, (1 << actors.length) - 1) | 0x0f;
        address[] memory roster = new address[](actors.length);
        uint256 count;
        for (uint256 i = 0; i < actors.length; ++i) {
            if (mask & (1 << i) != 0) roster[count++] = actors[i];
        }
        assembly ("memory-safe") {
            mstore(roster, count)
        }
        vm.prank(MATCHMAKER);
        matchIds.push(escrow.createMatchmade(STAKE, uint16(bound(seats, 4, 8)), roster));
    }

    /// @dev Takes two to eight seats in lobbies that have them free, each for a
    ///      player allowed it, by one of three routes: their own stake, a
    ///      stake someone else pays, or part of the fee in LMS, anything from a
    ///      sliver of the discount to more LMS than the cap buys.
    function join(uint256 pick, uint256 who, uint256 routes, uint256 payer, uint256 lmsIn, uint8 count)
        public
    {
        _resume();
        count = uint8(bound(count, 2, 8));
        for (uint256 k = 0; k < count; ++k) {
            (bytes32 matchId, address player) = _joinable(pick, who % actors.length + k);
            if (matchId == bytes32(0)) return;
            _join(
                matchId,
                player,
                (routes >> (8 * k)) % 3,
                actors[(payer % actors.length + k) % actors.length],
                lmsIn
            );
        }
    }

    function _join(bytes32 matchId, address player, uint256 route, address payer, uint256 lmsIn) private {
        if (route == 2) {
            lmsIn = bound(lmsIn, 1e18, 50e18);
            (uint256 discount, uint256 lmsUsed) = escrow.quoteLmsDiscount(matchId, lmsIn);
            if (lms.balanceOf(player) >= lmsUsed) {
                vm.prank(player);
                escrow.joinWithLms{value: STAKE - discount}(matchId, lmsIn);
                return;
            }
            route = 0;
        }
        if (route == 1) {
            vm.prank(payer);
            escrow.joinFor{value: STAKE}(matchId, player);
        } else {
            vm.prank(player);
            escrow.join{value: STAKE}(matchId);
        }
    }

    /// @dev A stake bridged from a spoke and filled on the hub: too little,
    ///      exactly the stake, or more, for any match in any state. Every one
    ///      that cannot take a seat must be credited on the hub, and the books
    ///      must still balance.
    function crossChainJoin(uint256 pick, uint256 who, uint8 amount) public {
        if (matchIds.length == 0) return;
        bytes32 matchId = matchIds[pick % matchIds.length];
        uint256 value = [STAKE / 2, STAKE, STAKE + STAKE / 4][amount % 3];
        _fill(value, abi.encode(matchId, actors[who % actors.length], REMOTE_CHAIN));
    }

    /// @dev A deposit someone made with a message the receiver cannot read.
    function junkFill(uint256 value) public {
        value = bound(value, 1, 1 ether);
        _fill(value, hex"0badc0de");
        unroutable += value;
    }

    function _fill(uint256 value, bytes memory message) private {
        address weth = address(pool.weth());
        vm.deal(RELAYER, RELAYER.balance + value);
        vm.prank(RELAYER);
        pool.fill{value: value}(receiver, weth, value, uint32(block.timestamp + 1 hours), message);
    }

    // --- Play --------------------------------------------------------------

    /// @dev Closes a lobby with enough seats: one that is full or past its
    ///      join window, or failing that, one whose window this waits out.
    ///      Locking and seeding are separate actions, as on-chain, so a match
    ///      can be left `Pending` and reach the "oracle never answered"
    ///      cancellation.
    function lock(uint256 pick) public {
        _resume();
        uint256 n = matchIds.length;
        bytes32 waitFor;
        uint256 waitUntil;
        for (uint256 i = 0; i < n; ++i) {
            bytes32 matchId = matchIds[(pick % n + i) % n];
            GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
            if (info.status != GameEscrow.MatchStatus.Open) continue;
            if (info.seatCount < escrow.getMatchTerms(matchId).minSeats) continue;
            if (info.seatCount == info.maxSeats || block.timestamp >= info.joinDeadline) {
                return _lock(matchId);
            }
            if (waitFor == bytes32(0)) (waitFor, waitUntil) = (matchId, info.joinDeadline);
        }
        if (waitFor == bytes32(0)) return;
        vm.warp(waitUntil);
        _lock(waitFor);
    }

    function _lock(bytes32 matchId) private {
        requestOf[matchId] = escrow.lockMatch(matchId);
        ++locked;
    }

    function fulfill(uint256 pick, bytes32 randomness) public {
        (bytes32 matchId, bool found) = _withStatus(pick, GameEscrow.MatchStatus.Pending);
        if (!found) return;
        oracle.fulfill(requestOf[matchId], randomness);
    }

    /// @dev Proposes a shuffle of the seats as the result. The escrow never
    ///      replays a match, so the round count and root are arbitrary.
    function settle(uint256 pick, uint256 shuffle, bytes32 historyRoot, uint32 rounds) public {
        _resume();
        (bytes32 matchId, bool found) = _withStatus(pick, GameEscrow.MatchStatus.Live);
        if (!found) return;

        address[] memory ranking = escrow.getSeats(matchId);
        for (uint256 i = ranking.length - 1; i > 0; --i) {
            uint256 j = uint256(keccak256(abi.encode(shuffle, i))) % (i + 1);
            (ranking[i], ranking[j]) = (ranking[j], ranking[i]);
        }
        rounds = uint32(bound(rounds, 1, 64));
        bytes32 transcriptHash = keccak256(abi.encode(historyRoot));
        bytes32 structHash = harness.hashMatchResult(matchId, rounds, historyRoot, transcriptHash, ranking);
        bytes32 digest = harness.toTypedDataHash(escrow.domainSeparator(), structHash);

        escrow.settle(
            matchId, rounds, historyRoot, transcriptHash, ranking, Attest.signAscending(_attestors(), digest)
        );
        proposedRanking[matchId] = ranking;
        challenge[matchId] = Challenge({
            proposedAt: block.timestamp,
            deadline: block.timestamp + challengeWindow,
            disputed: false,
            disputedSeats: 0,
            finalizedAt: 0,
            deadlineAtFinalize: 0,
            disputedAtFinalize: false
        });
        ++proposed;
    }

    /// @dev Waits out a proposed result's challenge window, extended or not,
    ///      and pays it.
    function finalize(uint256 pick) public {
        (bytes32 matchId, bool found) = _withStatus(pick, GameEscrow.MatchStatus.Proposed);
        if (!found) return;
        uint256 deadline = escrow.getMatch(matchId).deadline;
        if (block.timestamp < deadline) vm.warp(deadline);
        _countExit();
        escrow.finalize(matchId, proposedRanking[matchId]);
        ++finalized;

        Challenge storage c = challenge[matchId];
        (c.finalizedAt, c.deadlineAtFinalize, c.disputedAtFinalize) =
            (block.timestamp, c.deadline, c.disputed);
        uint256 epoch = block.timestamp / escrow.FEE_EPOCH();
        settledInEpochPlusOne[matchId] = epoch + 1;
        if (!seenEpoch[epoch]) {
            seenEpoch[epoch] = true;
            epochs.push(epoch);
        }
    }

    /// @dev The guardian, or governance, throws out a result still open to
    ///      challenge: every stake comes back.
    function veto(uint256 pick, bool byGovernance) public {
        bytes32 matchId = _challengeable(pick);
        if (matchId == bytes32(0)) return;
        _countExit();
        vm.prank(byGovernance ? governance : GUARDIAN);
        escrow.veto(matchId);
        ++vetoed;
    }

    /// @dev A seat that has not yet disputed a result still open to challenge
    ///      disputes it.
    function dispute(uint256 pick, uint256 who, bytes32 evidenceHash) public {
        uint256 n = matchIds.length;
        for (uint256 i = 0; i < n; ++i) {
            bytes32 matchId = matchIds[(pick % n + i) % n];
            if (!_isChallengeable(matchId)) continue;
            address[] memory seats = escrow.getSeats(matchId);
            Challenge storage c = challenge[matchId];
            for (uint256 k = 0; k < seats.length; ++k) {
                uint256 seat = (who % seats.length + k) % seats.length;
                if (c.disputedSeats & (1 << seat) != 0) continue;
                _countExit();
                vm.prank(seats[seat]);
                escrow.dispute(matchId, evidenceHash);
                ++disputed;

                c.disputedSeats |= 1 << seat;
                if (!c.disputed) {
                    c.disputed = true;
                    c.deadline += DISPUTE_EXTENSION;
                }
                return;
            }
        }
    }

    /// @dev The guardian, or governance, finds an open dispute unfounded.
    function dismissDispute(uint256 pick, bool byGovernance) public {
        uint256 n = matchIds.length;
        for (uint256 i = 0; i < n; ++i) {
            bytes32 matchId = matchIds[(pick % n + i) % n];
            if (!_isChallengeable(matchId) || !escrow.getMatch(matchId).disputed) continue;
            vm.prank(byGovernance ? governance : GUARDIAN);
            escrow.dismissDispute(matchId);

            Challenge storage c = challenge[matchId];
            c.disputed = false;
            uint256 restored = c.deadline - DISPUTE_EXTENSION;
            c.deadline = restored > block.timestamp ? restored : block.timestamp;
            return;
        }
    }

    /// @dev The quorum aborts a live match the server lost, on a quarter of
    ///      the calls: it is rare, and every abort is a match that never settles.
    function abort(uint256 pick) public {
        if (pick % 4 != 0) return;
        (bytes32 matchId, bool found) = _withStatus(pick, GameEscrow.MatchStatus.Live);
        if (!found) return;
        bytes32 structHash = keccak256(abi.encode(keccak256("MatchAbort(bytes32 matchId)"), matchId));
        bytes32 digest = harness.toTypedDataHash(escrow.domainSeparator(), structHash);
        escrow.abortMatch(matchId, Attest.signAscending(_attestors(), digest));
        ++aborted;
    }

    /// @dev Cancels a match that can no longer complete: an open lobby past
    ///      its join window (and the lock grace, if it had enough seats), a
    ///      `Pending` match past its seed deadline, or a `Live` one past its
    ///      settle deadline. Failing one, it waits for a lobby short of seats
    ///      to expire. It never waits on one that could start, on a seed or on
    ///      a result: that would end most matches before they settle, and time
    ///      passes for them anyway.
    function cancel(uint256 pick) public {
        uint256 n = matchIds.length;
        bytes32 waitFor;
        uint256 waitUntil;
        for (uint256 i = 0; i < n; ++i) {
            bytes32 matchId = matchIds[(pick % n + i) % n];
            GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
            uint256 cancellableAt;
            if (info.status == GameEscrow.MatchStatus.Open) {
                cancellableAt = info.joinDeadline;
                if (info.seatCount >= escrow.getMatchTerms(matchId).minSeats) cancellableAt += LOCK_GRACE;
                else if (waitFor == bytes32(0)) (waitFor, waitUntil) = (matchId, cancellableAt);
            } else if (
                info.status == GameEscrow.MatchStatus.Pending || info.status == GameEscrow.MatchStatus.Live
            ) {
                cancellableAt = info.deadline;
            } else {
                continue;
            }
            if (block.timestamp >= cancellableAt) return _cancel(matchId);
        }
        if (waitFor == bytes32(0)) return;
        if (block.timestamp < waitUntil) vm.warp(waitUntil);
        _cancel(waitFor);
    }

    function _cancel(bytes32 matchId) private {
        _countExit();
        escrow.cancelMatch(matchId);
        ++cancelled;
    }

    // --- Withdrawals -------------------------------------------------------

    /// @dev An actor with a balance withdraws it.
    function withdraw(uint256 who) public {
        for (uint256 i = 0; i < actors.length; ++i) {
            address actor = actors[(who % actors.length + i) % actors.length];
            if (escrow.withdrawable(actor) == 0) continue;
            _countExit();
            vm.prank(actor);
            escrow.withdraw(actor);
            return;
        }
    }

    /// @dev Anyone pushes a balance worth a relayer's gas to its owner.
    function withdrawFor(uint256 caller, uint256 who) public {
        for (uint256 i = 0; i < actors.length; ++i) {
            address account = actors[(who % actors.length + i) % actors.length];
            if (escrow.withdrawable(account) < escrow.MIN_WITHDRAW_FOR()) continue;
            _countExit();
            vm.prank(actors[caller % actors.length]);
            escrow.withdrawFor(account);
            return;
        }
    }

    // --- Pause -------------------------------------------------------------

    /// @dev The guardian tries to pause, whatever the state: allowed only
    ///      while play runs and a week has passed since the last pause ended.
    ///      Half the time it waits up to ten days first, so the campaign
    ///      reaches the end of a cooldown as well as tries inside one.
    function guardianPause(uint256 wait) public {
        if (wait % 2 == 0) vm.warp(block.timestamp + bound(wait, 0, 10 days));
        bool running = block.timestamp >= modelPausedUntil;
        bool cooledDown = modelPausedUntil == 0 || block.timestamp >= modelPausedUntil + 7 days;

        vm.prank(GUARDIAN);
        try escrow.pause() {
            if (!running || !cooledDown) ++guardianPauseMismatches;
            modelPausedUntil = block.timestamp + 7 days;
            guardianPauseEnd = modelPausedUntil;
        } catch {
            if (running && cooledDown) ++guardianPauseMismatches;
        }
    }

    /// @dev Governance keeps play paused, or pauses it, for up to two weeks
    ///      past whichever is later: now, or the current pause's end. On a
    ///      quarter of the calls: every pause skips days for the matches in
    ///      play, and the guardian's cooldown already rations its own.
    function governancePause(uint256 extra) public {
        if (extra % 4 != 0) return;
        uint256 from = block.timestamp > modelPausedUntil ? block.timestamp : modelPausedUntil;
        uint64 until = uint64(from + bound(extra, 1 hours, 14 days));
        vm.prank(governance);
        escrow.extendPause(until);
        modelPausedUntil = until;
        governancePauseEnd = until;
    }

    function unpause(bool byGovernance) public {
        if (!escrow.paused()) return;
        vm.prank(byGovernance ? governance : GUARDIAN);
        escrow.unpause();
        modelPausedUntil = block.timestamp;
    }

    // --- Picking -----------------------------------------------------------

    function _withStatus(uint256 pick, GameEscrow.MatchStatus status)
        private
        view
        returns (bytes32 matchId, bool found)
    {
        uint256 n = matchIds.length;
        for (uint256 i = 0; i < n; ++i) {
            matchId = matchIds[(pick % n + i) % n];
            if (escrow.getMatch(matchId).status == status) return (matchId, true);
        }
        return (bytes32(0), false);
    }

    function _isChallengeable(bytes32 matchId) private view returns (bool) {
        GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
        return info.status == GameEscrow.MatchStatus.Proposed && block.timestamp < info.deadline;
    }

    function _challengeable(uint256 pick) private view returns (bytes32) {
        uint256 n = matchIds.length;
        for (uint256 i = 0; i < n; ++i) {
            bytes32 matchId = matchIds[(pick % n + i) % n];
            if (_isChallengeable(matchId)) return matchId;
        }
        return bytes32(0);
    }

    /// @dev An open lobby with a seat free and its window still open, and a
    ///      player who may take it: not seated, and on the roster if it has one.
    function _joinable(uint256 pick, uint256 who) private view returns (bytes32, address) {
        uint256 n = matchIds.length;
        for (uint256 i = 0; i < n; ++i) {
            bytes32 matchId = matchIds[(pick % n + i) % n];
            GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
            if (info.status != GameEscrow.MatchStatus.Open) continue;
            if (block.timestamp >= info.joinDeadline || info.seatCount >= info.maxSeats) continue;
            for (uint256 k = 0; k < actors.length; ++k) {
                address player = actors[(who % actors.length + k) % actors.length];
                if (escrow.hasSeat(matchId, player)) continue;
                if (info.matchmade && !escrow.rostered(matchId, player)) continue;
                return (matchId, player);
            }
        }
        return (bytes32(0), address(0));
    }

    function _joinableLobbies() private view returns (uint256 count) {
        for (uint256 i = 0; i < matchIds.length; ++i) {
            GameEscrow.MatchInfo memory info = escrow.getMatch(matchIds[i]);
            if (info.status != GameEscrow.MatchStatus.Open) continue;
            if (block.timestamp < info.joinDeadline && info.seatCount < info.maxSeats) ++count;
        }
    }

    function _attestors() private view returns (uint256[] memory pks) {
        pks = new uint256[](attestorPks.length);
        for (uint256 i = 0; i < pks.length; ++i) {
            pks[i] = attestorPks[i];
        }
    }

    /// @dev What lobbies, joins, locks and proposals do in a pause: wait it
    ///      out. Skipping instead would leave a campaign that paused early
    ///      doing nothing else for the rest of the run.
    function _resume() private {
        uint256 until = escrow.pausedUntil();
        if (block.timestamp < until) vm.warp(until);
    }

    function _countExit() private {
        if (escrow.paused()) ++exitsWhilePaused;
    }
}

/// @dev Runs on the shared `Fixtures`: the deployment every unit test sees,
///      with its eight players as the actors and two of its three attestors
///      signing.
///
///      A match takes a dozen calls or so from lobby to payout, so runs are
///      long and fewer: as many calls in all as the default.
/// forge-config: default.invariant.fail-on-revert = true
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 256
contract EscrowInvariantTest is Fixtures {
    EscrowHandler internal handler;
    MockAcrossSpokePool internal pool;
    BridgeJoinReceiver internal receiver;
    LmsToken internal lms;
    uint256 internal initialLmsSupply;

    function setUp() public override {
        super.setUp();

        address[] memory actors = new address[](players.length);
        for (uint256 i = 0; i < players.length; ++i) {
            actors[i] = players[i];
        }

        // Cross-chain joins arrive the real way: a fill of the hub's pool,
        // handled by the receiver.
        pool = new MockAcrossSpokePool(IWETH9(address(new MockWETH())));
        receiver = new BridgeJoinReceiver(owner, escrow, IAcrossSpokePool(address(pool)));
        lms = new LmsToken(address(this), 1_000_000e18);

        handler = new EscrowHandler(
            escrow,
            oracle,
            harness,
            pool,
            address(receiver),
            lms,
            owner,
            CHALLENGE_WINDOW,
            actors,
            _twoAttestors()
        );

        // Windows of a day rather than an hour, so a lobby outlives the time
        // other matches' deadlines and pauses skip.
        ProtocolConfig.Params memory params = config.getParams();
        params.joinWindow = 1 days;
        params.settleWindow = 1 days;

        vm.startPrank(owner);
        config.setParams(params);
        config.setBridgeReceiver(address(receiver));
        config.setLmsToken(address(lms));
        config.setLmsPerEthDiscount(20_000e18);
        config.setMatchmaker(handler.MATCHMAKER());
        config.setGuardian(handler.GUARDIAN());
        vm.stopPrank();

        for (uint256 i = 0; i < actors.length; ++i) {
            lms.transfer(actors[i], 10_000e18);
            vm.prank(actors[i]);
            lms.approve(address(escrow), type(uint256).max);
        }
        initialLmsSupply = lms.totalSupply();

        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: handler.actions()}));
    }

    function invariant_solvency() public view {
        assertEq(address(escrow).balance, escrow.totalOwed() + escrow.totalEscrowed());
    }

    /// @dev With matches in every state at once, what the escrow holds for
    ///      them is exactly the stakes of those that have not ended, net of
    ///      their discounts.
    function invariant_escrowedIsTheStakesOfMatchesNotEnded() public view {
        uint256 held;
        for (uint256 m = 0; m < handler.matchCount(); ++m) {
            bytes32 matchId = handler.matchIds(m);
            GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
            if (
                info.status == GameEscrow.MatchStatus.Settled
                    || info.status == GameEscrow.MatchStatus.Cancelled
            ) {
                continue;
            }
            held += uint256(info.stake) * info.seatCount - _discounts(matchId, true);
        }
        assertEq(escrow.totalEscrowed(), held);
    }

    /// @dev The receiver keeps nothing a fill brought for a seat: all of it is
    ///      in the escrow. What it does keep is exactly what it could not route.
    function invariant_theReceiverHoldsOnlyWhatItCouldNotRoute() public view {
        assertEq(address(receiver).balance, handler.unroutable());
        assertEq(pool.weth().balanceOf(address(receiver)), 0);
    }

    function invariant_owedNeverExceedsBalance() public view {
        assertLe(escrow.totalOwed(), address(escrow).balance);
    }

    /// @dev No result pays before its challenge window closes, nor, while a
    ///      dispute is open, before the 48 hours it adds; and a result still
    ///      open to challenge has exactly the deadline the rules give it.
    function invariant_aDisputeHoldsTheResultBack() public view {
        uint256 window = handler.challengeWindow();
        for (uint256 m = 0; m < handler.matchCount(); ++m) {
            bytes32 matchId = handler.matchIds(m);
            GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
            EscrowHandler.Challenge memory c = handler.challengeOf(matchId);
            if (info.status == GameEscrow.MatchStatus.Proposed) {
                assertEq(info.deadline, c.deadline);
                assertEq(info.disputed, c.disputed);
                assertGe(c.deadline, c.proposedAt + window);
            }
            if (c.finalizedAt == 0) continue;
            assertEq(uint8(info.status), uint8(GameEscrow.MatchStatus.Settled));
            assertGe(c.finalizedAt, c.deadlineAtFinalize);
            assertGe(c.finalizedAt, c.proposedAt + window);
            if (c.disputedAtFinalize) assertGe(c.finalizedAt, c.proposedAt + window + DISPUTE_EXTENSION);
        }
    }

    /// @dev A guardian pause ends within a week unless governance keeps it:
    ///      `pausedUntil` is never later than the last end either one set, and
    ///      the guardian could pause exactly when the cooldown allowed.
    function invariant_aPauseExpiresUnlessGovernanceKeepsIt() public view {
        uint256 until = escrow.pausedUntil();
        assertEq(until, handler.modelPausedUntil());
        uint256 guardianEnd = handler.guardianPauseEnd();
        uint256 governanceEnd = handler.governancePauseEnd();
        assertLe(until, guardianEnd > governanceEnd ? guardianEnd : governanceEnd);
        assertEq(handler.guardianPauseMismatches(), 0);
    }

    /// @dev Each epoch's total is the sum of its players' — through joins,
    ///      refunds and settlements in any order. Every player in the campaign
    ///      is an actor, cross-chain seats included.
    function invariant_epochFeesAreTheSumOfPlayersFees() public view {
        for (uint256 e = 0; e < handler.epochCount(); ++e) {
            uint256 epoch = handler.epochs(e);
            uint256 sum;
            for (uint256 a = 0; a < handler.actorCount(); ++a) {
                sum += escrow.feesPaid(handler.actors(a), epoch);
            }
            assertEq(escrow.epochFees(epoch), sum);
        }
    }

    /// @dev The LMS the escrow holds is exactly the discounts of matches that
    ///      have not ended; what settled matches paid has been burned, and
    ///      what cancelled ones paid has gone back.
    function invariant_lmsHeldIsThePendingDiscounts_andTheRestIsBurned() public view {
        uint256 pending;
        uint256 burned;
        for (uint256 m = 0; m < handler.matchCount(); ++m) {
            bytes32 matchId = handler.matchIds(m);
            GameEscrow.MatchStatus status = escrow.getMatch(matchId).status;
            uint256 paid = _discounts(matchId, false);
            if (status == GameEscrow.MatchStatus.Settled) burned += paid;
            else if (status != GameEscrow.MatchStatus.Cancelled) pending += paid;
        }
        assertEq(lms.balanceOf(address(escrow)), escrow.totalLmsEscrowed());
        assertEq(escrow.totalLmsEscrowed(), pending);
        assertEq(initialLmsSupply - lms.totalSupply(), burned);
    }

    /// @dev Every seat's ETH discount, or with `inEth` false the LMS paid for them.
    function _discounts(bytes32 matchId, bool inEth) private view returns (uint256 total) {
        address[] memory seats = escrow.getSeats(matchId);
        for (uint256 i = 0; i < seats.length; ++i) {
            GameEscrow.Discount memory seat = escrow.getSeatDiscount(matchId, seats[i]);
            total += inEth ? seat.eth : seat.lms;
        }
    }

    /// @dev Nobody the matchmaker did not roster sits in a matchmade lobby,
    ///      whichever route their stake took.
    function invariant_matchmadeSeatsAreRostered() public view {
        for (uint256 m = 0; m < handler.matchCount(); ++m) {
            bytes32 matchId = handler.matchIds(m);
            if (!escrow.getMatch(matchId).matchmade) continue;
            address[] memory seats = escrow.getSeats(matchId);
            for (uint256 i = 0; i < seats.length; ++i) {
                assertTrue(escrow.rostered(matchId, seats[i]));
            }
        }
    }

    /// @dev And it counts exactly the seats of the matchmade matches that
    ///      settled in it, net of their discounts: nothing for a match still
    ///      open, in play, refunded or vetoed, and nothing for a private one.
    function invariant_epochFeesCountOnlySettledMatches() public view {
        uint256 seatFee = (uint256(handler.STAKE()) * config.feeBps()) / BPS_DENOMINATOR;
        uint256 expectedTotal;
        for (uint256 e = 0; e < handler.epochCount(); ++e) {
            uint256 epoch = handler.epochs(e);
            uint256 expected;
            for (uint256 m = 0; m < handler.matchCount(); ++m) {
                bytes32 matchId = handler.matchIds(m);
                if (handler.settledInEpochPlusOne(matchId) != epoch + 1) continue;
                GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
                assertEq(uint8(info.status), uint8(GameEscrow.MatchStatus.Settled));
                if (!info.matchmade) continue;
                expected += seatFee * info.seatCount - _discounts(matchId, true);
            }
            assertEq(escrow.epochFees(epoch), expected);
            expectedTotal += expected;
        }
        // No settled match left out: every Settled one was recorded above.
        uint256 settledFees;
        for (uint256 m = 0; m < handler.matchCount(); ++m) {
            bytes32 matchId = handler.matchIds(m);
            GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
            if (info.status != GameEscrow.MatchStatus.Settled || !info.matchmade) continue;
            settledFees += seatFee * info.seatCount - _discounts(matchId, true);
        }
        assertEq(expectedTotal, settledFees);
    }
}
