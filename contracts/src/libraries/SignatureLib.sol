// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SignatureLib
/// @notice Batch ECDSA recovery over a packed calldata blob, written in Yul.
/// @dev Every settlement verifies a quorum of attestor signatures, so this
///      loop runs `threshold` times per match. Doing it in Yul avoids copying
///      each 65-byte signature into a memory `bytes` and re-allocating the
///      `ecrecover` input for every iteration; a single scratch frame is
///      reused across the whole batch.
library SignatureLib {
    /// @notice Signature blob length is not a multiple of 65.
    error MalformedSignatureBlob();
    /// @notice `s` is in the upper half of the curve order.
    error MalleableSignature();
    /// @notice `v` was neither 27 nor 28.
    error InvalidRecoveryId();
    /// @notice `ecrecover` returned the zero address.
    error UnrecoverableSignature();
    /// @notice Signers were not in strictly ascending address order.
    error UnsortedSigners();

    uint256 private constant SIGNATURE_STRIDE = 65;

    /// @notice Recovers every signer in a packed `r ‖ s ‖ v` blob.
    /// @dev Signers must appear in strictly ascending address order. That single
    ///      rule does three jobs at once: it rejects duplicate signatures
    ///      (which would otherwise let one attestor satisfy a quorum on its
    ///      own), it makes the recovered set canonical, and it costs one
    ///      comparison instead of a membership structure.
    ///
    ///      `s` is constrained to the lower half of the curve order and `v` to
    ///      {27, 28}, so a signature cannot be replayed in its malleable form.
    /// @param digest EIP-712 digest that was signed.
    /// @param signatures Concatenated 65-byte signatures.
    /// @return signers Recovered addresses, in ascending order.
    function recoverAscending(bytes32 digest, bytes calldata signatures)
        internal
        view
        returns (address[] memory signers)
    {
        if (signatures.length % SIGNATURE_STRIDE != 0) revert MalformedSignatureBlob();

        // Bind selectors first: custom errors are not addressable from assembly.
        bytes4 malleableError = MalleableSignature.selector;
        bytes4 recoveryIdError = InvalidRecoveryId.selector;
        bytes4 unrecoverableError = UnrecoverableSignature.selector;
        bytes4 unsortedError = UnsortedSigners.selector;

        assembly ("memory-safe") {
            let count := div(signatures.length, 65)

            // Allocate the returned array.
            signers := mload(0x40)
            mstore(signers, count)
            let out := add(signers, 0x20)
            mstore(0x40, add(out, shl(5, count)))

            // Reusable `ecrecover` frame above the free memory pointer:
            // [digest, v, r, s] as input, one word after it for the output.
            let frame := mload(0x40)
            mstore(frame, digest)

            // secp256k1n / 2, the upper bound for a non-malleable `s`.
            let halfOrder := 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0

            let source := signatures.offset
            let previous := 0

            for { let i := 0 } lt(i, count) { i := add(i, 1) } {
                let r := calldataload(source)
                let s := calldataload(add(source, 0x20))
                let v := byte(0, calldataload(add(source, 0x40)))

                if gt(s, halfOrder) {
                    mstore(0x00, malleableError)
                    revert(0x00, 0x04)
                }
                if iszero(or(eq(v, 27), eq(v, 28))) {
                    mstore(0x00, recoveryIdError)
                    revert(0x00, 0x04)
                }

                mstore(add(frame, 0x20), v)
                mstore(add(frame, 0x40), r)
                mstore(add(frame, 0x60), s)
                // `ecrecover` returns empty data on failure and leaves the
                // output word untouched, so pre-zero it.
                mstore(add(frame, 0x80), 0)

                // Precompile 0x01. It cannot run out of gas at any realistic
                // gas limit, so the success flag only guards against a
                // malformed frame.
                let ok := staticcall(gas(), 0x01, frame, 0x80, add(frame, 0x80), 0x20)
                let signer := mload(add(frame, 0x80))

                if iszero(and(ok, gt(signer, 0))) {
                    mstore(0x00, unrecoverableError)
                    revert(0x00, 0x04)
                }
                if iszero(gt(signer, previous)) {
                    mstore(0x00, unsortedError)
                    revert(0x00, 0x04)
                }

                previous := signer
                mstore(out, signer)
                out := add(out, 0x20)
                source := add(source, 65)
            }
        }
    }
}
