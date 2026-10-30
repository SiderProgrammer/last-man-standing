// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {SettlementLib} from "../../src/libraries/SettlementLib.sol";
import {SettlementHarness} from "../helpers/SettlementHarness.sol";

contract SettlementLibTest is Test {
    SettlementHarness internal harness;

    function setUp() public {
        harness = new SettlementHarness();
    }

    function test_typehashMatchesString() public pure {
        bytes32 expected = keccak256(
            "MatchResult(bytes32 matchId,uint32 rounds,bytes32 historyRoot,bytes32 transcriptHash,address[] ranking)"
        );
        assertEq(expected, SettlementLib.MATCH_RESULT_TYPEHASH);
    }

    /// @dev EIP-712 encodes an `address[]` member as the hash of its elements,
    ///      each padded to 32 bytes, written out here word by word.
    function test_hashMatchResultFollowsEip712() public view {
        address[] memory ranking = new address[](3);
        ranking[0] = address(0x1);
        ranking[1] = address(0x2);
        ranking[2] = address(0x3);

        bytes32 rankingHash =
            keccak256(abi.encode(bytes32(uint256(0x1)), bytes32(uint256(0x2)), bytes32(uint256(0x3))));
        bytes32 expected = keccak256(
            abi.encode(
                SettlementLib.MATCH_RESULT_TYPEHASH,
                bytes32(uint256(1)),
                uint32(9),
                bytes32(uint256(2)),
                bytes32(uint256(3)),
                rankingHash
            )
        );
        assertEq(
            harness.hashMatchResult(
                bytes32(uint256(1)), 9, bytes32(uint256(2)), bytes32(uint256(3)), ranking
            ),
            expected
        );
    }

    /// @dev Bits set above an address in calldata are cleaned when the
    ///      ranking is copied to memory, so the same ranking cannot be signed
    ///      under two different digests.
    function test_dirtyRankingCalldataHashesClean() public view {
        address[] memory ranking = new address[](1);
        ranking[0] = address(0xA11CE);
        bytes memory data =
            abi.encodeCall(harness.hashMatchResult, (bytes32(0), uint32(1), bytes32(0), bytes32(0), ranking));
        // The one element is the last word of the calldata.
        data[data.length - 32 + 11] = 0xAA;

        (bool ok, bytes memory result) = address(harness).staticcall(data);
        assertTrue(ok);
        assertEq(
            abi.decode(result, (bytes32)),
            harness.hashMatchResult(bytes32(0), 1, bytes32(0), bytes32(0), ranking)
        );
    }
}
