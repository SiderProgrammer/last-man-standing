// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {TransferFailed, ZeroAddress} from "../Errors.sol";
import {
    BalanceDeltaLib,
    IPoolManager,
    IUnlockCallback,
    ModifyLiquidityParams,
    PoolKey
} from "../interfaces/IPoolManager.sol";

/// @title ProtocolLiquidity
/// @notice Creates the LMS/ETH Uniswap v4 pool that `FeeRouter` buys through,
///         and holds its starting liquidity as a protocol-owned position.
///
/// @dev `bootstrap` does both in one call: it creates the pool at the price
///      implied by the amounts supplied — `lmsAmount` LMS per `msg.value` ETH —
///      and adds them as one full-range position. Pairing the two in one
///      transaction means nobody can slip a trade in between and fill the
///      position at a price the depositor did not choose.
///
///      The position belongs to this contract, and only the owner — the
///      timelock — can take it out, so the liquidity behind buybacks cannot be
///      pulled by whoever happened to fund it. Whatever `bootstrap` was given
///      and did not need is refunded to the caller.
///
///      Full range, not concentrated: the pool has one job, to keep a buyback
///      possible at any price, and a full-range position never goes out of
///      range. The price of that is capital efficiency, which a buyback venue
///      does not need.
///
///      If somebody creates the same pool first, `bootstrap` reverts and
///      nothing is lost; choose a different fee tier, and point `FeeRouter` at
///      it with `setPool`.
contract ProtocolLiquidity is IUnlockCallback, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    address private constant NATIVE = address(0);
    /// @dev `TickMath.MIN_TICK`.
    int24 private constant MIN_TICK = -887_272;
    uint256 private constant Q96 = 1 << 96;

    IPoolManager public immutable poolManager;
    IERC20 public immutable lms;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    /// @notice The full usable range for `tickSpacing`.
    int24 public immutable tickLower;
    int24 public immutable tickUpper;

    /// @notice Liquidity this contract holds in the pool.
    uint128 public liquidity;

    event Bootstrapped(uint160 sqrtPriceX96, uint128 liquidity, uint256 ethIn, uint256 lmsIn);
    event LiquidityRemoved(uint128 liquidity, address indexed to, uint256 ethOut, uint256 lmsOut);

    error ZeroAmount();
    error NotPoolManager(address caller);
    error InsufficientLiquidity(uint128 requested, uint128 held);
    error ExceedsMax(uint256 owed, uint256 max);
    error UnexpectedDelta(int128 amount0, int128 amount1);

    constructor(IPoolManager poolManager_, IERC20 lms_, address owner_, uint24 fee_, int24 tickSpacing_)
        Ownable(owner_)
    {
        if (address(poolManager_) == address(0) || address(lms_) == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
        lms = lms_;
        fee = fee_;
        tickSpacing = tickSpacing_;
        // Division truncates towards zero, which is towards the usable range.
        tickLower = (MIN_TICK / tickSpacing_) * tickSpacing_;
        tickUpper = -tickLower;
    }

    /// @notice The pool this contract creates and provides for.
    function poolKey() public view returns (PoolKey memory) {
        return PoolKey({
            currency0: NATIVE, currency1: address(lms), fee: fee, tickSpacing: tickSpacing, hooks: address(0)
        });
    }

    /// @notice Creates the pool at `lmsAmount` LMS per `msg.value` ETH and
    ///         adds both as protocol-owned liquidity.
    /// @dev The caller must approve this contract for `lmsAmount` LMS first.
    ///      Rounding leaves a few wei of each unused; they are refunded.
    function bootstrap(uint256 lmsAmount) external payable nonReentrant returns (uint128 added) {
        if (msg.value == 0 || lmsAmount == 0) revert ZeroAmount();

        uint160 sqrtPriceX96 = Math.sqrt(Math.mulDiv(lmsAmount, 1 << 192, msg.value)).toUint160();
        poolManager.initialize(poolKey(), sqrtPriceX96);

        // The most liquidity both amounts can cover at that price. For a full
        // range the bounds are far enough away that the position needs a
        // little less of each than this, never more.
        uint256 fromEth = Math.mulDiv(msg.value, sqrtPriceX96, Q96);
        uint256 fromLms = Math.mulDiv(lmsAmount, Q96, sqrtPriceX96);
        added = Math.min(fromEth, fromLms).toUint128();

        (uint256 ethIn, uint256 lmsIn) = abi.decode(
            poolManager.unlock(abi.encode(true, msg.sender, added, msg.value, lmsAmount)), (uint256, uint256)
        );
        liquidity += added;

        uint256 refund = msg.value - ethIn;
        if (refund != 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert TransferFailed(msg.sender, refund);
        }

        emit Bootstrapped(sqrtPriceX96, added, ethIn, lmsIn);
    }

    /// @notice Withdraws `amount` of the position, with its share of accrued
    ///         fees, to `to`. Governance only.
    function removeLiquidity(uint128 amount, address to)
        external
        onlyOwner
        nonReentrant
        returns (uint256 ethOut, uint256 lmsOut)
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > liquidity) revert InsufficientLiquidity(amount, liquidity);

        liquidity -= amount;
        (ethOut, lmsOut) = abi.decode(
            poolManager.unlock(abi.encode(false, to, amount, uint256(0), uint256(0))), (uint256, uint256)
        );

        emit LiquidityRemoved(amount, to, ethOut, lmsOut);
    }

    /// @inheritdoc IUnlockCallback
    /// @dev Only reachable through `bootstrap` and `removeLiquidity`, the only
    ///      callers of `unlock`, so `account` is always the address that started
    ///      this transaction's call: the payer when adding, the recipient when
    ///      removing.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);
        (bool add, address account, uint128 amount, uint256 maxEth, uint256 maxLms) =
            abi.decode(data, (bool, address, uint128, uint256, uint256));

        int256 liquidityDelta = add ? int256(uint256(amount)) : -int256(uint256(amount));
        (int256 delta,) = poolManager.modifyLiquidity(
            poolKey(),
            ModifyLiquidityParams({
                tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: liquidityDelta, salt: bytes32(0)
            }),
            ""
        );
        int128 amount0 = BalanceDeltaLib.amount0(delta);
        int128 amount1 = BalanceDeltaLib.amount1(delta);

        if (add) {
            // Adding can only cost: both sides owed to the pool, or zero.
            if (amount0 > 0 || amount1 > 0) revert UnexpectedDelta(amount0, amount1);
            // Non-positive, checked above.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 ethIn = uint256(-int256(amount0));
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 lmsIn = uint256(-int256(amount1));
            if (ethIn > maxEth) revert ExceedsMax(ethIn, maxEth);
            if (lmsIn > maxLms) revert ExceedsMax(lmsIn, maxLms);

            if (ethIn != 0) poolManager.settle{value: ethIn}();
            if (lmsIn != 0) {
                poolManager.sync(address(lms));
                lms.safeTransferFrom(account, address(poolManager), lmsIn);
                poolManager.settle();
            }
            return abi.encode(ethIn, lmsIn);
        }

        // Removing can only pay out: principal plus fees.
        if (amount0 < 0 || amount1 < 0) revert UnexpectedDelta(amount0, amount1);
        // Non-negative, checked above.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 ethOut = uint256(int256(amount0));
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 lmsOut = uint256(int256(amount1));
        if (ethOut != 0) poolManager.take(NATIVE, account, ethOut);
        if (lmsOut != 0) poolManager.take(address(lms), account, lmsOut);
        return abi.encode(ethOut, lmsOut);
    }
}
