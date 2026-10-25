// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {NothingToWithdraw, ZeroAddress} from "../Errors.sol";
import {IFeeLedger} from "../interfaces/IFeeLedger.sol";
import {StakedLms} from "./StakedLms.sol";

/// @title RewardsDistributor
/// @notice Play-mining: hands out the players' share of the LMS supply in
///         proportion to the fees they paid, already staked as sLMS.
///
/// @dev Runs on-chain end to end. `GameEscrow` keeps two running totals per
///      fee epoch — what each player paid and what everyone paid — and this
///      contract turns them into LMS. No server computes anything, no root is
///      posted, nobody has to be trusted with the arithmetic.
///
///      **Budget.** The program runs `PROGRAM_EPOCHS` epochs (four years of
///      weeks) from `firstEpoch`. Each epoch has a fixed budget, which drops by
///      a quarter every year; the four years together add up to `totalBudget`.
///
///      **Rate.** An epoch's budget is split by fees paid: a player who paid
///      1% of the epoch's fees gets 1% of its budget. That makes farming
///      self-defeating — every extra fee a farmer pays lowers what each fee
///      earns, and the fees themselves are real ETH that goes to stakers and
///      the treasury. In a quiet epoch the split alone would hand the whole
///      budget to whoever paid the little there was, so the rate is also
///      capped at `maxRewardPerEth`. What the cap leaves unpaid stays here.
///
///      **When.** An epoch can be claimed as soon as it ends. The escrow counts
///      a fee in the epoch its match *settles* in — only a settled match pays
///      its fee — so an ended epoch's totals never change again, and every
///      player's share of it is final. The rate is fixed by the first claim,
///      so a later change to the cap cannot treat two claimants of one epoch
///      differently. Each claim is a share of the epoch's fees times a rate
///      of at most budget / fees, so the claims of an epoch add up to at most
///      its budget.
///
///      **Paid as sLMS.** Rewards are deposited into `StakedLms` for the
///      player, never sent as LMS. They vote straight away, and selling them
///      takes the unstake cooldown first.
///
///      Claims close `CLAIM_WINDOW` after the program's last epoch can be
///      claimed. Only then may governance sweep what is left — the cap's
///      leftovers and whatever nobody claimed.
contract RewardsDistributor is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 public constant EPOCHS_PER_YEAR = 52;
    uint256 public constant PROGRAM_YEARS = 4;
    uint256 public constant PROGRAM_EPOCHS = EPOCHS_PER_YEAR * PROGRAM_YEARS;
    uint256 public constant CLAIM_WINDOW = 365 days;
    /// @dev Scale of a rate: LMS wei per wei of fees, times 1e18. A rate of
    ///      `100_000e18` is 100,000 LMS for every ETH paid in fees.
    uint256 private constant RATE_SCALE = 1e18;

    struct Rate {
        bool fixed_;
        uint248 value;
    }

    IFeeLedger public immutable escrow;
    IERC20 public immutable lms;
    StakedLms public immutable vault;
    /// @notice First epoch of the program.
    uint256 public immutable firstEpoch;
    /// @notice Budget of each epoch in the program's first year, in LMS wei.
    uint256 public immutable firstYearEpochBudget;
    /// @notice Length of an epoch, as the escrow counts them.
    uint256 public immutable epochLength;

    /// @notice Most LMS one ETH of fees can earn, scaled by 1e18. Applies to
    ///         epochs whose rate is not fixed yet.
    uint256 public maxRewardPerEth;

    mapping(uint256 epoch => Rate) private rates;
    /// @dev One bit per epoch: bit `e % 256` of word `e / 256`.
    mapping(address player => mapping(uint256 word => uint256 bits)) private claimedBits;

    event RateFixed(uint256 indexed epoch, uint256 epochFees, uint256 budget, uint256 rate);
    event RewardsClaimed(address indexed player, address indexed caller, uint256 amount, uint256[] epochs);
    event MaxRewardPerEthUpdated(uint256 previous, uint256 current);
    event Swept(address indexed to, uint256 amount);

    error MaxRewardPerEthTooHigh(uint256 maxRewardPerEth);
    error EpochNotClaimable(uint256 epoch);
    error AlreadyClaimed(uint256 epoch);
    error NothingToClaim();
    error ClaimsClosed();
    error ClaimsStillOpen(uint256 closesAt);

    /// @param totalBudget_ LMS the program pays out at most, in wei. The
    ///        contract must hold this much; `Deploy` funds it in the same run.
    constructor(
        IFeeLedger escrow_,
        StakedLms vault_,
        address owner_,
        uint256 firstEpoch_,
        uint256 totalBudget_,
        uint256 maxRewardPerEth_
    ) Ownable(owner_) {
        if (address(escrow_) == address(0) || address(vault_) == address(0)) revert ZeroAddress();

        escrow = escrow_;
        vault = vault_;
        lms = IERC20(vault_.asset());
        epochLength = escrow_.FEE_EPOCH();
        firstEpoch = firstEpoch_;
        // Year y pays (3/4)^y of the first year's rate, so the four years sum
        // to 52 * (1 + 3/4 + 9/16 + 27/64) = 52 * 175/64 first-year epochs.
        firstYearEpochBudget = (totalBudget_ * 64) / (EPOCHS_PER_YEAR * 175);
        _setMaxRewardPerEth(maxRewardPerEth_);

        lms.forceApprove(address(vault_), type(uint256).max);
    }

    // ------------------------------------------------------------------- budget

    /// @notice LMS budget of `epoch`, in wei. Zero outside the program.
    function epochBudget(uint256 epoch) public view returns (uint256) {
        if (epoch < firstEpoch || epoch >= firstEpoch + PROGRAM_EPOCHS) return 0;
        uint256 year = (epoch - firstEpoch) / EPOCHS_PER_YEAR;
        return (firstYearEpochBudget * 3 ** year) / 4 ** year;
    }

    /// @notice Every epoch's budget added up: the most the program can pay.
    function totalBudget() public view returns (uint256 total) {
        for (uint256 year = 0; year < PROGRAM_YEARS; ++year) {
            total += EPOCHS_PER_YEAR * epochBudget(firstEpoch + year * EPOCHS_PER_YEAR);
        }
    }

    /// @notice When `epoch` can first be claimed: the moment it ends.
    function claimableFrom(uint256 epoch) public view returns (uint256) {
        return (epoch + 1) * epochLength;
    }

    /// @notice When claims close for good, and governance may sweep the rest.
    function claimsCloseAt() public view returns (uint256) {
        return claimableFrom(firstEpoch + PROGRAM_EPOCHS - 1) + CLAIM_WINDOW;
    }

    /// @notice What one wei of fees paid in `epoch` earns, scaled by 1e18: the
    ///         fixed rate once there is one, otherwise what it would be now.
    function rateOf(uint256 epoch) public view returns (uint256 rate, bool fixed_) {
        Rate memory stored = rates[epoch];
        if (stored.fixed_) return (stored.value, true);
        return (_currentRate(epoch), false);
    }

    function isClaimed(address player, uint256 epoch) public view returns (bool) {
        return claimedBits[player][epoch >> 8] & (1 << (epoch & 0xff)) != 0;
    }

    // ------------------------------------------------------------------- claims

    /// @notice Pays `player` their rewards for `epochs`, staked as sLMS.
    /// @dev Open to anyone: the reward can only ever go to `player`, as sLMS,
    ///      so claiming for someone else just pays their gas. Epochs with no
    ///      fees paid are skipped, and stay unclaimed.
    function claim(address player, uint256[] calldata epochs) external nonReentrant returns (uint256 reward) {
        if (block.timestamp >= claimsCloseAt()) revert ClaimsClosed();

        for (uint256 i = 0; i < epochs.length; ++i) {
            uint256 epoch = epochs[i];
            if (block.timestamp < claimableFrom(epoch)) revert EpochNotClaimable(epoch);
            if (isClaimed(player, epoch)) revert AlreadyClaimed(epoch);

            uint256 paid = escrow.feesPaid(player, epoch);
            if (paid == 0) continue;

            claimedBits[player][epoch >> 8] |= 1 << (epoch & 0xff);
            reward += Math.mulDiv(paid, _fixRate(epoch), RATE_SCALE);
        }
        if (reward == 0) revert NothingToClaim();

        vault.deposit(reward, player);
        emit RewardsClaimed(player, msg.sender, reward, epochs);
    }

    /// @notice What `player` could claim now across `fromEpoch..toEpoch`
    ///         inclusive, and which of those epochs it comes from.
    /// @dev A view for the client, meant for `eth_call`: it loops over the
    ///      whole range.
    function claimable(address player, uint256 fromEpoch, uint256 toEpoch)
        external
        view
        returns (uint256 total, uint256[] memory epochs)
    {
        if (toEpoch < fromEpoch || block.timestamp >= claimsCloseAt()) return (0, new uint256[](0));

        epochs = new uint256[](toEpoch - fromEpoch + 1);
        uint256 count;
        for (uint256 epoch = fromEpoch; epoch <= toEpoch; ++epoch) {
            if (block.timestamp < claimableFrom(epoch) || isClaimed(player, epoch)) continue;
            uint256 paid = escrow.feesPaid(player, epoch);
            if (paid == 0) continue;
            (uint256 rate,) = rateOf(epoch);
            uint256 reward = Math.mulDiv(paid, rate, RATE_SCALE);
            if (reward == 0) continue;
            total += reward;
            epochs[count++] = epoch;
        }
        assembly ("memory-safe") {
            mstore(epochs, count)
        }
    }

    function _currentRate(uint256 epoch) private view returns (uint256) {
        uint256 fees = escrow.epochFees(epoch);
        if (fees == 0) return 0;
        return Math.min(Math.mulDiv(epochBudget(epoch), RATE_SCALE, fees), maxRewardPerEth);
    }

    /// @dev The epoch's rate, fixing it on first use.
    function _fixRate(uint256 epoch) private returns (uint256) {
        Rate memory stored = rates[epoch];
        if (stored.fixed_) return stored.value;

        uint256 rate = _currentRate(epoch);
        // Safe: at most `maxRewardPerEth`, which is checked to fit.
        // forge-lint: disable-next-line(unsafe-typecast)
        rates[epoch] = Rate({fixed_: true, value: uint248(rate)});
        emit RateFixed(epoch, escrow.epochFees(epoch), epochBudget(epoch), rate);
        return rate;
    }

    // --------------------------------------------------------------- governance

    /// @notice Changes the cap on LMS per ETH of fees, for epochs whose rate
    ///         is not fixed yet.
    function setMaxRewardPerEth(uint256 maxRewardPerEth_) external onlyOwner {
        _setMaxRewardPerEth(maxRewardPerEth_);
    }

    /// @notice Sends what is left to `to`, once claims have closed.
    function sweep(address to) external onlyOwner returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        uint256 closesAt = claimsCloseAt();
        if (block.timestamp < closesAt) revert ClaimsStillOpen(closesAt);
        amount = lms.balanceOf(address(this));
        if (amount == 0) revert NothingToWithdraw();
        lms.safeTransfer(to, amount);
        emit Swept(to, amount);
    }

    function _setMaxRewardPerEth(uint256 maxRewardPerEth_) private {
        if (maxRewardPerEth_ > type(uint248).max) revert MaxRewardPerEthTooHigh(maxRewardPerEth_);
        emit MaxRewardPerEthUpdated(maxRewardPerEth, maxRewardPerEth_);
        maxRewardPerEth = maxRewardPerEth_;
    }
}
