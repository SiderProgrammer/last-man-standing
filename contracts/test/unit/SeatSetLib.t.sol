// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {SeatSetLib} from "../../src/libraries/SeatSetLib.sol";
import {SettlementHarness} from "../helpers/SettlementHarness.sol";

contract SeatSetLibTest is Test {
    SettlementHarness internal harness;

    function setUp() public {
        harness = new SettlementHarness();
    }

    function test_acceptsPermutation() public {
        address[] memory seats = _seats();
        address[] memory ranking = new address[](4);
        ranking[0] = seats[3];
        ranking[1] = seats[0];
        ranking[2] = seats[2];
        ranking[3] = seats[1];
        harness.assertPermutation(seats, ranking);
    }

    function test_rejectsLengthMismatch() public {
        address[] memory seats = _seats();
        address[] memory ranking = new address[](3);
        ranking[0] = seats[0];
        ranking[1] = seats[1];
        ranking[2] = seats[2];
        vm.expectRevert(SeatSetLib.NotAPermutation.selector);
        harness.assertPermutation(seats, ranking);
    }

    function test_rejectsDuplicateAndStranger() public {
        address[] memory seats = _seats();
        address[] memory dup = new address[](4);
        dup[0] = seats[0];
        dup[1] = seats[1];
        dup[2] = seats[2];
        dup[3] = seats[0];
        vm.expectRevert(SeatSetLib.NotAPermutation.selector);
        harness.assertPermutation(seats, dup);

        address[] memory stranger = new address[](4);
        stranger[0] = seats[0];
        stranger[1] = seats[1];
        stranger[2] = seats[2];
        stranger[3] = address(0xBEEF);
        vm.expectRevert(SeatSetLib.NotAPermutation.selector);
        harness.assertPermutation(seats, stranger);
    }

    function test_secondCallInSameTransactionStartsClean() public {
        address[] memory seats = _seats();
        harness.assertPermutation(seats, seats);
        harness.assertPermutation(seats, seats);
    }

    function _seats() internal pure returns (address[] memory seats) {
        seats = new address[](4);
        seats[0] = address(0x1);
        seats[1] = address(0x2);
        seats[2] = address(0x3);
        seats[3] = address(0x4);
    }
}
