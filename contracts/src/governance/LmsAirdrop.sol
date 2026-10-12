// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import {ZeroAddress} from "../Errors.sol";
import {StakedLms} from "./StakedLms.sol";

/// @title LmsAirdrop
/// @notice Distributes LMS to past players, in proportion to the protocol fees
///         each of them paid.
///
/// @dev The allocation is computed off-chain by `scripts/airdrop.mjs` from the
///      escrow's settled matches and committed here as a Merkle root, so a
///      claim costs one proof check no matter how many players there are.
///
///      Weighted by fees paid, not by matches played: a farmer who plays
///      against themselves pays the fee on every match, so farming only pays
///      if the airdrop is worth more than the fees. Keep it smaller than that.
///
///      Leaves follow OpenZeppelin's `StandardMerkleTree`:
///      `keccak256(bytes.concat(keccak256(abi.encode(account, amount))))`. The
///      double hash keeps a leaf from ever being read as an inner node.
///
///      `claim` pays the account itself, whoever submits it, so a relayer can
///      claim on a player's behalf without being able to redirect anything.
///      `claimAndStake` stakes straight into `StakedLms` for the caller, which
///      saves a player the approve-and-deposit round trip.
///
///      No owner. The Safe funds it with a plain transfer after deployment, and
///      whatever is unclaimed after `claimDeadline` can be swept, by anyone, to
///      `treasury` — the only place it can go.
contract LmsAirdrop {
    using SafeERC20 for IERC20;

    IERC20 public immutable lms;
    StakedLms public immutable vault;
    bytes32 public immutable merkleRoot;
    uint64 public immutable claimDeadline;
    address public immutable treasury;

    mapping(address account => bool) public claimed;

    event Claimed(address indexed account, uint256 amount, bool staked);
    event Swept(address indexed treasury, uint256 amount);

    error DeadlineInPast(uint64 deadline);
    error AlreadyClaimed(address account);
    error InvalidProof();
    error ClaimWindowClosed(uint64 deadline);
    error ClaimWindowOpen(uint64 deadline);

    constructor(
        IERC20 lms_,
        StakedLms vault_,
        bytes32 merkleRoot_,
        uint64 claimDeadline_,
        address treasury_
    ) {
        if (address(lms_) == address(0) || address(vault_) == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (claimDeadline_ <= block.timestamp) revert DeadlineInPast(claimDeadline_);
        lms = lms_;
        vault = vault_;
        merkleRoot = merkleRoot_;
        claimDeadline = claimDeadline_;
        treasury = treasury_;
    }

    /// @notice Pays `account` its allocation. Anyone may submit it.
    function claim(address account, uint256 amount, bytes32[] calldata proof) external {
        _consume(account, amount, proof);
        lms.safeTransfer(account, amount);
        emit Claimed(account, amount, false);
    }

    /// @notice Stakes the caller's allocation straight into `StakedLms`.
    /// @return shares sLMS minted to the caller.
    function claimAndStake(uint256 amount, bytes32[] calldata proof) external returns (uint256 shares) {
        _consume(msg.sender, amount, proof);
        lms.forceApprove(address(vault), amount);
        shares = vault.deposit(amount, msg.sender);
        emit Claimed(msg.sender, amount, true);
    }

    /// @notice Sends everything unclaimed to the treasury once the window has closed.
    function sweep() external returns (uint256 amount) {
        if (block.timestamp <= claimDeadline) revert ClaimWindowOpen(claimDeadline);
        amount = lms.balanceOf(address(this));
        lms.safeTransfer(treasury, amount);
        emit Swept(treasury, amount);
    }

    /// @notice Whether `proof` shows `account` is owed `amount`. Ignores whether it was claimed.
    function verify(address account, uint256 amount, bytes32[] calldata proof) public view returns (bool) {
        return MerkleProof.verifyCalldata(proof, merkleRoot, leaf(account, amount));
    }

    function leaf(address account, uint256 amount) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, amount))));
    }

    function _consume(address account, uint256 amount, bytes32[] calldata proof) private {
        if (block.timestamp > claimDeadline) revert ClaimWindowClosed(claimDeadline);
        if (claimed[account]) revert AlreadyClaimed(account);
        if (!verify(account, amount, proof)) revert InvalidProof();
        claimed[account] = true;
    }
}
