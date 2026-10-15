// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {ProtocolConfig} from "./ProtocolConfig.sol";
import {PullPayable} from "./PullPayable.sol";
import {ZeroAddress} from "./Errors.sol";

/// @title AttestorBonds
/// @notice ETH bonds that make an attestor's signature cost something.
///
/// @dev Before this, the attestor set was an allowlist: a colluding quorum
///      could redirect a prize pool at no cost to itself. Now a signature only
///      counts towards the quorum while its signer is bonded, and a fraud proof
///      against a result takes the whole bond of every attestor who signed it.
///
///      **Timing.** An attestor stops counting the moment it asks to unbond, and
///      can withdraw only after `unbondDelay` plus the configured challenge
///      window. Any result it signed was therefore signed while bonded, and its
///      challenge window closes before the bond can leave.
///
///      **Why ETH.** A bond in the protocol's own token would be worth whatever
///      the people it is meant to restrain could make it worth. ETH they cannot.
///
///      Slashed bonds are split between the challenger, who did the work, and
///      `treasury`, and both collect through `PullPayable` like anyone else.
///      The treasury is set here rather than read from the config: the
///      config's treasury is wherever match fees go — `FeeRouter`, which only
///      accepts ETH from the escrow — and a slashed share credited there could
///      never be collected.
contract AttestorBonds is Ownable2Step, PullPayable {
    uint16 public constant BPS_DENOMINATOR = 10_000;

    ProtocolConfig public immutable config;

    /// @notice Bond an attestor must hold for its signature to count.
    uint256 public requiredBond;
    /// @notice Minimum wait between asking to unbond and withdrawing, before
    ///         the challenge window is added on top.
    uint64 public unbondDelay;
    /// @notice Share of a slashed bond paid to the challenger.
    uint16 public challengerBps;
    /// @notice Receives the rest of a slashed bond.
    address public treasury;

    /// @notice Contracts allowed to slash: the escrows that verify fraud proofs.
    mapping(address slasher => bool) public isSlasher;

    mapping(address attestor => uint256) public bondOf;
    /// @notice When an attestor may withdraw. Zero while it is not unbonding.
    mapping(address attestor => uint64) public unbondAt;

    event Bonded(address indexed attestor, address indexed payer, uint256 amount);
    event UnbondRequested(address indexed attestor, uint64 unbondAt);
    event Unbonded(address indexed attestor, uint256 amount);
    event Slashed(address indexed attestor, address indexed challenger, uint256 amount, uint256 reward);
    event RequiredBondUpdated(uint256 amount);
    event UnbondDelayUpdated(uint64 delay);
    event ChallengerBpsUpdated(uint16 bps);
    event SlasherUpdated(address indexed slasher, bool allowed);
    event TreasuryUpdated(address indexed previous, address indexed current);

    error NotSlasher(address caller);
    error NotUnbonding(address attestor);
    error StillUnbonding(uint64 unbondAt);
    error InvalidBps(uint16 bps);

    constructor(
        address owner_,
        ProtocolConfig config_,
        address treasury_,
        uint256 requiredBond_,
        uint64 unbondDelay_,
        uint16 challengerBps_
    ) Ownable(owner_) {
        if (address(config_) == address(0)) revert ZeroAddress();
        config = config_;
        _setTreasury(treasury_);
        _setRequiredBond(requiredBond_);
        _setUnbondDelay(unbondDelay_);
        _setChallengerBps(challengerBps_);
    }

    // ------------------------------------------------------------------ views

    /// @notice Whether `attestor`'s signature counts towards a quorum right now.
    function isActive(address attestor) external view returns (bool) {
        return config.isAttestor(attestor) && unbondAt[attestor] == 0 && bondOf[attestor] >= requiredBond
            && requiredBond > 0;
    }

    // -------------------------------------------------------------- attestors

    /// @notice Adds to `attestor`'s bond. Anyone may fund one; only the attestor
    ///         can withdraw it. Bonding again cancels a pending unbond.
    function bond(address attestor) external payable {
        if (attestor == address(0)) revert ZeroAddress();
        bondOf[attestor] += msg.value;
        if (unbondAt[attestor] != 0) unbondAt[attestor] = 0;
        emit Bonded(attestor, msg.sender, msg.value);
    }

    /// @notice Stops counting towards quorums at once and starts the exit clock.
    function requestUnbond() external {
        uint64 at = uint64(block.timestamp) + unbondDelay + config.challengeWindow();
        unbondAt[msg.sender] = at;
        emit UnbondRequested(msg.sender, at);
    }

    /// @notice Withdraws the caller's bond once the exit clock has run out.
    function unbond() external {
        uint64 at = unbondAt[msg.sender];
        if (at == 0) revert NotUnbonding(msg.sender);
        if (block.timestamp < at) revert StillUnbonding(at);

        uint256 amount = bondOf[msg.sender];
        bondOf[msg.sender] = 0;
        unbondAt[msg.sender] = 0;
        _credit(msg.sender, amount);
        emit Unbonded(msg.sender, amount);
    }

    // ---------------------------------------------------------------- slashing

    /// @notice Takes `attestor`'s whole bond after a successful fraud proof.
    /// @dev Pending unbonds do not protect a bond: it stays slashable until it
    ///      has actually been withdrawn.
    function slash(address attestor, address challenger) external returns (uint256 amount) {
        if (!isSlasher[msg.sender]) revert NotSlasher(msg.sender);
        amount = bondOf[attestor];
        if (amount == 0) return 0;

        bondOf[attestor] = 0;
        unbondAt[attestor] = 0;
        uint256 reward = (amount * challengerBps) / BPS_DENOMINATOR;
        if (reward > 0) _credit(challenger, reward);
        if (amount > reward) _credit(treasury, amount - reward);
        emit Slashed(attestor, challenger, amount, reward);
    }

    // -------------------------------------------------------------- governance

    function setSlasher(address slasher, bool allowed) external onlyOwner {
        if (slasher == address(0)) revert ZeroAddress();
        isSlasher[slasher] = allowed;
        emit SlasherUpdated(slasher, allowed);
    }

    /// @dev Raising it drops under-bonded attestors out of the quorum until they top up.
    function setRequiredBond(uint256 amount) external onlyOwner {
        _setRequiredBond(amount);
    }

    function setUnbondDelay(uint64 delay) external onlyOwner {
        _setUnbondDelay(delay);
    }

    function setChallengerBps(uint16 bps) external onlyOwner {
        _setChallengerBps(bps);
    }

    function setTreasury(address treasury_) external onlyOwner {
        _setTreasury(treasury_);
    }

    function _setTreasury(address treasury_) private {
        if (treasury_ == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, treasury_);
        treasury = treasury_;
    }

    function _setRequiredBond(uint256 amount) private {
        requiredBond = amount;
        emit RequiredBondUpdated(amount);
    }

    function _setUnbondDelay(uint64 delay) private {
        unbondDelay = delay;
        emit UnbondDelayUpdated(delay);
    }

    function _setChallengerBps(uint16 bps) private {
        if (bps > BPS_DENOMINATOR) revert InvalidBps(bps);
        challengerBps = bps;
        emit ChallengerBpsUpdated(bps);
    }
}
