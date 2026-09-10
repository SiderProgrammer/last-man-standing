// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SeatSetLib
/// @notice Checks that a signed ranking is exactly the set of seats in a match.
/// @dev Settlement must reject a ranking that omits a player, repeats one, or
///      smuggles in an address that never staked — any of those would let a
///      compromised attestor quorum redirect the prize pool.
///
///      The obvious implementation is a nested loop, which is quadratic in the
///      lobby size and becomes the dominant cost of `settle` at the 256-seat
///      ceiling. This uses EIP-1153 transient storage as a scratch set for a
///      linear check instead. Transient slots are discarded at the end of the
///      transaction and are rolled back on revert, so nothing has to be
///      cleaned up on the failure path — but the happy path still clears every
///      mark it sets, so a second call in the same transaction starts clean.
library SeatSetLib {
    /// @notice The ranking is not a permutation of the match's seats.
    error NotAPermutation();

    /// @dev Namespace for the transient slots, to avoid colliding with any
    ///      other transient storage used in the same transaction.
    uint256 private constant SEAT_SET_NAMESPACE =
        uint256(keccak256("lms.seatset.transient.v1")) - 1;

    /// @param seats Seats of the match, in join order.
    /// @param ranking Signed finishing order, best first.
    function assertPermutation(address[] memory seats, address[] calldata ranking) internal {
        uint256 length = seats.length;
        if (length != ranking.length) revert NotAPermutation();

        uint256 namespace = SEAT_SET_NAMESPACE;

        assembly ("memory-safe") {
            // Mark every seat. Seats are unique by construction (`join` rejects
            // a repeat entry), so no duplicate check is needed here.
            let cursor := add(seats, 0x20)
            let end := add(cursor, shl(5, length))
            for {} lt(cursor, end) {cursor := add(cursor, 0x20)} {
                mstore(0x00, mload(cursor))
                mstore(0x20, namespace)
                tstore(keccak256(0x00, 0x40), 1)
            }
        }

        // Consume each mark exactly once. A repeated or unknown address finds
        // its slot already cleared and fails here.
        for (uint256 i = 0; i < length; ++i) {
            address candidate = ranking[i];
            bool ok;
            assembly ("memory-safe") {
                mstore(0x00, candidate)
                mstore(0x20, namespace)
                let slot := keccak256(0x00, 0x40)
                ok := tload(slot)
                tstore(slot, 0)
            }
            if (!ok) {
                _clear(seats, namespace);
                revert NotAPermutation();
            }
        }
    }

    /// @dev Only reachable on the revert path, where transient storage would be
    ///      rolled back anyway. Kept so the library stays correct if a caller
    ///      ever catches the revert instead of bubbling it.
    function _clear(address[] memory seats, uint256 namespace) private {
        uint256 length = seats.length;
        assembly ("memory-safe") {
            let cursor := add(seats, 0x20)
            let end := add(cursor, shl(5, length))
            for {} lt(cursor, end) {cursor := add(cursor, 0x20)} {
                mstore(0x00, mload(cursor))
                mstore(0x20, namespace)
                tstore(keccak256(0x00, 0x40), 0)
            }
        }
    }
}
