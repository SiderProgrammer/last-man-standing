// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title HashLib
/// @notice Byte-identical Solidity mirror of `@lms/protocol` hashing.
/// @dev Every function uses `abi.encode` (or equivalent Yul) so a verifier
///      can recompute a history root independently of the TypeScript engine.
///      Changing the encodings here is a consensus break and must be mirrored
///      in `packages/protocol/src/game/hash.ts`.
library HashLib {
    uint256 internal constant BPS_DENOMINATOR = 10_000;
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
    ///      was dead or did not reveal.
    function hashRound(
        uint32 round,
        uint8[] memory actions,
        uint8[] memory targets,
        bytes32[] memory salts,
        uint32[] memory hpAfter,
        uint8[] memory eliminated
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(round, actions, targets, salts, hpAfter, eliminated));
    }

    function historySeed(bytes32 matchId, bytes32 rulesHash, bytes32 seed) internal pure returns (bytes32) {
        return keccak256(abi.encode(matchId, rulesHash, seed));
    }

    /// @dev Tiny hot path: two words, no ABI encoder.
    function chainHistory(bytes32 previous, bytes32 roundHash) internal pure returns (bytes32 digest) {
        assembly ("memory-safe") {
            let buffer := mload(0x40)
            mstore(buffer, previous)
            mstore(add(buffer, 0x20), roundHash)
            digest := keccak256(buffer, 0x40)
        }
    }

    /// @dev Entropy for one round's rolls. Same encoding as `roundSeed` in TS.
    function roundSeed(bytes32 seed, uint32 round, bytes32[] memory salts) internal pure returns (bytes32) {
        return keccak256(abi.encode(seed, round, salts));
    }

    /// @dev 256-bit draw from a round seed. Same encoding as `draw` in TS.
    function draw(bytes32 seedOfRound, uint32 nonce) internal pure returns (uint256 value) {
        assembly ("memory-safe") {
            let buffer := mload(0x40)
            mstore(buffer, seedOfRound)
            mstore(add(buffer, 0x20), and(nonce, 0xffffffff))
            value := keccak256(buffer, 0x40)
        }
    }

    /// @dev Draw in `[0, 10000)`. Same encoding as `drawBps` in TS.
    function drawBps(bytes32 seedOfRound, uint32 nonce) internal pure returns (uint256) {
        return draw(seedOfRound, nonce) % BPS_DENOMINATOR;
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
