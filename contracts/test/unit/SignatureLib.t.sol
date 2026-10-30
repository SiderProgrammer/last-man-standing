// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {SignatureLib} from "../../src/libraries/SignatureLib.sol";
import {SettlementHarness} from "../helpers/SettlementHarness.sol";

contract SignatureLibTest is Test {
    SettlementHarness internal harness;
    bytes32 internal digest;

    uint256 internal pkA = 0xA11CE;
    uint256 internal pkB = 0xB0B;

    function setUp() public {
        harness = new SettlementHarness();
        digest = keccak256("result");
    }

    function test_recoversAscendingPair() public view {
        address a = vm.addr(pkA);
        address b = vm.addr(pkB);
        (uint256 firstPk, uint256 secondPk) = a < b ? (pkA, pkB) : (pkB, pkA);

        bytes memory blob = bytes.concat(_sig(firstPk), _sig(secondPk));
        address[] memory signers = harness.recover(digest, blob);
        assertEq(signers.length, 2);
        assertEq(signers[0], vm.addr(firstPk));
        assertEq(signers[1], vm.addr(secondPk));
        assertTrue(signers[0] < signers[1]);
    }

    function test_rejectsUnsortedAndDuplicates() public {
        address a = vm.addr(pkA);
        address b = vm.addr(pkB);
        bytes memory unsorted =
            a < b ? bytes.concat(_sig(pkB), _sig(pkA)) : bytes.concat(_sig(pkA), _sig(pkB));
        vm.expectRevert(SignatureLib.UnsortedSigners.selector);
        harness.recover(digest, unsorted);

        bytes memory dup = bytes.concat(_sig(pkA), _sig(pkA));
        vm.expectRevert(SignatureLib.UnsortedSigners.selector);
        harness.recover(digest, dup);
    }

    function test_rejectsMalformedAndBadV() public {
        vm.expectRevert(SignatureLib.MalformedSignatureBlob.selector);
        harness.recover(digest, hex"01");

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pkA, digest);
        v = 26;
        bytes memory badV = abi.encodePacked(r, s, v);
        vm.expectRevert(ECDSA.ECDSAInvalidSignature.selector);
        harness.recover(digest, badV);
    }

    function test_rejectsMalleableS() public {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pkA, digest);
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 highS = bytes32(n - uint256(s));
        uint8 flipV = v == 27 ? 28 : 27;
        bytes memory malleable = abi.encodePacked(r, highS, flipV);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, highS));
        harness.recover(digest, malleable);
    }

    function _sig(uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
