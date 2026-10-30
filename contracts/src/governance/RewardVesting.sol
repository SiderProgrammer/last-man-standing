// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ZeroAddress} from "../Errors.sol";

/// @title RewardVesting
/// @notice Holds play-mining rewards while they vest, and pays them out as
///         liquid LMS once they have.
///
/// @dev `RewardsDistributor` creates this contract and is the only one that
///      can grant. Every claim adds one tranche per (player, epoch): the LMS
///      that epoch's fees earned. A tranche vests linearly over
///      `VESTING_DURATION`, starting the moment its epoch ended — the epoch's
///      `claimableFrom` — not the moment it was claimed.
///
///      Vesting LMS sits here, and this contract cannot stake or delegate, so
///      a reward gives no votes until it has vested, been released to the
///      player, and been staked by them in `StakedLms`. That is what makes
///      farming slow to turn into governance power.
///
///      One tranche per epoch keeps every loop bounded: a player has at most
///      one per program epoch, 208 in all, and `release` walks only the
///      epochs it is given.
contract RewardVesting {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @notice How long a tranche takes to vest: 26 weeks, about six months.
    uint256 public constant VESTING_DURATION = 26 weeks;

    struct Tranche {
        uint128 amount;
        uint128 released;
    }

    IERC20 public immutable lms;
    /// @notice The only account that can grant: the distributor that made this.
    address public immutable distributor;
    /// @notice Length of an epoch, as the distributor counts them.
    uint256 public immutable epochLength;

    mapping(address player => mapping(uint256 epoch => Tranche)) public trancheOf;
    /// @notice Every tranche's amount, added up.
    uint256 public totalGranted;
    /// @notice Everything paid out so far.
    uint256 public totalReleased;

    event Granted(address indexed player, uint256 indexed epoch, uint256 amount);
    event Released(address indexed player, address indexed caller, uint256 amount, uint256[] epochs);

    error NotDistributor(address caller);
    error AlreadyGranted(address player, uint256 epoch);
    error NothingToRelease();

    constructor(IERC20 lms_, uint256 epochLength_) {
        if (address(lms_) == address(0)) revert ZeroAddress();
        lms = lms_;
        distributor = msg.sender;
        epochLength = epochLength_;
    }

    /// @notice Records one tranche per epoch for `player`. The distributor
    ///         has already sent the LMS.
    function grant(address player, uint256[] memory epochs, uint256[] memory amounts) external {
        if (msg.sender != distributor) revert NotDistributor(msg.sender);
        uint256 total;
        for (uint256 i = 0; i < epochs.length; ++i) {
            uint256 amount = amounts[i];
            if (amount == 0) continue;
            Tranche storage tranche = trancheOf[player][epochs[i]];
            if (tranche.amount != 0) revert AlreadyGranted(player, epochs[i]);
            tranche.amount = amount.toUint128();
            total += amount;
            emit Granted(player, epochs[i], amount);
        }
        totalGranted += total;
    }

    /// @notice When `epoch`'s tranches start vesting: the moment it ended.
    function vestingStart(uint256 epoch) public view returns (uint256) {
        return (epoch + 1) * epochLength;
    }

    /// @notice How much of `player`'s tranche for `epoch` has vested by now.
    function vested(address player, uint256 epoch) public view returns (uint256) {
        uint256 amount = trancheOf[player][epoch].amount;
        uint256 start = vestingStart(epoch);
        if (block.timestamp <= start) return 0;
        uint256 elapsed = block.timestamp - start;
        if (elapsed >= VESTING_DURATION) return amount;
        return (amount * elapsed) / VESTING_DURATION;
    }

    /// @notice What `release` would pay `player` now for `epoch`.
    function releasable(address player, uint256 epoch) public view returns (uint256) {
        return vested(player, epoch) - trancheOf[player][epoch].released;
    }

    /// @notice What `player` could release now across `fromEpoch..toEpoch`
    ///         inclusive, and which of those epochs it comes from.
    /// @dev A view for the client, meant for `eth_call`: it loops over the range.
    function releasableIn(address player, uint256 fromEpoch, uint256 toEpoch)
        external
        view
        returns (uint256 total, uint256[] memory epochs)
    {
        if (toEpoch < fromEpoch) return (0, new uint256[](0));
        epochs = new uint256[](toEpoch - fromEpoch + 1);
        uint256 count;
        for (uint256 epoch = fromEpoch; epoch <= toEpoch; ++epoch) {
            uint256 amount = releasable(player, epoch);
            if (amount == 0) continue;
            total += amount;
            epochs[count++] = epoch;
        }
        assembly ("memory-safe") {
            mstore(epochs, count)
        }
    }

    /// @notice Pays `player` everything that has vested in `epochs`, as LMS.
    /// @dev Open to anyone: the LMS only ever goes to `player`.
    function release(address player, uint256[] calldata epochs) external returns (uint256 amount) {
        for (uint256 i = 0; i < epochs.length; ++i) {
            uint256 due = releasable(player, epochs[i]);
            if (due == 0) continue;
            // Safe: at most the tranche's amount, a uint128.
            // forge-lint: disable-next-line(unsafe-typecast)
            trancheOf[player][epochs[i]].released += uint128(due);
            amount += due;
        }
        if (amount == 0) revert NothingToRelease();
        totalReleased += amount;
        lms.safeTransfer(player, amount);
        emit Released(player, msg.sender, amount, epochs);
    }
}
