// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {ProtocolConfig} from "../../src/ProtocolConfig.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {MockRandomnessOracle} from "../../src/mocks/MockRandomnessOracle.sol";
import {SettlementHarness} from "../helpers/SettlementHarness.sol";
import {Attest} from "../helpers/Attest.sol";

/// @dev Actor that drives GameEscrow through random sequences of public calls.
contract EscrowHandler is Test {
    GameEscrow public escrow;
    MockRandomnessOracle public oracle;
    SettlementHarness public harness;

    address[] public actors;
    uint256[] public attestorPks;

    bytes32 public current;
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

    function lock() public {
        if (current == bytes32(0)) return;
        escrow.lockMatch(current);
    }

    function fulfill(bytes32) public {}

    function fulfillKnown(bytes32 requestId, bytes32 randomness) public {
        oracle.fulfill(requestId, randomness);
    }

    function cancel() public {
        if (current == bytes32(0)) return;
        vm.warp(block.timestamp + 30 days);
        escrow.cancelMatch(current);
    }

    function settle(bytes32 historyRoot, uint32 rounds) public {
        if (current == bytes32(0)) return;
        if (rounds == 0) rounds = 1;
        address[] memory ranking = escrow.getSeats(current);
        if (ranking.length == 0) return;

        bytes32 structHash = harness.hashMatchResult(current, rounds, historyRoot, ranking);
        bytes32 digest = harness.toTypedDataHash(escrow.domainSeparator(), structHash);

        uint256 n = attestorPks.length;
        uint256[] memory pks = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            pks[i] = attestorPks[i];
        }
        escrow.settle(current, rounds, historyRoot, ranking, Attest.signAscending(pks, digest));
    }

    function withdraw(uint256 who) public {
        address actor = actors[who % actors.length];
        vm.prank(actor);
        escrow.withdraw(actor);
    }
}

contract EscrowInvariantTest is StdInvariant, Test {
    GameEscrow internal escrow;
    EscrowHandler internal handler;
    address internal treasury;

    function setUp() public {
        address owner = makeAddr("owner");
        treasury = makeAddr("treasury");

        uint256 pkA = 0xA11CE;
        uint256 pkB = 0xB0B;

        MockRandomnessOracle oracle = new MockRandomnessOracle();
        oracle.setAutoFulfill(true);

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

        escrow = new GameEscrow(config);
        SettlementHarness harness = new SettlementHarness();

        address[] memory actors = new address[](6);
        for (uint256 i = 0; i < actors.length; ++i) {
            actors[i] = makeAddr(string.concat("p", vm.toString(i)));
            vm.deal(actors[i], 1_000 ether);
        }

        uint256[] memory pks = new uint256[](2);
        pks[0] = pkA;
        pks[1] = pkB;

        handler = new EscrowHandler(escrow, oracle, harness, actors, pks);
        targetContract(address(handler));
    }

    function invariant_solvency() public view {
        assertEq(address(escrow).balance, escrow.totalOwed() + escrow.totalEscrowed());
    }

    function invariant_owedNeverExceedsBalance() public view {
        assertLe(escrow.totalOwed(), address(escrow).balance);
    }
}
