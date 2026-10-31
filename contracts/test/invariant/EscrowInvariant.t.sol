// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {BPS_DENOMINATOR} from "../../src/Constants.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
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

/// @dev Actor that drives GameEscrow through random sequences of public calls.
contract EscrowHandler is Test {
    GameEscrow public escrow;
    MockRandomnessOracle public oracle;
    SettlementHarness public harness;

    address[] public actors;
    uint256[] public attestorPks;

    bytes32 public current;
    bytes32 public pendingRequest;

    /// @dev Ghost counters: how far the campaign actually got, so a handler
    ///      that silently stops reaching settlement shows up as a zero.
    uint256 public locked;
    uint256 public settled;
    uint128 public constant STAKE = 0.05 ether;

    constructor(
        GameEscrow escrow_,
        MockRandomnessOracle oracle_,
        SettlementHarness harness_,
        address[] memory actors_,
        uint256[] memory attestorPks_
    ) {
        escrow = escrow_;
        oracle = oracle_;
        harness = harness_;
        actors = actors_;
        attestorPks = attestorPks_;
    }

    /// @dev Every match the campaign opened, every fee epoch one settled in,
    ///      and which epoch that was, plus one (zero: not settled).
    bytes32[] public matchIds;
    uint256[] public epochs;
    mapping(uint256 epoch => bool) private seenEpoch;
    mapping(bytes32 matchId => uint256) public settledInEpochPlusOne;

    function createMatch() public {
        address actor = actors[bound(uint256(uint160(msg.sender)), 0, actors.length - 1)];
        vm.prank(actor);
        current = escrow.createMatch(STAKE, 4);
        matchIds.push(current);
    }

    /// @dev The config's matchmaker; `setUp` names it.
    address public constant MATCHMAKER = address(0x3A7C4);

    /// @dev A matchmade lobby for the actors `mask` picks, at least four of
    ///      them. Joins by anyone else revert, and their bridged stakes are
    ///      credited back.
    function createMatchmade(uint256 mask) public {
        mask = bound(mask, 0, (1 << actors.length) - 1) | 0x0f;
        uint256 count;
        for (uint256 i = 0; i < actors.length; ++i) {
            if (mask & (1 << i) != 0) ++count;
        }
        address[] memory roster = new address[](count);
        uint256 n;
        for (uint256 i = 0; i < actors.length; ++i) {
            if (mask & (1 << i) != 0) roster[n++] = actors[i];
        }
        vm.prank(MATCHMAKER);
        current = escrow.createMatchmade(STAKE, 4, roster);
        matchIds.push(current);
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

    function join(uint256 who) public {
        if (current == bytes32(0)) return;
        address actor = actors[who % actors.length];
        vm.prank(actor);
        escrow.join{value: STAKE}(current);
    }

    /// @dev One actor pays, another is seated: the value and the seat part ways.
    function joinFor(uint256 payer, uint256 who) public {
        if (current == bytes32(0)) return;
        vm.prank(actors[payer % actors.length]);
        escrow.joinFor{value: STAKE}(current, actors[who % actors.length]);
    }

    /// @dev Locking and seeding are separate actions, as they are on-chain, so
    ///      the fuzzer can also leave a match `Pending` and reach the
    ///      "oracle never answered" cancellation.
    function lock() public {
        if (current == bytes32(0)) return;
        pendingRequest = escrow.lockMatch(current);
        ++locked;
    }

    function fulfill(bytes32 randomness) public {
        if (pendingRequest == bytes32(0)) return;
        bytes32 requestId = pendingRequest;
        pendingRequest = bytes32(0);
        oracle.fulfill(requestId, randomness);
    }

    function cancel() public {
        if (current == bytes32(0)) return;
        vm.warp(block.timestamp + 30 days);
        escrow.cancelMatch(current);
    }

    /// @dev Proposes the seat order as the result. The escrow never replays a
    ///      match, so the round count and root are arbitrary.
    function settle(bytes32 historyRoot, uint32 rounds) public {
        if (current == bytes32(0)) return;
        address[] memory seats = escrow.getSeats(current);
        if (seats.length == 0) return;
        address[] memory ranking = seats;
        rounds = uint32(bound(rounds, 1, 64));

        bytes32 transcriptHash = keccak256(abi.encode(historyRoot));
        bytes32 structHash = harness.hashMatchResult(current, rounds, historyRoot, transcriptHash, ranking);
        bytes32 digest = harness.toTypedDataHash(escrow.domainSeparator(), structHash);

        uint256 n = attestorPks.length;
        uint256[] memory pks = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            pks[i] = attestorPks[i];
        }
        escrow.settle(
            current, rounds, historyRoot, transcriptHash, ranking, Attest.signAscending(pks, digest)
        );
        proposedRanking = ranking;
        ++settled;
    }

    address[] internal proposedRanking;
    uint256 public finalized;

    /// @dev Waits out the challenge window, extended or not, and pays the
    ///      proposed result.
    function finalize() public {
        if (current == bytes32(0) || proposedRanking.length == 0) return;
        uint256 deadline = escrow.getMatch(current).deadline;
        vm.warp(block.timestamp < deadline ? deadline : block.timestamp + 2 hours);
        escrow.finalize(current, proposedRanking);
        ++finalized;

        uint256 epoch = block.timestamp / escrow.FEE_EPOCH();
        settledInEpochPlusOne[current] = epoch + 1;
        if (!seenEpoch[epoch]) {
            seenEpoch[epoch] = true;
            epochs.push(epoch);
        }
    }

    address public constant GUARDIAN = address(0x6A2D);
    uint256 public vetoed;

    /// @dev The guardian throws out a proposed result: every stake comes back.
    function veto() public {
        if (current == bytes32(0)) return;
        vm.prank(GUARDIAN);
        escrow.veto(current);
        ++vetoed;
    }

    uint256 public disputed;

    /// @dev A seated player disputes the proposed result, holding back its payout.
    function dispute(uint256 who) public {
        if (current == bytes32(0)) return;
        address[] memory seats = escrow.getSeats(current);
        if (seats.length == 0) return;
        vm.prank(seats[who % seats.length]);
        escrow.dispute(current, keccak256(abi.encode(who)));
        ++disputed;
    }

    /// @dev The guardian finds a dispute unfounded.
    function dismissDispute() public {
        if (current == bytes32(0)) return;
        vm.prank(GUARDIAN);
        escrow.dismissDispute(current);
    }

    function withdraw(uint256 who) public {
        address actor = actors[who % actors.length];
        vm.prank(actor);
        escrow.withdraw(actor);
    }

    MockAcrossSpokePool public pool;
    address public receiver;
    uint32 public constant REMOTE_CHAIN = 421_614;
    /// @dev Ghost: what fills with an unreadable message left in the receiver.
    uint256 public unroutable;

    /// @dev Set once by `setUp`. The fuzzer calls every public function on the
    ///      handler, so a re-settable pool would be pointed at junk.
    function setBridge(MockAcrossSpokePool pool_, address receiver_) external {
        if (receiver == address(0)) (pool, receiver) = (pool_, receiver_);
    }

    /// @dev A stake bridged from a spoke and filled on the hub: too little,
    ///      exactly the stake, or more. Often for a lobby that has since
    ///      filled, locked or settled: every one of those must be credited on
    ///      the hub, and the books must still balance.
    function crossChainJoin(uint256 who, uint8 amount) public {
        if (current == bytes32(0) || receiver == address(0)) return;
        address actor = actors[who % actors.length];
        uint256 value = [STAKE / 2, STAKE, STAKE + STAKE / 4][amount % 3];
        _fill(value, abi.encode(current, actor, REMOTE_CHAIN));
    }

    /// @dev A deposit someone made with a message the receiver cannot read.
    function junkFill(uint256 value) public {
        if (receiver == address(0)) return;
        value = bound(value, 1, 1 ether);
        _fill(value, hex"0badc0de");
        unroutable += value;
    }

    function _fill(uint256 value, bytes memory message) private {
        address relayer = address(0x7E1A7E);
        address weth = address(pool.weth());
        vm.deal(relayer, relayer.balance + value);
        vm.prank(relayer);
        pool.fill{value: value}(receiver, weth, value, uint32(block.timestamp + 1 hours), message);
    }

    LmsToken public lms;

    /// @dev Set once by `setUp`, like the pool.
    function setLms(LmsToken lms_) external {
        if (address(lms) == address(0)) lms = lms_;
    }

    /// @dev A seat paying part of its fee in LMS: anything from a sliver to
    ///      more than the cap, which only buys the cap.
    function joinWithLms(uint256 who, uint256 lmsIn) public {
        if (current == bytes32(0) || address(lms) == address(0)) return;
        address actor = actors[who % actors.length];
        lmsIn = bound(lmsIn, 1e18, 50e18);
        (uint256 discount,) = escrow.quoteLmsDiscount(current, lmsIn);
        vm.prank(actor);
        escrow.joinWithLms{value: STAKE - discount}(current, lmsIn);
    }

    /// @dev Anyone pushes an actor's balance to that actor.
    function withdrawFor(uint256 caller, uint256 who) public {
        address account = actors[who % actors.length];
        vm.prank(actors[caller % actors.length]);
        escrow.withdrawFor(account);
    }
}

