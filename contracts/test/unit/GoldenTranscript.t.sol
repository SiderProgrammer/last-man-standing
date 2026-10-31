// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {HashLib} from "../../src/libraries/HashLib.sol";
import {SettlementLib} from "../../src/libraries/SettlementLib.sol";

/// @notice Rebuilds the frozen golden transcripts' round hashes and history
///         roots in Solidity, from the same files the TypeScript suite
///         replays (`packages/engine/test/golden.test.ts`).
/// @dev The files are written once by `scripts/gen-golden.mjs`. Each round
///      is read as seat-indexed arrays (`.chain.rounds[i]`), hashed with
///      `HashLib.hashRound`, and folded into the root the way `chainHistory`
///      in `packages/consensus` folds it. The digest the attestors would sign for
///      the four-seat match is pinned against `parity.test.ts`.
contract GoldenTranscriptTest is Test {
    /// @dev Same domain as `parity.test.ts`'s vector: Base Sepolia, a fixed escrow.
    uint256 private constant CHAIN_ID = 84_532;
    address private constant ESCROW = address(0xE5C0);

    function test_fourSeatsRebuildsItsRoot() public view {
        _rebuild("four-seats");
    }

    function test_eightSeatsRebuildsItsRoot() public view {
        _rebuild("eight-seats");
    }

    function test_resultDigestMatchesTypeScript() public view {
        string memory json = _load("four-seats");
        bytes32 structHash = SettlementLib.hashMatchResult(
            vm.parseJsonBytes32(json, ".transcript.matchId"),
            uint32(vm.parseJsonUint(json, ".transcript.result.rounds")),
            vm.parseJsonBytes32(json, ".transcript.result.historyRoot"),
            vm.parseJsonBytes32(json, ".transcriptHash"),
            vm.parseJsonAddressArray(json, ".transcript.result.ranking")
        );
        // OpenZeppelin `EIP712`'s domain separator, as the escrow builds it.
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("LastManStanding"),
                keccak256("1"),
                CHAIN_ID,
                ESCROW
            )
        );
        assertEq(
            MessageHashUtils.toTypedDataHash(domainSeparator, structHash),
            0x528978564a977acf0690f2ba7d70962cf87faeca405ebdd98290e32f54577255
        );
    }

    function _rebuild(string memory name) private view {
        string memory json = _load(name);
        bytes32 rulesHash = HashLib.hashRules(HashLib.defaultRules());
        assertEq(rulesHash, vm.parseJsonBytes32(json, ".chain.rulesHash"));

        bytes32 root = HashLib.historySeed(
            vm.parseJsonBytes32(json, ".transcript.matchId"),
            rulesHash,
            vm.parseJsonBytes32(json, ".transcript.seed")
        );
        assertEq(root, vm.parseJsonBytes32(json, ".chain.historySeed"));

        uint256 rounds = vm.parseJsonUint(json, ".chain.roundCount");
        assertEq(rounds, vm.parseJsonUint(json, ".transcript.result.rounds"));
        for (uint256 i = 0; i < rounds; ++i) {
            string memory at = string.concat(".chain.rounds[", vm.toString(i), "]");
            bytes32 roundHash = _roundHash(json, at);
            assertEq(roundHash, vm.parseJsonBytes32(json, string.concat(at, ".hash")));
            // `chainHistory` in `@lms/consensus`.
            root = keccak256(abi.encode(root, roundHash));
        }
        assertEq(root, vm.parseJsonBytes32(json, ".transcript.result.historyRoot"));
    }

    /// @dev One round, hashed from its seat-indexed arrays at `at`.
    function _roundHash(string memory json, string memory at) private pure returns (bytes32) {
        return HashLib.hashRound(
            uint32(vm.parseJsonUint(json, string.concat(at, ".round"))),
            _uint8s(vm.parseJsonUintArray(json, string.concat(at, ".actions"))),
            _uint8s(vm.parseJsonUintArray(json, string.concat(at, ".targets"))),
            vm.parseJsonBytes32Array(json, string.concat(at, ".salts")),
            vm.parseJsonBytes32Array(json, string.concat(at, ".commitments")),
            _uint32s(vm.parseJsonUintArray(json, string.concat(at, ".hpAfter"))),
            _uint8s(vm.parseJsonUintArray(json, string.concat(at, ".eliminated")))
        );
    }

    function _load(string memory name) private view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/golden/", name, ".json"));
    }

    function _uint8s(uint256[] memory values) private pure returns (uint8[] memory out) {
        out = new uint8[](values.length);
        for (uint256 i = 0; i < values.length; ++i) {
            out[i] = uint8(values[i]);
        }
    }

    function _uint32s(uint256[] memory values) private pure returns (uint32[] memory out) {
        out = new uint32[](values.length);
        for (uint256 i = 0; i < values.length; ++i) {
            out[i] = uint32(values[i]);
        }
    }
}
