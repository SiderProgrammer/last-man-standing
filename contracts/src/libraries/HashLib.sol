// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title HashLib
/// @notice Byte-identical Solidity mirror of `@lms/protocol` hashing.
/// @dev Every function uses `abi.encode` so a verifier
///      can recompute a history root independently of the TypeScript engine.
///      Changing the encodings here is a consensus break and must be mirrored
///      in `packages/protocol/src/game/hash.ts`.
library HashLib {
    uint8 internal constant ACTION_STRIKE = 1;

    /// @dev Field order is the hash order: `abi.encode` of this all-static
    ///      struct is byte-identical to encoding the fields one by one, which is
    ///      what `hashRules` in TypeScript does.
    struct Rules {
        uint16 minPlayers;
        uint16 maxPlayers;
        uint32 startingHp;
        uint32 strikeDamage;
        uint16 strikeHealBps;
        uint32 guardReflectDamage;
        uint32 chargeBonusDamage;
        uint16 chargeExposureBps;
        uint16 stallGraceRounds;
        uint32 stallDamage;
        uint16 maxRounds;
    }

    function commitMove(bytes32 matchId, uint32 round, uint8 seat, uint8 action, uint8 target, bytes32 salt)
        internal
        pure
        returns (bytes32)
    {
        if (action != ACTION_STRIKE) target = 0;
        return keccak256(abi.encode(matchId, round, seat, action, target, salt));
    }

    /// @dev Everything is indexed by seat. `salts` holds zero for a seat that
    ///      was dead or did not reveal, `commitments` zero for one that was
    ///      dead or did not commit.
    function hashRound(
        uint32 round,
        uint8[] memory actions,
        uint8[] memory targets,
        bytes32[] memory salts,
        bytes32[] memory commitments,
        uint32[] memory hpAfter,
        uint8[] memory eliminated
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(round, actions, targets, salts, commitments, hpAfter, eliminated));
    }

    function historySeed(bytes32 matchId, bytes32 rulesHash, bytes32 seed) internal pure returns (bytes32) {
        return keccak256(abi.encode(matchId, rulesHash, seed));
    }

    /// @dev Digest of a round's commitments, in seat order with zero for a
    ///      seat that sealed none. Same encoding as `commitmentSetHash` in TS.
    function commitmentSetHash(bytes32[] memory commitments) internal pure returns (bytes32) {
        return keccak256(abi.encode(commitments));
    }

    /// @dev Entropy for one round's rolls, fixed when the commit window
    ///      closes. Same encoding as `roundSeed` in TS.
    function roundSeed(bytes32 seed, uint32 round, bytes32 commitmentSet) internal pure returns (bytes32) {
        return keccak256(abi.encode(seed, round, commitmentSet));
    }

    function deriveMatchId(uint256 chainId, address escrow, uint256 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(chainId, escrow, nonce));
    }

    function hashRules(Rules memory rules) internal pure returns (bytes32) {
        return keccak256(abi.encode(rules));
    }

    /// @notice The rule set `DEFAULT_RULES` in `@lms/protocol` describes.
    /// @dev Pinned to the TypeScript copy twice over: `HashLib.t.sol` asserts its
    ///      hash against the frozen vector `parity.test.ts` also asserts, and
    ///      `contracts/config/rules.json`, which `Deploy` reads, is checked
    ///      field by field against `DEFAULT_RULES`.
    function defaultRules() internal pure returns (Rules memory) {
        return Rules({
            minPlayers: 4,
            maxPlayers: 8,
            startingHp: 100,
            strikeDamage: 25,
            strikeHealBps: 5000,
            guardReflectDamage: 34,
            chargeBonusDamage: 34,
            chargeExposureBps: 2500,
            stallGraceRounds: 2,
            stallDamage: 8,
            maxRounds: 30
        });
    }
}