/// @dev Runs on the shared `Fixtures`: the deployment every unit test sees,
///      with its eight players as the actors and two of its three attestors
///      signing.
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

        handler = new EscrowHandler(escrow, oracle, harness, actors, _twoAttestors());
        // Cross-chain joins arrive the real way: a fill of the hub's pool,
        // handled by the receiver.
        pool = new MockAcrossSpokePool(IWETH9(address(new MockWETH())));
        receiver = new BridgeJoinReceiver(owner, escrow, IAcrossSpokePool(address(pool)));
        vm.prank(owner);
        config.setBridgeReceiver(address(receiver));
        handler.setBridge(pool, address(receiver));

        lms = new LmsToken(address(this), 1_000_000e18);
        handler.setLms(lms);
        vm.startPrank(owner);
        config.setLmsToken(address(lms));
        config.setLmsPerEthDiscount(20_000e18);
        vm.stopPrank();
        for (uint256 i = 0; i < actors.length; ++i) {
            lms.transfer(actors[i], 10_000e18);
            vm.prank(actors[i]);
            lms.approve(address(escrow), type(uint256).max);
        }
        initialLmsSupply = lms.totalSupply();
        // Read first: a prank is spent on the next call, and the getter is one.
        address matchmaker_ = handler.MATCHMAKER();
        vm.prank(owner);
        config.setMatchmaker(matchmaker_);
        address guardian = handler.GUARDIAN();
        vm.prank(owner);
        config.setGuardian(guardian);
        targetContract(address(handler));
    }

    function invariant_solvency() public view {
        assertEq(address(escrow).balance, escrow.totalOwed() + escrow.totalEscrowed());
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
