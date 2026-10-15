// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {MatchVerifier} from "../../src/MatchVerifier.sol";
import {HashLib} from "../../src/libraries/HashLib.sol";
import {KernelLib} from "../../src/libraries/KernelLib.sol";

/// @dev Replays matches the TypeScript engine played — written to
///      `test/vectors/matches.json` by `packages/engine/test/vectors.test.ts` —
///      through the Solidity kernel. Every honest match must verify with the
///      same ranking; every kind of tampering must be caught as the right kind.
contract MatchVerifierTest is Test {
    struct Case {
        HashLib.Rules rules;
        bytes32 matchId;
        bytes32 seed;
        uint256 seats;
        bytes32 root;
        KernelLib.Round[] rounds;
        uint8[] ranking;
    }

    MatchVerifier internal verifier;
    string internal json;

    function setUp() public {
        verifier = new MatchVerifier();
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/matches.json"));
    }

    function _count() internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(".cases[", vm.toString(n), "].data"))) ++n;
    }

    function _case(uint256 i) internal view returns (Case memory c) {
        bytes memory data = vm.parseJsonBytes(json, string.concat(".cases[", vm.toString(i), "].data"));
        (c.rules, c.matchId, c.seed, c.seats, c.root, c.rounds, c.ranking) = abi.decode(
            data, (HashLib.Rules, bytes32, bytes32, uint256, bytes32, KernelLib.Round[], uint8[])
        );
    }

    function _verify(Case memory c, bytes32 root)
        internal
        view
        returns (MatchVerifier.Verdict verdict, uint256 badRound, uint8[] memory ranking)
    {
        (verdict, badRound, ranking,) = verifier.verify(c.rules, c.matchId, c.seed, c.seats, root, abi.encode(c.rounds));
    }

    /// @dev The root a quorum would have to sign for these (possibly doctored) rounds.
    function _rootOf(Case memory c) internal pure returns (bytes32 root) {
        root = HashLib.historySeed(c.matchId, HashLib.hashRules(c.rules), c.seed);
        for (uint256 r = 0; r < c.rounds.length; ++r) {
            // forge-lint: disable-next-line(unsafe-typecast)
            root = HashLib.chainHistory(root, KernelLib.hashRound(uint32(r + 1), c.rounds[r]));
        }
    }

    function test_everyEngineMatchVerifiesWithTheEnginesRanking() public view {
        uint256 n = _count();
        assertGt(n, 8, "vectors missing");
        for (uint256 i = 0; i < n; ++i) {
            Case memory c = _case(i);
            (MatchVerifier.Verdict verdict,, uint8[] memory ranking) = _verify(c, c.root);
            assertEq(uint8(verdict), uint8(MatchVerifier.Verdict.Valid), vm.toString(i));
            assertEq(abi.encode(ranking), abi.encode(c.ranking), vm.toString(i));
            // The bytes the server's relayer sends to `settle`, as TypeScript encoded them.
            bytes memory log = vm.parseJsonBytes(json, string.concat(".cases[", vm.toString(i), "].log"));
            assertEq(log, abi.encode(c.rounds));
            (bytes32 root, uint256 rounds) = verifier.rootOf(c.matchId, HashLib.hashRules(c.rules), c.seed, log);
            assertEq(root, c.root);
            assertEq(rounds, c.rounds.length);
        }
    }

    function test_roundsThatAreNotTheSignedOnesProveNothing() public view {
        Case memory c = _case(0);
        c.rounds[0].hpAfter[0] += 1;
        (MatchVerifier.Verdict verdict,,) = _verify(c, c.root);
        assertEq(uint8(verdict), uint8(MatchVerifier.Verdict.NotTheSignedRounds));
    }

    /// @dev A quorum signs a root over a round whose outcome was doctored.
    function test_catchesASignedRoundWithTheWrongOutcome() public view {
        for (uint256 i = 0; i < _count(); ++i) {
            Case memory c = _case(i);
            uint256 r = c.rounds.length / 2;
            KernelLib.Round memory doctored = c.rounds[r];
            // Give the first living seat a little more HP than it earned.
            for (uint256 s = 0; s < c.seats; ++s) {
                if (doctored.hpAfter[s] > 0) {
                    doctored.hpAfter[s] += 1;
                    break;
                }
            }
            (MatchVerifier.Verdict verdict, uint256 badRound,) = _verify(c, _rootOf(c));
            assertEq(uint8(verdict), uint8(MatchVerifier.Verdict.InvalidRound), vm.toString(i));
            assertEq(badRound, r + 1);
        }
    }

    /// @dev Swapping a silent seat's zero salt for another changes nothing the
    ///      engine would compute, but it is not a record the engine writes.
    function test_catchesANonCanonicalRecord() public view {
        Case memory c = _case(8); // all-silent-4
        c.rounds[0].salts[0] = keccak256("smuggled");
        (MatchVerifier.Verdict verdict, uint256 badRound,) = _verify(c, _rootOf(c));
        assertEq(uint8(verdict), uint8(MatchVerifier.Verdict.InvalidRound));
        assertEq(badRound, 1);
    }

    /// @dev Stopping the match a round early, to freeze a ranking.
    function test_catchesAMatchCutShort() public view {
        Case memory c = _case(2);
        assertGt(c.rounds.length, 1);
        KernelLib.Round[] memory shorter = new KernelLib.Round[](c.rounds.length - 1);
        for (uint256 r = 0; r < shorter.length; ++r) {
            shorter[r] = c.rounds[r];
        }
        c.rounds = shorter;
        (MatchVerifier.Verdict verdict, uint256 badRound,) = _verify(c, _rootOf(c));
        assertEq(uint8(verdict), uint8(MatchVerifier.Verdict.WrongEnding));
        assertEq(badRound, shorter.length);
    }

    /// @dev The worst case the escrow will pay to check: eight seats, every round.
    function test_gasOfTheLargestReplay() public {
        Case memory c = _case(2); // random-8
        uint256 before = gasleft();
        _verify(c, c.root);
        uint256 used = before - gasleft();
        emit log_named_uint("rounds", c.rounds.length);
        emit log_named_uint("replay gas", used);
        assertLt(used, 15_000_000);
    }
}
