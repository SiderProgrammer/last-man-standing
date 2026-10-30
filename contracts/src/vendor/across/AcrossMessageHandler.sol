// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// Vendored from across-protocol/contracts v5.0.27 (7445f72de17900544605c7e6706c5fb3b3784738),
// contracts/interfaces/SpokePoolMessageHandler.sol. Unchanged apart from this header and forge fmt.

// This interface is expected to be implemented by any contract that expects to receive messages from the SpokePool.
interface AcrossMessageHandler {
    function handleV3AcrossMessage(address tokenSent, uint256 amount, address relayer, bytes memory message)
        external;
}
