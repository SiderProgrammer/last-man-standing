// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// @notice Produces the attestor signature blob `GameEscrow.settle` expects.
///
/// @dev `SignatureLib.recoverAscending` requires strictly ascending signer
///      addresses, so every caller has to sort its keys by the address they
///      recover to before signing. That sort was written out three times — in
///      `Fixtures`, in the invariant handler, and in the signature fuzz suite —
///      which is three chances to sort correctly in one place and not another.
///
///      Functions are `internal` so they inline into the caller: nothing extra
///      is deployed and no test contract's address shifts.
library Attest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Sorts private keys in place by the address they recover to.
    function sortByAddress(uint256[] memory pks) internal view {
        for (uint256 i = 0; i < pks.length; ++i) {
            for (uint256 j = i + 1; j < pks.length; ++j) {
                if (VM.addr(pks[j]) < VM.addr(pks[i])) {
                    (pks[i], pks[j]) = (pks[j], pks[i]);
                }
            }
        }
    }

    /// @notice Signs `digest` with every key, packed in ascending signer order.
    function signAscending(uint256[] memory pks, bytes32 digest)
        internal
        view
        returns (bytes memory signatures)
    {
        sortByAddress(pks);
        for (uint256 i = 0; i < pks.length; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = VM.sign(pks[i], digest);
            signatures = bytes.concat(signatures, abi.encodePacked(r, s, v));
        }
    }
}
