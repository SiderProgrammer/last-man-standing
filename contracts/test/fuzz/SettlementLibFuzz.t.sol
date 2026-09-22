// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {SettlementLib} from "../../src/libraries/SettlementLib.sol";
import {SettlementHarness} from "../helpers/SettlementHarness.sol";
import {SettlementRef} from "../helpers/SettlementRef.sol";

contract SettlementLibFuzzTest is Test {
    SettlementHarness internal harness;

    function setUp() public {
        harness = new SettlementHarness();
    }

    function testFuzz_hashRankingMatchesReference(address[] memory ranking) public view {
        vm.assume(ranking.length < 48);
        assertEq(harness.hashRanking(ranking), SettlementRef.hashRanking(ranking));
    }

    function testFuzz_hashMatchResultMatchesReference(
        bytes32 matchId,
        uint32 rounds,
        bytes32 historyRoot,
        address[] memory ranking
    ) public view {
        vm.assume(ranking.length < 48);
        assertEq(
            harness.hashMatchResult(matchId, rounds, historyRoot, ranking),
            SettlementRef.hashMatchResult(matchId, rounds, historyRoot, ranking)
        );
    }

    function testFuzz_dirtyHighBitsDoNotChangeDigest(address a, address b, uint96 dirtA, uint96 dirtB) public view {
        address[] memory clean = new address[](2);
        clean[0] = a;
        clean[1] = b;
        bytes32 expected = SettlementRef.hashRanking(clean);

        bytes memory packed = abi.encodePacked(
            bytes32(uint256(uint160(a))) | (bytes32(uint256(dirtA)) << 160),
            bytes32(uint256(uint160(b))) | (bytes32(uint256(dirtB)) << 160)
        );
        assertEq(this.hashRankingRaw(packed), expected);
    }

    function hashRankingRaw(bytes calldata packed) external pure returns (bytes32) {
        address[] calldata ranking;
        assembly ("memory-safe") {
            ranking.offset := packed.offset
            ranking.length := 2
        }
        return SettlementLib.hashRanking(ranking);
    }
}
