// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Time} from "@openzeppelin/contracts/utils/types/Time.sol";

/// @title StakedLms
/// @notice Stake LMS, receive sLMS. sLMS is the governance voting token, and
///         it earns the stakers' share of protocol fees.
///
/// @dev One action, three effects:
///
///        - **Votes.** sLMS is `ERC20Votes`; plain LMS has no votes at all, so
///          only staked tokens govern. Every account that receives sLMS is
///          self-delegated on receipt unless it already chose a delegate, so
///          staking is enough to vote.
///        - **Earns.** An ERC-4626 vault over LMS. `FeeRouter` buys LMS with
///          protocol fees and transfers it in, which raises `totalAssets`
///          without minting shares: each sLMS redeems for more LMS over time.
///          Nothing to claim, and nothing to compound.
///        - **Commits.** Leaving takes `cooldown`. `requestUnstake` burns the
///          shares at once — so they stop voting and stop earning — and locks
///          the LMS they were worth at that moment; `claim` pays it out once
///          the cooldown has passed. A voter is therefore still exposed when
///          the proposal they voted for executes, which is what slashing would
///          otherwise be for. `Deploy` checks that `cooldown` outlasts the
///          voting period plus the timelock delay.
///
///      Locking the price at request time is deliberate: fees that arrive
///      during the cooldown go to the stakers who stayed, so cycling in and
///      out around a buyback earns nothing.
///
///      The standard ERC-4626 `withdraw` and `redeem` are disabled — the spec's
///      way of doing that is `maxWithdraw`/`maxRedeem` returning zero, which
///      makes both revert. `deposit` and `mint` work as usual.
///
///      The clock is a timestamp, so the governor's delays read in seconds and
///      behave the same on every chain regardless of block time.
///
///      Inflation attack: the first depositor could donate LMS to skew the
///      share price against the next one. `Deploy` seeds the vault with a
///      permanently locked stake before anyone else can deposit.
contract StakedLms is ERC4626, ERC20Votes, Ownable2Step {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @notice LMS on its way out of the vault.
    struct Unstake {
        /// @dev Fixed when requested. Earns nothing further.
        uint128 assets;
        uint64 unlockAt;
    }

    uint64 public constant MIN_COOLDOWN = 1 days;
    uint64 public constant MAX_COOLDOWN = 30 days;

    /// @notice Seconds between `requestUnstake` and `claim`.
    uint64 public cooldown;

    /// @notice LMS held for pending unstakes. Not part of `totalAssets`.
    uint256 public totalUnstaking;

    mapping(address account => Unstake) public unstakeOf;

    event UnstakeRequested(address indexed account, uint256 shares, uint256 assets, uint64 unlockAt);
    event UnstakeClaimed(address indexed account, address indexed receiver, uint256 assets);
    event CooldownUpdated(uint64 previous, uint64 current);

    error CooldownOutOfRange(uint64 cooldown);
    error ZeroShares();
    error NothingToClaim();
    error StillCoolingDown(uint64 unlockAt);

    constructor(IERC20 lms, address owner_, uint64 cooldown_)
        ERC20("Staked LMS", "sLMS")
        ERC4626(lms)
        EIP712("Staked LMS", "1")
        Ownable(owner_)
    {
        _setCooldown(cooldown_);
    }

    // ------------------------------------------------------------------ deposit

    /// @notice `deposit`, with the allowance granted by an EIP-2612 signature
    ///         instead of a separate `approve` transaction.
    /// @dev The permit is attempted, not required: anyone who sees the
    ///      signature in the mempool can submit it first, which consumes the
    ///      nonce and would make a strict `permit` revert. The allowance then
    ///      exists anyway, and `deposit` goes through on it; if it does not,
    ///      `deposit` reverts with the token's own allowance error.
    function depositWithPermit(
        uint256 assets,
        address receiver,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 shares) {
        try IERC20Permit(asset()).permit(msg.sender, address(this), assets, deadline, v, r, s) {} catch {}
        return deposit(assets, receiver);
    }

    // ------------------------------------------------------------------ unstake

    /// @notice Starts leaving: burns `shares` now and locks the LMS they are worth.
    /// @dev A second request adds to the first and restarts the cooldown for
    ///      the whole amount. One queue per account keeps `claim` trivial, at
    ///      the price of not being able to stagger exits.
    /// @return assets LMS claimable once the cooldown has passed.
    function requestUnstake(uint256 shares) external returns (uint256 assets) {
        if (shares == 0) revert ZeroShares();

        // Before the burn: the price is the one these shares were worth.
        assets = previewRedeem(shares);
        _burn(msg.sender, shares);
        totalUnstaking += assets;

        Unstake storage pending = unstakeOf[msg.sender];
        pending.assets += assets.toUint128();
        uint64 unlockAt = uint64(block.timestamp) + cooldown;
        pending.unlockAt = unlockAt;

        emit UnstakeRequested(msg.sender, shares, assets, unlockAt);
    }

    /// @notice Pays out the caller's unstaked LMS once the cooldown has passed.
    function claim(address receiver) external returns (uint256 assets) {
        Unstake memory pending = unstakeOf[msg.sender];
        if (pending.assets == 0) revert NothingToClaim();
        if (block.timestamp < pending.unlockAt) revert StillCoolingDown(pending.unlockAt);

        delete unstakeOf[msg.sender];
        assets = pending.assets;
        totalUnstaking -= assets;
        IERC20(asset()).safeTransfer(receiver, assets);

        emit UnstakeClaimed(msg.sender, receiver, assets);
    }

    // --------------------------------------------------------------- governance

    /// @notice Changes the cooldown for future requests. Pending ones keep theirs.
    function setCooldown(uint64 cooldown_) external onlyOwner {
        _setCooldown(cooldown_);
    }

    function _setCooldown(uint64 cooldown_) private {
        if (cooldown_ < MIN_COOLDOWN || cooldown_ > MAX_COOLDOWN) revert CooldownOutOfRange(cooldown_);
        emit CooldownUpdated(cooldown, cooldown_);
        cooldown = cooldown_;
    }

    // ------------------------------------------------------------------- ERC4626

    /// @dev Everything the vault holds except what is already promised to
    ///      accounts that are leaving. Fee buybacks land here.
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) - totalUnstaking;
    }

    /// @dev Disabled: leave through `requestUnstake`.
    function maxWithdraw(address) public pure override returns (uint256) {
        return 0;
    }

    /// @dev Disabled: leave through `requestUnstake`.
    function maxRedeem(address) public pure override returns (uint256) {
        return 0;
    }

    function decimals() public view override(ERC20, ERC4626) returns (uint8) {
        return super.decimals();
    }

    // ------------------------------------------------------------------ ERC20Votes

    function clock() public view override returns (uint48) {
        return Time.timestamp();
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    /// @dev Self-delegates any account that receives sLMS without having
    ///      chosen a delegate, so staking alone is enough to vote. After the
    ///      transfer, so the delegation moves the full new balance.
    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
        if (to != address(0) && delegates(to) == address(0)) _delegate(to, to);
    }
}
