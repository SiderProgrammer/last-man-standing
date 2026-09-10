// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title HashLib
/// @notice Byte-identical Solidity mirror of `@lms/protocol` hashing.
/// @dev Every function uses `abi.encode` (or equivalent Yul) so a verifier
///      can recompute a history root independently of the TypeScript engine.
///      Changing the encodings here is a consensus break and must be mirrored
///      in `packages/protocol/src/hash.ts`.
library HashLib {
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint8 internal constant ACTION_ATTACK = 1;

    function commitMove(
        bytes32 matchId,
        uint32 round,
        uint8 seat,
        uint8 action,
        uint8 target,
        bytes32 salt
    ) internal pure returns (bytes32) {
        if (action != ACTION_ATTACK) target = 0;
        return keccak256(abi.encode(matchId, round, seat, action, target, salt));
    }

    function hashRound(
        uint32 round,
        uint8[] memory actions,
        uint8[] memory targets,
        uint32[] memory hpAfter,
        uint8[] memory eliminated
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(round, actions, targets, hpAfter, eliminated));
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

    /// @dev Deterministic draw in `[0, 10000)`. Same encoding as `drawBps` in TS.
    function drawBps(bytes32 seed, uint32 round, uint32 nonce) internal pure returns (uint256 roll) {
        assembly ("memory-safe") {
            let buffer := mload(0x40)
            mstore(buffer, seed)
            mstore(add(buffer, 0x20), and(round, 0xffffffff))
            mstore(add(buffer, 0x40), and(nonce, 0xffffffff))
            roll := mod(keccak256(buffer, 0x60), BPS_DENOMINATOR)
        }
    }

    function deriveMatchId(uint256 chainId, address escrow, uint256 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(chainId, escrow, nonce));
    }

    function hashRules(
        uint16 minPlayers,
        uint16 maxPlayers,
        uint32 startingHp,
        uint32 attackDamage,
        uint32 riposteDamage,
        uint16 hideEvadeBps,
        uint16 timeoutEvadeBps,
        uint16 hideStormBps,
        uint16 stormGraceRounds,
        uint32 stormBaseDamage,
        uint16 maxRounds
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                minPlayers,
                maxPlayers,
                startingHp,
                attackDamage,
                riposteDamage,
                hideEvadeBps,
                timeoutEvadeBps,
                hideStormBps,
                stormGraceRounds,
                stormBaseDamage,
                maxRounds
            )
        );
    }
}
