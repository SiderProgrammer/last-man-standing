// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {ProtocolConfig} from "../../src/ProtocolConfig.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {MatchMarket} from "../../src/MatchMarket.sol";
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
    MatchMarket internal market;
    MockRandomnessOracle internal oracle;
    MockMessenger internal messenger;
    SettlementHarness internal harness;

    uint128 internal constant STAKE = 1 ether;

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
        vm.stopPrank();

        escrow = new GameEscrow(config);
        market = new MatchMarket(escrow);

        vm.prank(owner);
        config.setRemoteChain(421_614, address(messenger), bytes32(uint256(uint160(address(0xBEEF)))));
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
