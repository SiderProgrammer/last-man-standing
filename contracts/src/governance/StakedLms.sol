// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Time} from "@openzeppelin/contracts/utils/types/Time.sol";

import {NothingToWithdraw, TransferFailed, ZeroAddress} from "../Errors.sol";

/// @title StakedLms
/// @notice Stake LMS, receive sLMS one for one. sLMS is the governance voting
///         token, and it earns the stakers' share of protocol fees, paid in ETH.
///
/// @dev A plain wrapper, in the style of OpenZeppelin's `ERC20Wrapper`, not an
///      ERC-4626 vault: one sLMS is always one LMS, so there is no exchange
///      rate, no share maths and no `withdraw`/`redeem` that only revert. The
///      surface is what staking does: `deposit`, `requestUnstake`, `claim`.
///
///      One action, three effects:
///
///        - **Votes.** sLMS is `ERC20Votes`; plain LMS has no votes at all, so
///          only staked tokens govern. Every account that receives sLMS is
///          self-delegated on receipt unless it already chose a delegate, so
///          staking is enough to vote.
///        - **Earns.** `FeeRouter` sends the stakers' share of every fee here
///          as ETH, through `depositRewards`. It is not handed out at once:
///          it is paid out evenly over the next `rewardDuration`, and each
///          second of that goes to whoever is staked during it, pro rata.
///          Each staker collects theirs with `claimRewards`.
///        - **Commits.** Leaving takes `cooldown`. `requestUnstake` burns the
///          sLMS at once — so it stops voting and stops earning — and
///          `claim` returns the LMS once the cooldown has passed. A voter is
///          therefore still exposed when the proposal they voted for executes,
///          which is what slashing would otherwise be for. `Deploy` checks that
///          `cooldown` outlasts the voting period plus the timelock delay.
///
///      Rewards are streamed, Synthetix-style. Paying a harvest out the moment
///      it arrived would let anyone stake, call the permissionless `harvest`
///      and take a full share of every fee since the last one, in a single
///      transaction: being staked for a week would earn no more than being
///      staked for a second. Instead each deposit, plus whatever of the last
///      one is still unpaid, is spread over a fresh `rewardDuration`, so a
///      late staker earns only for the time they are actually staked.
///
///      The accumulator is the usual one: `rewardPerShare` only ever grows,
///      each account remembers the value it was last settled at, and the
///      difference times its balance is what it has earned since. `_accrue`
///      brings it up to date before anything changes, and settling happens
///      in `_update`, before any balance moves, so a mint, burn or transfer
///      can never carry rewards earned by someone else. While nothing is
///      staked the stream pauses — its end moves out by the time that passed
///      — so ETH that arrives with no stakers waits for the first ones rather
///      than being lost.
///
///      Anyone may deposit rewards, and every deposit restarts the period.
///      That can never take anything from stakers, only slow the payout down:
///      someone depositing dust every block turns the straight-line payout of
///      the remainder into a decay with the same time constant, at their own
///      gas.
///
///      The LMS backing sLMS is `totalSupply`; with `totalUnstaking` that is
///      everything owed. LMS sent here directly is neither, and governance can
///      sweep it.
///
///      The clock is a timestamp, so the governor's delays read in seconds and
///      behave the same on every chain regardless of block time.
contract StakedLms is ERC20Votes, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @notice LMS on its way out of the vault.
    struct Unstake {
        uint128 assets;
        uint64 unlockAt;
    }

    uint64 public constant MIN_COOLDOWN = 1 days;
    uint64 public constant MAX_COOLDOWN = 30 days;
    uint64 public constant MIN_REWARD_DURATION = 1 hours;
    uint64 public constant MAX_REWARD_DURATION = 30 days;
    /// @dev Fixed-point scale of `rewardPerShare` and `rewardRate`. Large
    ///      enough that a fee of a few gwei still registers against the whole
    ///      supply staked.
    uint256 private constant PRECISION = 1e27;

    /// @notice The token staked: LMS.
    IERC20 private immutable _underlying;
    /// @notice Seconds each reward deposit is paid out over.
    uint64 public immutable rewardDuration;

    /// @notice Seconds between `requestUnstake` and `claim`.
    uint64 public cooldown;
    /// @notice When the reward stream runs dry, if nothing more arrives.
    uint64 public periodFinish;
    /// @notice When `rewardPerShare` was last brought up to date.
    uint64 public lastAccrual;

    /// @notice LMS held for pending unstakes.
    uint256 public totalUnstaking;
    mapping(address account => Unstake) public unstakeOf;

    /// @notice ETH paid out per second while the stream runs, scaled by 1e27.
    uint256 public rewardRate;
    /// @dev ETH earned per sLMS up to `lastAccrual`, scaled by 1e27. Read it
    ///      through `rewardPerShare`, which adds what has accrued since.
    uint256 private rewardPerShareStored;
    /// @dev `rewardPerShare` when each account was last settled.
    mapping(address account => uint256) private settledAt;
    /// @dev ETH settled to each account and not yet claimed.
    mapping(address account => uint256) private owed;

    event Staked(address indexed from, address indexed account, uint256 amount);
    event UnstakeRequested(address indexed account, uint256 amount, uint64 unlockAt);
    event UnstakeClaimed(address indexed account, address indexed receiver, uint256 amount);
    event CooldownUpdated(uint64 previous, uint64 current);
    event RewardsDeposited(address indexed from, uint256 amount, uint256 rewardRate, uint64 periodFinish);
    event RewardsClaimed(address indexed account, address indexed to, uint256 amount);
    event StraySwept(address indexed to, uint256 amount);

    error CooldownOutOfRange(uint64 cooldown);
    error RewardDurationOutOfRange(uint64 rewardDuration);
    error ZeroAmount();
    error NothingToClaim();
    error StillCoolingDown(uint64 unlockAt);

    constructor(IERC20 lms, address owner_, uint64 cooldown_, uint64 rewardDuration_)
        ERC20("Staked LMS", "sLMS")
        EIP712("Staked LMS", "1")
        Ownable(owner_)
    {
        if (address(lms) == address(0)) revert ZeroAddress();
        _underlying = lms;
        if (rewardDuration_ < MIN_REWARD_DURATION || rewardDuration_ > MAX_REWARD_DURATION) {
            revert RewardDurationOutOfRange(rewardDuration_);
        }
        rewardDuration = rewardDuration_;
        _setCooldown(cooldown_);
    }

    // ------------------------------------------------------------------ deposit

    /// @notice The token staked: LMS.
    function underlying() public view returns (IERC20) {
        return _underlying;
    }

    /// @notice Stakes `amount` of the caller's LMS for the caller.
    function deposit(uint256 amount) external {
        _deposit(msg.sender, amount);
    }

    /// @notice Stakes `amount` of the caller's LMS for `account`: the sLMS,
    ///         its votes and its rewards are `account`'s.
    function depositFor(address account, uint256 amount) external {
        _deposit(account, amount);
    }

    /// @notice `deposit`, with the allowance granted by an EIP-2612 signature
    ///         instead of a separate `approve` transaction.
    /// @dev The permit is attempted, not required: anyone who sees the
    ///      signature in the mempool can submit it first, which consumes the
    ///      nonce and would make a strict `permit` revert. The allowance then
    ///      exists anyway, and the deposit goes through on it; if it does not,
    ///      the deposit reverts with the token's own allowance error.
    function depositWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        try IERC20Permit(address(_underlying)).permit(msg.sender, address(this), amount, deadline, v, r, s) {}
            catch {}
        _deposit(msg.sender, amount);
    }

    function _deposit(address account, uint256 amount) private {
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _underlying.safeTransferFrom(msg.sender, address(this), amount);
        _mint(account, amount);
        emit Staked(msg.sender, account, amount);
    }

    // ------------------------------------------------------------------ rewards

    /// @notice Adds `msg.value` to the reward stream: it and whatever is still
    ///         unpaid are paid out evenly over the next `rewardDuration`.
    /// @dev Open to anyone: `FeeRouter` calls it with every harvest, but a
    ///      donation to stakers is a donation to stakers.
    function depositRewards() external payable {
        _accrue();
        uint64 now_ = uint64(block.timestamp);
        uint64 finish = periodFinish;
        uint256 unpaid = now_ < finish ? (uint256(finish - now_) * rewardRate) / PRECISION : 0;

        uint256 rate = Math.mulDiv(msg.value + unpaid, PRECISION, rewardDuration);
        finish = now_ + rewardDuration;
        rewardRate = rate;
        lastAccrual = now_;
        periodFinish = finish;
        emit RewardsDeposited(msg.sender, msg.value, rate, finish);
    }

    /// @notice ETH earned per sLMS since deployment, scaled by 1e27, up to now.
    function rewardPerShare() public view returns (uint256) {
        uint64 last = lastAccrual;
        uint64 finish = periodFinish;
        uint256 supply = totalSupply();
        if (last >= finish || supply == 0) return rewardPerShareStored;
        uint64 until = uint64(block.timestamp) < finish ? uint64(block.timestamp) : finish;
        return rewardPerShareStored + (uint256(until - last) * rewardRate) / supply;
    }

    /// @notice ETH `account` can claim now.
    function earned(address account) public view returns (uint256) {
        return
            owed[account] + Math.mulDiv(balanceOf(account), rewardPerShare() - settledAt[account], PRECISION);
    }

    /// @notice Pays the caller's earned ETH to `to`.
    function claimRewards(address to) external nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        _accrue();
        _settle(msg.sender);
        amount = owed[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        owed[msg.sender] = 0;

        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed(to, amount);
        emit RewardsClaimed(msg.sender, to, amount);
    }

    /// @dev Brings `rewardPerShareStored` up to now. With nothing staked the
    ///      stream pauses instead: its end moves out by the time that passed,
    ///      so what it still holds waits for the next staker.
    function _accrue() private {
        uint64 last = lastAccrual;
        uint64 finish = periodFinish;
        if (last >= finish) return;

        uint64 now_ = uint64(block.timestamp);
        if (now_ == last) return;
        uint256 supply = totalSupply();
        if (supply == 0) {
            periodFinish = finish + (now_ - last);
            lastAccrual = now_;
            return;
        }
        uint64 until = now_ < finish ? now_ : finish;
        rewardPerShareStored += (uint256(until - last) * rewardRate) / supply;
        lastAccrual = until;
    }

    /// @dev Credits `account` with what it earned since it was last settled.
    ///      Reads `rewardPerShareStored`, so `_accrue` must have run first.
    function _settle(address account) private {
        uint256 current = rewardPerShareStored;
        uint256 last = settledAt[account];
        if (current == last) return;
        owed[account] += Math.mulDiv(balanceOf(account), current - last, PRECISION);
        settledAt[account] = current;
    }

    // ------------------------------------------------------------------ unstake

    /// @notice Starts leaving: burns `amount` sLMS now and returns the LMS
    ///         after the cooldown.
    /// @dev A second request adds to the first and restarts the cooldown for
    ///      the whole amount. One queue per account keeps `claim` trivial, at
    ///      the price of not being able to stagger exits. Rewards earned up to
    ///      this moment stay claimable; the cooldown earns nothing.
    /// @return unlockAt When `claim` will pay it.
    function requestUnstake(uint256 amount) external returns (uint64 unlockAt) {
        if (amount == 0) revert ZeroAmount();

        _burn(msg.sender, amount);
        totalUnstaking += amount;

        Unstake storage pending = unstakeOf[msg.sender];
        pending.assets += amount.toUint128();
        unlockAt = uint64(block.timestamp) + cooldown;
        pending.unlockAt = unlockAt;

        emit UnstakeRequested(msg.sender, amount, unlockAt);
    }

    /// @notice Pays out the caller's unstaked LMS once the cooldown has passed.
    function claim(address receiver) external returns (uint256 amount) {
        if (receiver == address(0)) revert ZeroAddress();
        Unstake memory pending = unstakeOf[msg.sender];
        if (pending.assets == 0) revert NothingToClaim();
        if (block.timestamp < pending.unlockAt) revert StillCoolingDown(pending.unlockAt);

        delete unstakeOf[msg.sender];
        amount = pending.assets;
        totalUnstaking -= amount;
        _underlying.safeTransfer(receiver, amount);

        emit UnstakeClaimed(msg.sender, receiver, amount);
    }

    // --------------------------------------------------------------- governance

    /// @notice Changes the cooldown for future requests. Pending ones keep theirs.
    function setCooldown(uint64 cooldown_) external onlyOwner {
        _setCooldown(cooldown_);
    }

    /// @notice Sends LMS that arrived without being staked — a mistaken
    ///         transfer — to `to`. Staked and unstaking LMS cannot be touched.
    function sweepStray(address to) external onlyOwner returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = _underlying.balanceOf(address(this)) - totalSupply() - totalUnstaking;
        if (amount == 0) revert NothingToWithdraw();
        _underlying.safeTransfer(to, amount);
        emit StraySwept(to, amount);
    }

    function _setCooldown(uint64 cooldown_) private {
        if (cooldown_ < MIN_COOLDOWN || cooldown_ > MAX_COOLDOWN) revert CooldownOutOfRange(cooldown_);
        emit CooldownUpdated(cooldown, cooldown_);
        cooldown = cooldown_;
    }

    // ------------------------------------------------------------------ ERC20Votes

    function clock() public view override returns (uint48) {
        return Time.timestamp();
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    /// @dev Accrues against the supply as it was, and settles rewards for both
    ///      sides, before any balance moves; then self-delegates a receiver
    ///      that has not chosen a delegate, so staking alone is enough to vote.
    function _update(address from, address to, uint256 value) internal override {
        _accrue();
        if (from != address(0)) _settle(from);
        if (to != address(0)) _settle(to);
        super._update(from, to, value);
        if (to != address(0) && delegates(to) == address(0)) _delegate(to, to);
    }
}
