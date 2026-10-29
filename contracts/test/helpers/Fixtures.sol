// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {ProtocolConfig} from "../../src/ProtocolConfig.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {SpokeEscrow} from "../../src/SpokeEscrow.sol";
import {MockRandomnessOracle} from "../../src/mocks/MockRandomnessOracle.sol";
import {MockMessenger} from "../../src/mocks/MockMessenger.sol";
import {Attest} from "./Attest.sol";
import {SettlementHarness} from "./SettlementHarness.sol";

contract Fixtures is Test {
    uint256 internal constant ATTESTOR_PK_A = 0xA11CE;
    uint256 internal constant ATTESTOR_PK_B = 0xB0B;
    uint256 internal constant ATTESTOR_PK_C = 0xC0FFEE;

    address internal owner;
    address internal treasury;
    address internal attestorA;
    address internal attestorB;
    address internal attestorC;

    address[8] internal players;

    ProtocolConfig internal config;
    GameEscrow internal escrow;
    MockRandomnessOracle internal oracle;
    MockMessenger internal messenger;
    SettlementHarness internal harness;

    uint128 internal constant STAKE = 1 ether;
    uint64 internal constant CHALLENGE_WINDOW = 1 hours;
    /// @dev What the fixtures sign. The escrow never replays a match, so any
    ///      non-zero count and root will do.
    uint32 internal constant ROUNDS = 3;
    bytes32 internal constant HISTORY_ROOT = keccak256("history");

    function setUp() public virtual {
        owner = makeAddr("owner");
        treasury = makeAddr("treasury");
        attestorA = vm.addr(ATTESTOR_PK_A);
        attestorB = vm.addr(ATTESTOR_PK_B);
        attestorC = vm.addr(ATTESTOR_PK_C);

        for (uint256 i = 0; i < players.length; ++i) {
            players[i] = makeAddr(string.concat("player", vm.toString(i)));
            vm.deal(players[i], 100 ether);
        }
        vm.deal(treasury, 0);

        oracle = new MockRandomnessOracle();
        messenger = new MockMessenger();
        harness = new SettlementHarness();

        ProtocolConfig.Params memory params = ProtocolConfig.Params({
            feeBps: 500,
            minSeats: 4,
            maxSeats: 8,
            joinWindow: 1 hours,
            settleWindow: 2 hours,
            minStake: 0.01 ether,
            maxStake: 50 ether,
            treasury: treasury
        });

        uint16[] memory payout = new uint16[](1);
        payout[0] = 10_000;

        vm.prank(owner);
        config = new ProtocolConfig(owner, params, payout);

        vm.startPrank(owner);
        config.setRandomnessOracle(address(oracle));
        config.setAttestor(attestorA, true);
        config.setAttestor(attestorB, true);
        config.setAttestor(attestorC, true);
        config.setAttestorThreshold(2);
        config.setRulesHash(harness.hashRulesDefault());
        config.setRemoteChain(421_614, address(messenger), bytes32(uint256(uint160(address(0xBEEF)))));
        config.setChallengeWindow(CHALLENGE_WINDOW);
        vm.stopPrank();

        escrow = new GameEscrow(config);
    }

    /// @dev Signs and proposes `ranking` with two attestors.
    function _propose(bytes32 matchId, address[] memory ranking) internal {
        escrow.settle(
            matchId,
            ROUNDS,
            HISTORY_ROOT,
            ranking,
            _signResult(_twoAttestors(), matchId, ROUNDS, HISTORY_ROOT, ranking)
        );
    }

    /// @dev Proposes the seat order as the result, waits out the challenge
    ///      window, and pays it.
    function _settleAndFinalize(bytes32 matchId) internal returns (address[] memory ranking) {
        ranking = _rankingOf(matchId);
        _propose(matchId, ranking);
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        escrow.finalize(matchId, ranking);
    }

    /// @dev Pauses the escrow the way governance does, for a day.
    function _pause() internal {
        vm.prank(owner);
        escrow.extendPause(uint64(block.timestamp + 1 days));
    }

    function _createAndFill(uint16 seats) internal returns (bytes32 matchId) {
        vm.prank(players[0]);
        matchId = escrow.createMatch(STAKE, seats);
        for (uint16 i = 0; i < seats; ++i) {
            vm.prank(players[i]);
            escrow.join{value: STAKE}(matchId);
        }
    }

    function _lockAndSeed(bytes32 matchId, bytes32 randomness) internal returns (bytes32 seed) {
        bytes32 requestId = escrow.lockMatch(matchId);
        oracle.fulfill(requestId, randomness);
        seed = escrow.getMatch(matchId).seed;
    }

    function _signResult(
        uint256[] memory pks,
        bytes32 matchId,
        uint32 rounds,
        bytes32 historyRoot,
        address[] memory ranking
    ) internal view returns (bytes memory signatures) {
        bytes32 structHash = harness.hashMatchResult(matchId, rounds, historyRoot, ranking);
        bytes32 digest = harness.toTypedDataHash(escrow.domainSeparator(), structHash);
        signatures = Attest.signAscending(pks, digest);
    }

    function _twoAttestors() internal pure returns (uint256[] memory pks) {
        pks = new uint256[](2);
        pks[0] = ATTESTOR_PK_A;
        pks[1] = ATTESTOR_PK_B;
    }

    function _rankingOf(bytes32 matchId) internal view returns (address[] memory ranking) {
        return escrow.getSeats(matchId);
    }
}
