// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {SettlementLib} from "../../src/libraries/SettlementLib.sol";
import {SettlementHarness} from "../helpers/SettlementHarness.sol";
import {SettlementRef} from "../helpers/SettlementRef.sol";

contract SettlementLibTest is Test {
    SettlementHarness internal harness;

    function setUp() public {
        harness = new SettlementHarness();
    }

    function test_typehashMatchesString() public pure {
        bytes32 expected =
            keccak256("MatchResult(bytes32 matchId,uint32 rounds,bytes32 historyRoot,address[] ranking)");
        assertEq(expected, SettlementLib.MATCH_RESULT_TYPEHASH);
    }

    function test_hashRankingMasksDirtyBits() public view {
        address a = address(0xA11CE);
        address b = address(0xB0B);

        address[] memory clean = new address[](2);
        clean[0] = a;
        clean[1] = b;

        bytes32 expected = SettlementRef.hashRanking(clean);

        address[] memory dirty = new address[](2);
        dirty[0] = a;
        dirty[1] = b;
        // Dirty the high bits in the calldata encoding by going through a crafted payload.
        bytes32 dirtyHash = _hashRankingDirty(a, b);
        assertEq(dirtyHash, expected);
        assertEq(harness.hashRanking(clean), expected);
    }

    function test_hashMatchResultMatchesReference() public view {
        address[] memory ranking = new address[](3);
        ranking[0] = address(0x1);
        ranking[1] = address(0x2);
        ranking[2] = address(0x3);

        bytes32 yul = harness.hashMatchResult(bytes32(uint256(1)), 9, bytes32(uint256(2)), ranking);
        bytes32 ref = SettlementRef.hashMatchResult(bytes32(uint256(1)), 9, bytes32(uint256(2)), ranking);
        assertEq(yul, ref);
    }

    function test_toTypedDataHashMatchesManual() public view {
        bytes32 domain = keccak256("domain");
        bytes32 structHash = keccak256("struct");
        bytes32 expected = keccak256(abi.encodePacked(hex"1901", domain, structHash));
        assertEq(harness.toTypedDataHash(domain, structHash), expected);
    }

    function _hashRankingDirty(address a, address b) internal view returns (bytes32) {
        bytes memory payload = abi.encodePacked(
            bytes32(uint256(uint160(a))) | (bytes32(uint256(0xAA)) << 160),
            bytes32(uint256(uint160(b))) | (bytes32(uint256(0xBB)) << 160)
        );
        return this.hashRankingRaw(payload);
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
