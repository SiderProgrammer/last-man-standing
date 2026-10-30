// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

// Vendored from smartcontractkit/chainlink, contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol
// (@chainlink/contracts 1.x). Unchanged apart from this header and forge fmt.

// End consumer library.
library VRFV2PlusClient {
    // extraArgs will evolve to support new features
    bytes4 public constant EXTRA_ARGS_V1_TAG = bytes4(keccak256("VRF ExtraArgsV1"));

    struct ExtraArgsV1 {
        bool nativePayment;
    }

    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }

    function _argsToBytes(ExtraArgsV1 memory extraArgs) internal pure returns (bytes memory bts) {
        return abi.encodeWithSelector(EXTRA_ARGS_V1_TAG, extraArgs);
    }
}
