// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IPoolManager, IUnlockCallback, PoolKey, SwapParams} from "../interfaces/IPoolManager.sol";

/// @notice Test double for the Uniswap v4 `PoolManager`.
/// @dev Models the parts an integrator depends on rather than the AMM:
///
///        - flash accounting: every swap, settle and take moves a per-currency
///          delta, and `unlock` reverts unless all of them are back to zero;
///        - `sync`/`settle` credit only what actually arrived;
///        - an exact-output swap that runs out of liquidity stops short
///          instead of reverting, as v4 does.
///
///      Each pool trades at a fixed rate, set with `setPool`, and pays out of
///      this contract's own balances, so a test must fund it first.
contract MockPoolManager is IPoolManager {
    using SafeCast for uint256;
    using SafeCast for int256;

    struct Pool {
        /// @dev currency1 per 1e18 of currency0. Zero means uninitialised.
        uint256 rate;
        /// @dev Largest output one swap can produce; zero means unlimited.
        uint256 maxOut;
    }

    uint256 private constant ONE = 1e18;

    mapping(bytes32 poolId => Pool) public pools;

    bool private unlocked;
    address[] private touched;
    mapping(address currency => int256) public deltaOf;

    address private syncedCurrency;
    uint256 private syncedReserve;
    bool private synced;

    error AlreadyUnlocked();
    error ManagerLocked();
    error PoolNotInitialized();
    error CurrencyNotSettled();
    error NotExactOutput();

    function setPool(PoolKey calldata key, uint256 rate, uint256 maxOut) external {
        pools[keccak256(abi.encode(key))] = Pool({rate: rate, maxOut: maxOut});
    }

    /// @inheritdoc IPoolManager
    function unlock(bytes calldata data) external returns (bytes memory result) {
        if (unlocked) revert AlreadyUnlocked();
        unlocked = true;

        result = IUnlockCallback(msg.sender).unlockCallback(data);

        for (uint256 i = 0; i < touched.length; ++i) {
            if (deltaOf[touched[i]] != 0) revert CurrencyNotSettled();
        }
        delete touched;
        unlocked = false;
    }

    /// @inheritdoc IPoolManager
    /// @dev Exact output only, which is all `ZapJoin` asks for.
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata)
        external
        returns (int256 swapDelta)
    {
        if (!unlocked) revert ManagerLocked();
        if (params.amountSpecified <= 0) revert NotExactOutput();

        Pool memory pool = pools[keccak256(abi.encode(key))];
        if (pool.rate == 0) revert PoolNotInitialized();

        uint256 amountOut = params.amountSpecified.toUint256();
        if (pool.maxOut != 0 && amountOut > pool.maxOut) amountOut = pool.maxOut;

        // Rounded up, in the pool's favour, as a real exact-output quote is.
        uint256 amountIn =
            params.zeroForOne ? _ceilDiv(amountOut * ONE, pool.rate) : _ceilDiv(amountOut * pool.rate, ONE);

        (address currencyIn, address currencyOut) =
            params.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        _account(currencyIn, -amountIn.toInt256());
        _account(currencyOut, amountOut.toInt256());

        int128 paid = -amountIn.toInt256().toInt128();
        int128 received = amountOut.toInt256().toInt128();
        swapDelta = params.zeroForOne ? _pack(paid, received) : _pack(received, paid);
    }

    /// @inheritdoc IPoolManager
    function sync(address currency) external {
        syncedCurrency = currency;
        syncedReserve = currency == address(0) ? 0 : IERC20(currency).balanceOf(address(this));
        synced = true;
    }

    /// @inheritdoc IPoolManager
    function settle() external payable returns (uint256 paid) {
        if (!unlocked) revert ManagerLocked();
        address currency = synced ? syncedCurrency : address(0);
        paid = currency == address(0) ? msg.value : IERC20(currency).balanceOf(address(this)) - syncedReserve;
        synced = false;
        _account(currency, paid.toInt256());
    }

    /// @inheritdoc IPoolManager
    function take(address currency, address to, uint256 amount) external {
        if (!unlocked) revert ManagerLocked();
        _account(currency, -amount.toInt256());
        if (currency == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "native transfer failed");
        } else {
            require(IERC20(currency).transfer(to, amount), "token transfer failed");
        }
    }

    function _account(address currency, int256 amount) private {
        if (deltaOf[currency] == 0) touched.push(currency);
        deltaOf[currency] += amount;
    }

    function _pack(int128 amount0, int128 amount1) private pure returns (int256 delta) {
        assembly ("memory-safe") {
            delta := or(shl(128, amount0), and(sub(shl(128, 1), 1), amount1))
        }
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    receive() external payable {}
}
