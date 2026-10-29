// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title SignatureLib
/// @notice Recovers a quorum of attestor signatures from one packed blob.
/// @dev Recovery is OpenZeppelin's `ECDSA`, which rejects a malleable `s` and
///      any signature that does not recover. Attestors are therefore EOAs: a
///      contract signer (ERC-1271) cannot sign a result.
library SignatureLib {
    /// @notice Signature blob length is not a multiple of 65.
    error MalformedSignatureBlob();
    /// @notice Signers were not in strictly ascending address order.
    error UnsortedSigners();

    uint256 private constant SIGNATURE_LENGTH = 65;

    /// @notice Recovers every signer in a packed `r ‖ s ‖ v` blob.
    /// @dev Signers must appear in strictly ascending address order. That single
    ///      rule does three jobs at once: it rejects duplicate signatures
    ///      (which would otherwise let one attestor satisfy a quorum on its
    ///      own), it makes the recovered set canonical, and it costs one
    ///      comparison instead of a membership structure.
    /// @param digest EIP-712 digest that was signed.
    /// @param signatures Concatenated 65-byte signatures.
    /// @return signers Recovered addresses, in ascending order.
    function recoverAscending(bytes32 digest, bytes calldata signatures)
        internal
        pure
        returns (address[] memory signers)
    {
        if (signatures.length % SIGNATURE_LENGTH != 0) revert MalformedSignatureBlob();

        signers = new address[](signatures.length / SIGNATURE_LENGTH);
        address previous;
        for (uint256 i = 0; i < signers.length; ++i) {
            uint256 start = i * SIGNATURE_LENGTH;
            address signer = ECDSA.recover(digest, signatures[start:start + SIGNATURE_LENGTH]);
            if (signer <= previous) revert UnsortedSigners();
            signers[i] = signer;
            previous = signer;
        }
    }
}
