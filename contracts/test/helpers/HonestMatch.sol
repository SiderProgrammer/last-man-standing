// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HashLib} from "../../src/libraries/HashLib.sol";
import {KernelLib} from "../../src/libraries/KernelLib.sol";
import {MatchVerifier} from "../../src/MatchVerifier.sol";

/// @notice Plays a match on-chain with the Solidity kernel, for tests that need
///         a real round log for a match the escrow seeded.
/// @dev Seat `i` attacks seat `i + 1` on even seats and defends on odd ones,
///      so a log has hits, parries and eliminations before the storm closes
///      it out. Agreement with the TypeScript engine is not this helper's job:
///      `MatchVerifier.t.sol` checks that against vectors the engine produced.
library HonestMatch {
    struct Played {
        KernelLib.Round[] rounds;
        bytes32 root;
        uint8[] ranking;
    }

    function play(MatchVerifier verifier, bytes32 matchId, bytes32 seed, uint256 seats)
        internal
        pure
        returns (Played memory played)
    {
        HashLib.Rules memory rules = HashLib.defaultRules();
        KernelLib.Round[] memory rounds = new KernelLib.Round[](rules.maxRounds);
        uint32[] memory hp = new uint32[](seats);
        for (uint256 i = 0; i < seats; ++i) {
            hp[i] = rules.startingHp;
        }

        uint256 count;
        bytes32 root = HashLib.historySeed(matchId, HashLib.hashRules(rules), seed);
        for (uint32 round = 1; round <= rules.maxRounds; ++round) {
            KernelLib.Round memory data = _moves(hp, round);
            (data.hpAfter, data.eliminated) =
                KernelLib.resolve(rules, seed, round, hp, data.actions, data.targets, data.salts);
            rounds[count++] = data;
            root = HashLib.chainHistory(root, KernelLib.hashRound(round, data));
            hp = data.hpAfter;
            if (_survivors(hp) <= 1) break;
        }

        assembly ("memory-safe") {
            mstore(rounds, count)
        }
        played.rounds = rounds;
        played.root = root;
        (,, played.ranking,) =
            verifier.verify(rules, matchId, seed, seats, root, abi.encode(rounds));
    }

    function log(Played memory played) internal pure returns (bytes memory) {
        return abi.encode(played.rounds);
    }

    function _moves(uint32[] memory hp, uint32 round) private pure returns (KernelLib.Round memory data) {
        uint256 seats = hp.length;
        data.actions = new uint8[](seats);
        data.targets = new uint8[](seats);
        data.salts = new bytes32[](seats);
        for (uint256 i = 0; i < seats; ++i) {
            if (hp[i] == 0) continue;
            data.salts[i] = keccak256(abi.encode("salt", round, i));
            uint256 target = (i + 1) % seats;
            if (i % 2 == 0 && hp[target] != 0 && target != i) {
                data.actions[i] = KernelLib.ATTACK;
                // forge-lint: disable-next-line(unsafe-typecast)
                data.targets[i] = uint8(target);
            } else {
                data.actions[i] = KernelLib.DEFEND;
            }
        }
    }

    function _survivors(uint32[] memory hp) private pure returns (uint256 count) {
        for (uint256 i = 0; i < hp.length; ++i) {
            if (hp[i] > 0) ++count;
        }
    }
}
