// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {SignatureLib} from "../../src/libraries/SignatureLib.sol";
import {SettlementHarness} from "../helpers/SettlementHarness.sol";
import {Attest} from "../helpers/Attest.sol";

contract SignatureLibFuzzTest is Test {
    SettlementHarness internal harness;

    function setUp() public {
        harness = new SettlementHarness();
    }

    function testFuzz_recoversUniqueSortedSigners(bytes32 digest, uint256 pkA, uint256 pkB, uint256 pkC) public {
        pkA = _boundKey(pkA);
        pkB = _boundKey(pkB);
        pkC = _boundKey(pkC);
        vm.assume(pkA != pkB && pkB != pkC && pkA != pkC);

        uint256[] memory pks = new uint256[](3);
        pks[0] = pkA;
        pks[1] = pkB;
        pks[2] = pkC;
        _sort(pks);

        bytes memory blob;
        for (uint256 i = 0; i < 3; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pks[i], digest);
            blob = bytes.concat(blob, abi.encodePacked(r, s, v));
        }

        address[] memory signers = harness.recover(digest, blob);
        assertEq(signers.length, 3);
        assertEq(signers[0], vm.addr(pks[0]));
        assertEq(signers[1], vm.addr(pks[1]));
        assertEq(signers[2], vm.addr(pks[2]));
        assertTrue(signers[0] < signers[1] && signers[1] < signers[2]);
    }

    function testFuzz_rejectsUnsortedPair(bytes32 digest, uint256 pkA, uint256 pkB) public {
        pkA = _boundKey(pkA);
        pkB = _boundKey(pkB);
        vm.assume(pkA != pkB);
        vm.assume(vm.addr(pkA) != vm.addr(pkB));

        uint256 high = vm.addr(pkA) > vm.addr(pkB) ? pkA : pkB;
        uint256 low = high == pkA ? pkB : pkA;

        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(high, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(low, digest);
        bytes memory blob = bytes.concat(abi.encodePacked(r1, s1, v1), abi.encodePacked(r2, s2, v2));

        vm.expectRevert(SignatureLib.UnsortedSigners.selector);
        harness.recover(digest, blob);
    }

    function _boundKey(uint256 pk) internal pure returns (uint256) {
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        pk = bound(pk, 1, n - 1);
        return pk;
    }

    function _sort(uint256[] memory pks) internal view {
        Attest.sortByAddress(pks);
    }
}
