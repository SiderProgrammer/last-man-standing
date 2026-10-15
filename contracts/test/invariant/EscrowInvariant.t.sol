// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {ProtocolConfig} from "../../src/ProtocolConfig.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {MockRandomnessOracle} from "../../src/mocks/MockRandomnessOracle.sol";
import {MockMessenger} from "../../src/mocks/MockMessenger.sol";
import {AttestorBonds} from "../../src/AttestorBonds.sol";
import {MatchVerifier} from "../../src/MatchVerifier.sol";
import {SettlementHarness} from "../helpers/SettlementHarness.sol";
import {Attest} from "../helpers/Attest.sol";
import {HonestMatch} from "../helpers/HonestMatch.sol";

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

    function createMatch() public {
        address actor = actors[bound(uint256(uint160(msg.sender)), 0, actors.length - 1)];
        vm.prank(actor);
        current = escrow.createMatch(STAKE, 4);
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

    MatchVerifier public verifier;

    /// @dev Set once by `setUp`, for the same reason as `setMessenger`.
    function setVerifier(MatchVerifier verifier_) external {
        if (address(verifier) == address(0)) verifier = verifier_;
    }

    /// @dev Proposes the honest result over a real round log: `settle` checks
    ///      the log against the signed root, so a made-up root no longer settles.
    function settle() public {
        if (current == bytes32(0)) return;
        address[] memory seats = escrow.getSeats(current);
        if (seats.length == 0) return;

        HonestMatch.Played memory played = HonestMatch.play(verifier, current, escrow.getMatch(current).seed, seats.length);
        address[] memory ranking = new address[](seats.length);
        for (uint256 i = 0; i < seats.length; ++i) {
            ranking[i] = seats[played.ranking[i]];
        }
        bytes32 historyRoot = played.root;
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 rounds = uint32(played.rounds.length);

        bytes32 structHash = harness.hashMatchResult(current, rounds, historyRoot, ranking);
        bytes32 digest = harness.toTypedDataHash(escrow.domainSeparator(), structHash);

        uint256 n = attestorPks.length;
        uint256[] memory pks = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            pks[i] = attestorPks[i];
        }
        escrow.settle(current, rounds, historyRoot, ranking, Attest.signAscending(pks, digest), HonestMatch.log(played));
        proposedRanking = ranking;
        ++settled;
    }

    address[] internal proposedRanking;
    uint256 public finalized;

    /// @dev Waits out the challenge window and pays the proposed result.
    function finalize() public {
        if (current == bytes32(0) || proposedRanking.length == 0) return;
        vm.warp(block.timestamp + 2 hours);
        escrow.finalize(current, proposedRanking);
        ++finalized;
    }

    function withdraw(uint256 who) public {
        address actor = actors[who % actors.length];
        vm.prank(actor);
        escrow.withdraw(actor);
    }

    MockMessenger public messenger;
    uint32 public constant REMOTE_CHAIN = 421_614;
    bytes32 public constant REMOTE_PEER = bytes32(uint256(0xBEEF));

    /// @dev Set once by `setUp`. The fuzzer calls every public function on the
    ///      handler, so a re-settable messenger would be pointed at junk.
    function setMessenger(MockMessenger messenger_) external {
        if (address(messenger) == address(0)) messenger = messenger_;
    }

    /// @dev A stake arriving from a spoke. Sometimes the wrong amount, often
    ///      for a lobby that has since filled, locked or settled: every one of
    ///      those must be refunded on the hub, and the books must still balance.
    function crossChainJoin(uint256 who, bool wrongStake) public {
        if (current == bytes32(0) || address(messenger) == address(0)) return;
        address actor = actors[who % actors.length];
        uint256 value = wrongStake ? STAKE / 2 : STAKE;
        vm.deal(address(messenger), address(messenger).balance + value);
        messenger.deliver(address(escrow), REMOTE_CHAIN, REMOTE_PEER, abi.encode(current, actor), value);
    }

    /// @dev Anyone pushes an actor's balance to that actor.
    function withdrawFor(uint256 caller, uint256 who) public {
        address account = actors[who % actors.length];
        vm.prank(actors[caller % actors.length]);
        escrow.withdrawFor(account);
    }
}

contract EscrowInvariantTest is StdInvariant, Test {
    GameEscrow internal escrow;
    EscrowHandler internal handler;
    MatchVerifier internal verifier;
    address internal treasury;

    function setUp() public {
        address owner = makeAddr("owner");
        treasury = makeAddr("treasury");

        uint256 pkA = 0xA11CE;
        uint256 pkB = 0xB0B;

        MockRandomnessOracle oracle = new MockRandomnessOracle();

        ProtocolConfig.Params memory params = ProtocolConfig.Params({
            feeBps: 500,
            minSeats: 4,
            maxSeats: 8,
            joinWindow: 1 hours,
            settleWindow: 1 hours,
            minStake: 0.01 ether,
            maxStake: 10 ether,
            treasury: treasury
        });
        uint16[] memory payout = new uint16[](1);
        payout[0] = 10_000;

        vm.prank(owner);
        ProtocolConfig config = new ProtocolConfig(owner, params, payout);
        vm.startPrank(owner);
        config.setRandomnessOracle(address(oracle));
        config.setAttestor(vm.addr(pkA), true);
        config.setAttestor(vm.addr(pkB), true);
        config.setAttestorThreshold(2);
        vm.stopPrank();

        SettlementHarness harness = new SettlementHarness();
        _wireSettlement(config, owner, harness.hashRulesDefault(), pkA, pkB);

        address[] memory actors = new address[](6);
        for (uint256 i = 0; i < actors.length; ++i) {
            actors[i] = makeAddr(string.concat("p", vm.toString(i)));
            vm.deal(actors[i], 1_000 ether);
        }

        uint256[] memory pks = new uint256[](2);
        pks[0] = pkA;
        pks[1] = pkB;

        handler = new EscrowHandler(escrow, oracle, harness, actors, pks);
        handler.setVerifier(verifier);
        MockMessenger messenger = new MockMessenger();
        handler.setMessenger(messenger);
        uint32 remoteChain = handler.REMOTE_CHAIN();
        bytes32 remotePeer = handler.REMOTE_PEER();
        vm.prank(owner);
        config.setRemoteChain(remoteChain, address(messenger), remotePeer);
        targetContract(address(handler));
    }

    /// @dev Rules, bonded attestors, the verifier and the escrow itself. Split
    ///      out of `setUp` only to keep its stack within the legacy pipeline's limit.
    function _wireSettlement(ProtocolConfig config, address owner, bytes32 rulesHash, uint256 pkA, uint256 pkB)
        private
    {
        AttestorBonds bonds = new AttestorBonds(owner, config, config.treasury(), 1 ether, 1 days, 2_000);
        verifier = new MatchVerifier();
        vm.startPrank(owner);
        config.setRulesHash(rulesHash);
        config.setAttestorBonds(address(bonds));
        config.setMatchVerifier(address(verifier));
        config.setChallengeWindow(1 hours);
        vm.stopPrank();
        escrow = new GameEscrow(config);
        vm.prank(owner);
        bonds.setSlasher(address(escrow), true);
        vm.deal(address(this), 2 ether);
        bonds.bond{value: 1 ether}(vm.addr(pkA));
        bonds.bond{value: 1 ether}(vm.addr(pkB));
    }

    function invariant_solvency() public view {
        assertEq(address(escrow).balance, escrow.totalOwed() + escrow.totalEscrowed());
    }

    function invariant_owedNeverExceedsBalance() public view {
        assertLe(escrow.totalOwed(), address(escrow).balance);
    }
}
