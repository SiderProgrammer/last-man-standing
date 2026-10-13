// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HashLib} from "./libraries/HashLib.sol";
import {KernelLib} from "./libraries/KernelLib.sol";

/// @title MatchVerifier
/// @notice Re-derives a whole match from its published rounds, on-chain.
///
/// @dev The attestors sign a history root. That root commits to every round's
///      actions, targets, salts, HP and eliminations, so the published round
///      records are the root's preimage and nobody can substitute others.
///      `GameEscrow.settle` refuses a result unless its rounds are published
///      alongside it and hash to the signed root (`rootOf`) — so the rounds are
///      always on-chain, in the settlement's calldata, for anyone to challenge
///      with. Given them, `verify` checks what the root does not prove by
///      itself: that every round is what the kernel resolves those inputs to,
///      that the match ended exactly when the rules say it ends, and — by
///      returning the ranking the rounds imply — that the ranking the escrow
///      was asked to pay out is the right one.
///
///      The log travels as `abi.encode(KernelLib.Round[])` bytes, so the escrow
///      only ever forwards it and never has to decode it.
///
///      Stateless and separate from the escrow on purpose: the replay is the
///      largest piece of code in the protocol, and the escrow stays small.
///
///      What it cannot catch: a quorum inventing a player's *move*. The
///      published salt has to open the player's commitment, but commitments
///      are exchanged off-chain, so a forged move that is replayed faithfully
///      is indistinguishable here. Everything downstream of the moves — every
///      roll, every hit, every elimination, the ranking — is enforced.
contract MatchVerifier {
    enum Verdict {
        /// @dev The rounds resolve, end and rank exactly as signed.
        Valid,
        /// @dev The rounds supplied are not the ones the root commits to. The
        ///      challenger's mistake, not the attestors': no fraud is shown.
        NotTheSignedRounds,
        /// @dev A round is not what its inputs resolve to.
        InvalidRound,
        /// @dev The match was cut short, or ran past its end.
        WrongEnding
    }

    /// @notice The history root and round count a log commits to.
    /// @param log `abi.encode(KernelLib.Round[])`, round 1 first.
    function rootOf(bytes32 matchId, bytes32 rulesHash, bytes32 seed, bytes calldata log)
        external
        pure
        returns (bytes32 root, uint256 rounds)
    {
        KernelLib.Round[] memory decoded = abi.decode(log, (KernelLib.Round[]));
        return (_root(matchId, rulesHash, seed, decoded), decoded.length);
    }

    /// @param seats Seats in the match, in seat order.
    /// @param log `abi.encode(KernelLib.Round[])`, round 1 first.
    /// @return verdict Whether the match checks out.
    /// @return badRound 1-based round that failed, for `InvalidRound` and `WrongEnding`.
    /// @return ranking Seat indices best-first, as the rounds imply. Only meaningful when `Valid`.
    /// @return rounds Rounds in the log.
    function verify(
        HashLib.Rules calldata rules,
        bytes32 matchId,
        bytes32 seed,
        uint256 seats,
        bytes32 historyRoot,
        bytes calldata log
    ) external pure returns (Verdict verdict, uint256 badRound, uint8[] memory ranking, uint256 rounds) {
        HashLib.Rules memory copy = rules;
        KernelLib.Round[] memory decoded = abi.decode(log, (KernelLib.Round[]));
        rounds = decoded.length;
        if (rounds == 0 || _root(matchId, HashLib.hashRules(copy), seed, decoded) != historyRoot) {
            return (Verdict.NotTheSignedRounds, 0, ranking, rounds);
        }
        (verdict, badRound, ranking) = _replay(copy, seed, seats, decoded);
    }

    /// @dev Walks the rounds in order, each from the HP the last one left.
    function _replay(HashLib.Rules memory rules, bytes32 seed, uint256 seats, KernelLib.Round[] memory rounds)
        private
        pure
        returns (Verdict, uint256, uint8[] memory ranking)
    {
        uint32[] memory hp = new uint32[](seats);
        for (uint256 i = 0; i < seats; ++i) {
            hp[i] = rules.startingHp;
        }

        // Every seat is eliminated at most once, so this never overflows.
        uint8[] memory fallen = new uint8[](seats);
        uint256 fallenCount;

        for (uint256 r = 0; r < rounds.length; ++r) {
            KernelLib.Round memory data = rounds[r];
            // forge-lint: disable-next-line(unsafe-typecast)
            uint32 round = uint32(r + 1);
            if (!KernelLib.isValidRound(rules, seed, round, hp, data)) return (Verdict.InvalidRound, round, ranking);

            hp = data.hpAfter;
            for (uint256 k = 0; k < data.eliminated.length; ++k) {
                fallen[fallenCount++] = data.eliminated[k];
            }
            // The match ends the round one seat is left or the round cap is
            // reached, and not a round earlier or later.
            bool over = _survivors(hp) <= 1 || round >= rules.maxRounds;
            if (over != (r + 1 == rounds.length)) return (Verdict.WrongEnding, round, ranking);
        }

        return (Verdict.Valid, 0, _ranking(hp, fallen, fallenCount));
    }

    function _root(bytes32 matchId, bytes32 rulesHash, bytes32 seed, KernelLib.Round[] memory rounds)
        private
        pure
        returns (bytes32 root)
    {
        root = HashLib.historySeed(matchId, rulesHash, seed);
        for (uint256 r = 0; r < rounds.length; ++r) {
            // forge-lint: disable-next-line(unsafe-typecast)
            root = HashLib.chainHistory(root, KernelLib.hashRound(uint32(r + 1), rounds[r]));
        }
    }

    function _survivors(uint32[] memory hp) private pure returns (uint256 count) {
        for (uint256 i = 0; i < hp.length; ++i) {
            if (hp[i] > 0) ++count;
        }
    }

    /// @dev Survivors by HP, highest first, lower seat on a tie; then everyone
    ///      else in reverse elimination order. Same rule as `Match.ranking`.
    function _ranking(uint32[] memory hp, uint8[] memory fallen, uint256 fallenCount)
        private
        pure
        returns (uint8[] memory ranking)
    {
        ranking = new uint8[](hp.length);
        uint256 filled;
        for (uint256 i = 0; i < hp.length; ++i) {
            if (hp[i] == 0) continue;
            uint256 j = filled;
            while (j > 0 && hp[ranking[j - 1]] < hp[i]) {
                ranking[j] = ranking[j - 1];
                --j;
            }
            // forge-lint: disable-next-line(unsafe-typecast)
            ranking[j] = uint8(i);
            ++filled;
        }
        for (uint256 k = fallenCount; k > 0; --k) {
            ranking[filled++] = fallen[k - 1];
        }
    }
}
