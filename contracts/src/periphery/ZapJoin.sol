// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {GameEscrow} from "../GameEscrow.sol";
import {ZeroAddress} from "../Errors.sol";
import {
    BalanceDeltaLib,
    IPoolManager,
    IUnlockCallback,
    PoolKey,
    SwapParams
} from "../interfaces/IPoolManager.sol";

/// @title ZapJoin
/// @notice Joins a lobby paying in any ERC-20 with a Uniswap v4 route to ETH.
///
/// @dev The escrow only ever sees ETH. This contract swaps the player's token
///      for exactly the lobby's stake inside one v4 `unlock` session, then
///      pays the stake into `GameEscrow.joinFor`, which seats the player
///      rather than this contract.
///
///      Exact output, not exact input: the stake is fixed, so the swap asks
///      the pool for precisely that much ETH and the player pays whatever it
///      costs, bounded by `maxAmountIn`. Nothing is left over to refund and
///      nothing is held between transactions — the input goes straight from
///      the player to the `PoolManager`, and the ETH straight on to the escrow.
///
///      Deliberately outside the escrow. A swap brings price risk, slippage
///      and arbitrary hook code; none of it belongs in the contract holding
///      every stake, and none of it can reach there: all the escrow receives
///      is a `joinFor` call with the exact stake attached.
///
///      No owner and no parameters. Replacing it means deploying another one.
///
///      Unsupported: fee-on-transfer and rebasing tokens. The `PoolManager`
///      credits what actually arrives, so the session ends unsettled and the
///      whole transaction reverts.
contract ZapJoin is IUnlockCallback, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice One hop of a route, in the convention of v4-periphery's
    ///         exact-output `PathKey`: ordered from the input token towards
    ///         ETH, each entry names the currency *entering* that hop and the
    ///         pool it trades through. The route always ends in native ETH,
    ///         and `path[0].intermediateCurrency` is the token the player pays.
    /// @dev Same shape as v4-periphery, so a path can be quoted as-is with
    ///      `V4Quoter.quoteExactOutput({exactCurrency: address(0), path, exactAmount: stake})`.
    struct PathKey {
        address intermediateCurrency;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        bytes hookData;
    }

    address private constant NATIVE = address(0);

    /// @dev `TickMath.MIN_SQRT_PRICE + 1` and `TickMath.MAX_SQRT_PRICE - 1`:
    ///      no price limit. The bound on what the player pays is `maxAmountIn`.
    uint160 private constant MIN_PRICE_LIMIT = 4_295_128_739 + 1;
    uint160 private constant MAX_PRICE_LIMIT =
        1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342 - 1;

    IPoolManager public immutable poolManager;
    GameEscrow public immutable escrow;

    event ZapJoined(
        bytes32 indexed matchId,
        address indexed player,
        address indexed tokenIn,
        uint256 amountIn,
        uint128 stake
    );

    error NotPoolManager(address caller);
    error DeadlinePassed(uint256 deadline);
    error EmptyPath();
    error NativeInput();
    error MatchNotOpen(bytes32 matchId);
    error SlippageExceeded(uint256 amountIn, uint256 maxAmountIn);
    error PartialFill(uint256 requested, uint256 received);
    error UnexpectedDelta(int128 amountIn);

    constructor(IPoolManager poolManager_, GameEscrow escrow_) {
        if (address(poolManager_) == address(0) || address(escrow_) == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
        escrow = escrow_;
    }

    /// @notice Swaps the caller's token for the lobby's stake and seats the caller.
    /// @dev The caller must first approve this contract for at least `maxAmountIn`
    ///      of `path[0].intermediateCurrency`. Paying in ETH needs no swap: call
    ///      `GameEscrow.join` directly.
    /// @param path Route from the input token to ETH; see `PathKey`.
    /// @param maxAmountIn Most of the input token the caller will pay.
    /// @param deadline Last timestamp the swap may execute at.
    /// @return amountIn Input token actually paid.
    function joinWithToken(bytes32 matchId, PathKey[] calldata path, uint256 maxAmountIn, uint256 deadline)
        external
        nonReentrant
        returns (uint256 amountIn)
    {
        if (block.timestamp > deadline) revert DeadlinePassed(deadline);
        if (path.length == 0) revert EmptyPath();
        address tokenIn = path[0].intermediateCurrency;
        if (tokenIn == NATIVE) revert NativeInput();

        // Checked here only to fail before paying for a swap; `joinFor` is
        // still the authority on every seating rule.
        GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
        if (info.status != GameEscrow.MatchStatus.Open) revert MatchNotOpen(matchId);

        amountIn =
            abi.decode(poolManager.unlock(abi.encode(msg.sender, info.stake, maxAmountIn, path)), (uint256));

        escrow.joinFor{value: info.stake}(matchId, msg.sender);

        emit ZapJoined(matchId, msg.sender, tokenIn, amountIn, info.stake);
    }

    /// @inheritdoc IUnlockCallback
    /// @dev Only reachable through `joinWithToken`: the manager calls back
    ///      whoever called `unlock`, and this contract calls it nowhere else,
    ///      so `payer` is always the address that started this transaction's
    ///      join, never one supplied by a third party.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);

        (address payer, uint128 stake, uint256 maxAmountIn, PathKey[] memory path) =
            abi.decode(data, (address, uint128, uint256, PathKey[]));

        // Walk the route backwards from the stake: each hop's input is the
        // output the hop after it needs. Intermediate currencies net to zero
        // inside the session, so only the first input and the ETH move.
        uint256 amount = stake;
        address currencyOut = NATIVE;
        for (uint256 i = path.length; i > 0; --i) {
            PathKey memory hop = path[i - 1];
            amount = _swapExactOutput(hop, currencyOut, amount);
            currencyOut = hop.intermediateCurrency;
        }

        if (amount > maxAmountIn) revert SlippageExceeded(amount, maxAmountIn);

        poolManager.sync(currencyOut);
        IERC20(currencyOut).safeTransferFrom(payer, address(poolManager), amount);
        poolManager.settle();
        poolManager.take(NATIVE, address(this), stake);

        return abi.encode(amount);
    }

    /// @dev Swaps for exactly `amountOut` of `currencyOut` and returns what it costs.
    function _swapExactOutput(PathKey memory hop, address currencyOut, uint256 amountOut)
        private
        returns (uint256 amountIn)
    {
        address currencyIn = hop.intermediateCurrency;
        bool zeroForOne = currencyIn < currencyOut;
        PoolKey memory key = PoolKey({
            currency0: zeroForOne ? currencyIn : currencyOut,
            currency1: zeroForOne ? currencyOut : currencyIn,
            fee: hop.fee,
            tickSpacing: hop.tickSpacing,
            hooks: hop.hooks
        });

        int256 delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                // Bounded by the stake's uint128, or by the previous hop's int128 delta.
                // forge-lint: disable-next-line(unsafe-typecast)
                amountSpecified: int256(amountOut),
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            hop.hookData
        );

        (int128 paid, int128 received) = zeroForOne
            ? (BalanceDeltaLib.amount0(delta), BalanceDeltaLib.amount1(delta))
            : (BalanceDeltaLib.amount1(delta), BalanceDeltaLib.amount0(delta));

        // v4 stops an exact-output swap short, rather than reverting, when the
        // pool runs out of liquidity; hooks that return deltas can also move
        // either side. Take neither on trust.
        if (paid >= 0) revert UnexpectedDelta(paid);
        // Sign-checked on the same line.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 got = received < 0 ? 0 : uint256(int256(received));
        if (got != amountOut) revert PartialFill(amountOut, got);

        // Negative, checked above.
        // forge-lint: disable-next-line(unsafe-typecast)
        amountIn = uint256(-int256(paid));
    }

    /// @dev ETH arrives only from `take`, and leaves again in the same call.
    receive() external payable {
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);
    }
}
