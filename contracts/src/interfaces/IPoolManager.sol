// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev The slice of Uniswap v4 that an exact-output swap needs, mirrored from
///      `v4-core/src/interfaces/IPoolManager.sol` and `v4-core/src/types/`.
///
///      v4 wraps these in user-defined value types — `Currency` and `IHooks`
///      are addresses, `BalanceDelta` is an `int256` — which erase to exactly
///      the plain types used here, so every selector and every encoding is the
///      one the deployed `PoolManager` expects. The native currency is
///      `address(0)`, which is what lets a v4 pool pay out ETH directly with no
///      WETH hop.

/// @notice Identifies a pool. `currency0` sorts below `currency1`.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    /// @dev Negative for exact input, positive for exact output.
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    /// @notice Opens a flash-accounting session and calls back
    ///         `IUnlockCallback(msg.sender).unlockCallback(data)`. Every
    ///         currency delta must be zero again when the callback returns.
    function unlock(bytes calldata data) external returns (bytes memory);

    /// @return swapDelta The caller's `BalanceDelta`: `amount0` in the high 128
    ///         bits, `amount1` in the low. Negative is owed to the pool,
    ///         positive is owed to the caller.
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 swapDelta);

    /// @notice Snapshots the manager's balance of `currency` ahead of a transfer in.
    function sync(address currency) external;

    /// @notice Credits the caller with whatever arrived since `sync`, or with `msg.value` for native.
    function settle() external payable returns (uint256 paid);

    /// @notice Sends `amount` of `currency` out, debiting the caller.
    function take(address currency, address to, uint256 amount) external;
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// @notice Unpacks a v4 `BalanceDelta`.
library BalanceDeltaLib {
    function amount0(int256 delta) internal pure returns (int128) {
        // Arithmetic shift, so the sign of the high half survives.
        // forge-lint: disable-next-line(unsafe-typecast)
        return int128(delta >> 128);
    }

    function amount1(int256 delta) internal pure returns (int128) {
        // Truncation keeps the low 128 bits, which is v4's `signextend(15, delta)`.
        // forge-lint: disable-next-line(unsafe-typecast)
        return int128(delta);
    }
}
