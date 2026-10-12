// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {PullPayable} from "../PullPayable.sol";
import {TransferFailed, ZeroAddress} from "../Errors.sol";
import {
    BalanceDeltaLib,
    IPoolManager,
    IUnlockCallback,
    PoolKey,
    SwapParams
} from "../interfaces/IPoolManager.sol";

/// @title FeeRouter
/// @notice Turns protocol fees into yield for stakers.
///
/// @dev Set as the escrow's `treasury`, so settlement credits every match fee
///      here. Two steps move it on:
///
///        1. `harvest` — anyone. Pulls the credited ETH out of the escrow and
///           splits it: `stakerBps` is reserved for buybacks, the rest goes
///           straight to `treasury`.
///        2. `buyback` — keeper only. Swaps reserved ETH for LMS through the
///           Uniswap v4 LMS/ETH pool and sends the LMS directly into the
///           `StakedLms` vault, which raises the value of every sLMS share.
///
///      Why the keeper: a swap with a caller-chosen `minLmsOut` is only as safe
///      as the caller. Left open, anyone could buy back with no floor inside a
///      sandwich and hand the stakers' fees to the attacker. The keeper is set
///      by governance and quotes the pool off-chain; the worst a bad keeper can
///      do is buy back at a poor price, and governance can replace it.
///
///      Holds nothing between transactions but `pendingBuyback`: ETH arrives
///      only from the escrow, and the treasury share leaves in the same call.
///
///      Pool currencies sort by address, and native ETH is `address(0)`, so
///      ETH is always `currency0` and buying LMS is always `zeroForOne`.
contract FeeRouter is IUnlockCallback, Ownable2Step, ReentrancyGuardTransient {
    /// @notice The LMS/ETH pool to buy through. Currencies are implied.
    struct PoolConfig {
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    uint16 public constant BPS_DENOMINATOR = 10_000;

    address private constant NATIVE = address(0);
    /// @dev `TickMath.MIN_SQRT_PRICE + 1`: no price limit. The bound is `minLmsOut`.
    uint160 private constant MIN_PRICE_LIMIT = 4_295_128_739 + 1;

    IPoolManager public immutable poolManager;
    PullPayable public immutable escrow;
    IERC20 public immutable lms;
    /// @notice Where bought-back LMS goes: the `StakedLms` vault.
    address public immutable vault;

    /// @notice Receives the part of each harvest not used for buybacks.
    address public treasury;
    /// @notice The only account that may call `buyback`.
    address public keeper;
    /// @notice Share of harvested fees reserved for buybacks, in basis points.
    uint16 public stakerBps;
    PoolConfig public pool;

    /// @notice ETH harvested for stakers and not yet swapped.
    uint256 public pendingBuyback;

    event Harvested(uint256 amount, uint256 toStakers, uint256 toTreasury);
    event BoughtBack(uint256 ethIn, uint256 lmsOut);
    event TreasuryUpdated(address indexed previous, address indexed current);
    event KeeperUpdated(address indexed previous, address indexed current);
    event StakerBpsUpdated(uint16 previous, uint16 current);
    event PoolUpdated(uint24 fee, int24 tickSpacing, address hooks);

    error InvalidBps(uint16 bps);
    error NotKeeper(address caller);
    error NotPoolManager(address caller);
    error UnexpectedSender(address sender);
    error DeadlinePassed(uint256 deadline);
    error InsufficientPending(uint256 requested, uint256 pending);
    error PartialFill(uint256 requested, uint256 paid);
    error SlippageExceeded(uint256 lmsOut, uint256 minLmsOut);
    error UnexpectedDelta(int128 amountIn);

    constructor(
        IPoolManager poolManager_,
        PullPayable escrow_,
        IERC20 lms_,
        address vault_,
        address owner_,
        address treasury_,
        address keeper_,
        uint16 stakerBps_,
        PoolConfig memory pool_
    ) Ownable(owner_) {
        if (
            address(poolManager_) == address(0) || address(escrow_) == address(0)
                || address(lms_) == address(0) || vault_ == address(0)
        ) revert ZeroAddress();
        poolManager = poolManager_;
        escrow = escrow_;
        lms = lms_;
        vault = vault_;
        _setTreasury(treasury_);
        _setKeeper(keeper_);
        _setStakerBps(stakerBps_);
        _setPool(pool_);
    }

    // ------------------------------------------------------------------ fees

    /// @notice Pulls every fee credited by the escrow and splits it.
    /// @dev Reverts with the escrow's `NothingToWithdraw` when there is nothing to pull.
    function harvest() external nonReentrant returns (uint256 amount) {
        amount = escrow.withdraw(address(this));

        uint256 toStakers = (amount * stakerBps) / BPS_DENOMINATOR;
        uint256 toTreasury = amount - toStakers;
        pendingBuyback += toStakers;

        if (toTreasury != 0) {
            (bool ok,) = treasury.call{value: toTreasury}("");
            if (!ok) revert TransferFailed(treasury, toTreasury);
        }

        emit Harvested(amount, toStakers, toTreasury);
    }

    /// @notice Swaps `amountIn` of reserved ETH for LMS and sends it to the vault.
    /// @param minLmsOut Least LMS the swap may return; quote the pool off-chain.
    /// @param deadline Last timestamp the swap may execute at.
    /// @return lmsOut LMS delivered to the vault.
    function buyback(uint256 amountIn, uint256 minLmsOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 lmsOut)
    {
        if (msg.sender != keeper) revert NotKeeper(msg.sender);
        if (block.timestamp > deadline) revert DeadlinePassed(deadline);
        if (amountIn > pendingBuyback) revert InsufficientPending(amountIn, pendingBuyback);

        pendingBuyback -= amountIn;
        lmsOut = abi.decode(poolManager.unlock(abi.encode(amountIn, minLmsOut)), (uint256));

        emit BoughtBack(amountIn, lmsOut);
    }

    /// @inheritdoc IUnlockCallback
    /// @dev Only reachable through `buyback`, which is the only caller of `unlock`.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);
        (uint256 amountIn, uint256 minLmsOut) = abi.decode(data, (uint256, uint256));

        PoolConfig memory config = pool;
        PoolKey memory key = PoolKey({
            currency0: NATIVE,
            currency1: address(lms),
            fee: config.fee,
            tickSpacing: config.tickSpacing,
            hooks: config.hooks
        });
        int256 delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: true,
                // Bounded by `pendingBuyback`, which is ETH this contract holds.
                // forge-lint: disable-next-line(unsafe-typecast)
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: MIN_PRICE_LIMIT
            }),
            ""
        );

        int128 paid = BalanceDeltaLib.amount0(delta);
        int128 received = BalanceDeltaLib.amount1(delta);

        // v4 stops an exact-input swap short when the pool runs dry, and hooks
        // that return deltas can move either side. Take neither on trust.
        if (paid >= 0) revert UnexpectedDelta(paid);
        // Negative, checked above.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 spent = uint256(-int256(paid));
        if (spent != amountIn) revert PartialFill(amountIn, spent);
        // Sign-checked on the same line.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 lmsOut = received < 0 ? 0 : uint256(int256(received));
        if (lmsOut < minLmsOut) revert SlippageExceeded(lmsOut, minLmsOut);

        poolManager.settle{value: amountIn}();
        poolManager.take(address(lms), vault, lmsOut);

        return abi.encode(lmsOut);
    }

    // ------------------------------------------------------------- governance

    function setTreasury(address treasury_) external onlyOwner {
        _setTreasury(treasury_);
    }

    function setKeeper(address keeper_) external onlyOwner {
        _setKeeper(keeper_);
    }

    /// @dev Applies to the next harvest; ETH already reserved stays reserved.
    function setStakerBps(uint16 stakerBps_) external onlyOwner {
        _setStakerBps(stakerBps_);
    }

    function setPool(PoolConfig calldata pool_) external onlyOwner {
        _setPool(pool_);
    }

    function _setTreasury(address treasury_) private {
        if (treasury_ == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, treasury_);
        treasury = treasury_;
    }

    function _setKeeper(address keeper_) private {
        if (keeper_ == address(0)) revert ZeroAddress();
        emit KeeperUpdated(keeper, keeper_);
        keeper = keeper_;
    }

    function _setStakerBps(uint16 stakerBps_) private {
        if (stakerBps_ > BPS_DENOMINATOR) revert InvalidBps(stakerBps_);
        emit StakerBpsUpdated(stakerBps, stakerBps_);
        stakerBps = stakerBps_;
    }

    function _setPool(PoolConfig memory pool_) private {
        pool = pool_;
        emit PoolUpdated(pool_.fee, pool_.tickSpacing, pool_.hooks);
    }

    /// @dev Fees arrive from the escrow's `withdraw`. Nothing else pays in.
    receive() external payable {
        if (msg.sender != address(escrow)) revert UnexpectedSender(msg.sender);
    }
}
