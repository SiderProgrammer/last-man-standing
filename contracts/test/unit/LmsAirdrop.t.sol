// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {LmsToken} from "../../src/governance/LmsToken.sol";
import {StakedLms} from "../../src/governance/StakedLms.sol";
import {LmsAirdrop} from "../../src/governance/LmsAirdrop.sol";

/// @dev The tree here is a frozen vector produced by `buildAirdrop` in
///      `packages/protocol/src/chain/airdrop.ts`, and pinned on that side by
///      `packages/protocol/test/airdrop.test.ts`. If the two hashings ever
///      diverge, exactly one of the suites fails instead of every claim.
contract LmsAirdropTest is Test {
    address private constant A1 = 0x00000000000000000000000000000000000000A1;
    address private constant A2 = 0x00000000000000000000000000000000000000A2;
    address private constant A3 = 0x00000000000000000000000000000000000000A3;
    uint256 private constant AMOUNT_A1 = 100e18;
    uint256 private constant AMOUNT_A2 = 250e18;
    uint256 private constant AMOUNT_A3 = 7;
    uint256 private constant TOTAL = AMOUNT_A1 + AMOUNT_A2 + AMOUNT_A3;
    bytes32 private constant ROOT = 0xc8142836db2816d597956a59efe05a50fcaa3545f8329a2bb31edccc4981ef43;

    address private treasury;
    LmsToken private lms;
    StakedLms private vault;
    LmsAirdrop private airdrop;
    uint64 private deadline;

    function setUp() public {
        treasury = makeAddr("treasury");
        lms = new LmsToken(address(this), 1_000_000e18);
        vault = new StakedLms(lms, makeAddr("owner"), 7 days);
        deadline = uint64(block.timestamp + 90 days);
        airdrop = new LmsAirdrop(lms, vault, ROOT, deadline, treasury);
        lms.transfer(address(airdrop), TOTAL);
    }

    // --- The frozen vector ------------------------------------------------

    function test_vector_everyProofFromTheTypeScriptTreeVerifies() public view {
        assertTrue(airdrop.verify(A1, AMOUNT_A1, _proofA1()));
        assertTrue(airdrop.verify(A2, AMOUNT_A2, _proofA2()));
        assertTrue(airdrop.verify(A3, AMOUNT_A3, _proofA3()));
    }

    function test_vector_wrongAmountOrAccountFails() public view {
        assertFalse(airdrop.verify(A1, AMOUNT_A1 + 1, _proofA1()));
        assertFalse(airdrop.verify(A2, AMOUNT_A2, _proofA1()));
    }

    // --- claim -------------------------------------------------------------

    function test_claim_paysTheAccount_whoeverSubmitsIt() public {
        vm.prank(makeAddr("relayer"));
        airdrop.claim(A2, AMOUNT_A2, _proofA2());

        assertEq(lms.balanceOf(A2), AMOUNT_A2);
        assertTrue(airdrop.claimed(A2));
    }

    function test_claim_onlyOnce() public {
        airdrop.claim(A1, AMOUNT_A1, _proofA1());
        vm.expectRevert(abi.encodeWithSelector(LmsAirdrop.AlreadyClaimed.selector, A1));
        airdrop.claim(A1, AMOUNT_A1, _proofA1());
    }

    function test_claim_rejectsABadProof() public {
        vm.expectRevert(LmsAirdrop.InvalidProof.selector);
        airdrop.claim(A1, AMOUNT_A1 * 2, _proofA1());
    }

    function test_claimAndStake_stakesForTheCaller() public {
        vm.prank(A2);
        uint256 shares = airdrop.claimAndStake(AMOUNT_A2, _proofA2());

        assertEq(shares, AMOUNT_A2, "empty vault: one share per LMS");
        assertEq(vault.balanceOf(A2), shares);
        assertEq(vault.getVotes(A2), shares, "staked, so it votes");
        assertEq(lms.balanceOf(A2), 0);
        assertTrue(airdrop.claimed(A2));
    }

    function test_claimAndStake_cannotClaimSomeoneElses() public {
        vm.prank(A3);
        vm.expectRevert(LmsAirdrop.InvalidProof.selector);
        airdrop.claimAndStake(AMOUNT_A2, _proofA2());
    }

    // --- The window ----------------------------------------------------------

    function test_claimWindow_closesAtTheDeadline() public {
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(LmsAirdrop.ClaimWindowClosed.selector, deadline));
        airdrop.claim(A1, AMOUNT_A1, _proofA1());
    }

    function test_sweep_onlyAfterTheDeadline_andOnlyToTheTreasury() public {
        airdrop.claim(A1, AMOUNT_A1, _proofA1());

        vm.expectRevert(abi.encodeWithSelector(LmsAirdrop.ClaimWindowOpen.selector, deadline));
        airdrop.sweep();

        vm.warp(deadline + 1);
        vm.prank(makeAddr("anyone"));
        uint256 swept = airdrop.sweep();

        assertEq(swept, AMOUNT_A2 + AMOUNT_A3);
        assertEq(lms.balanceOf(treasury), swept);
        assertEq(lms.balanceOf(address(airdrop)), 0);
    }

    function test_constructor_rejectsAPastDeadline() public {
        vm.expectRevert(abi.encodeWithSelector(LmsAirdrop.DeadlineInPast.selector, uint64(block.timestamp)));
        new LmsAirdrop(lms, vault, ROOT, uint64(block.timestamp), treasury);
    }

    // --- helpers ----------------------------------------------------------------

    function _proofA1() private pure returns (bytes32[] memory proof) {
        proof = new bytes32[](1);
        proof[0] = 0x2621105fb1c8fca9e58a40d3418d97e09803c789114402bcffce8ceeb805ae2b;
    }

    function _proofA2() private pure returns (bytes32[] memory proof) {
        proof = new bytes32[](2);
        proof[0] = 0x19572aa26ce69828973e452e5ee39c259d93cad30255572895434c6e7363986f;
        proof[1] = 0xdc4d1c8173ca92c9c67fae7074e9f5c3569dd410fc89cbd1e0a651ad4f0e03cf;
    }

    function _proofA3() private pure returns (bytes32[] memory proof) {
        proof = new bytes32[](2);
        proof[0] = 0x9108e17940ccc4830815f60b22d8b87bf912498e086c4ac54a07d54ecc7a6016;
        proof[1] = 0xdc4d1c8173ca92c9c67fae7074e9f5c3569dd410fc89cbd1e0a651ad4f0e03cf;
    }
}
