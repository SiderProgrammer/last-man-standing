// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @title SessionKeyDelegate
/// @notice EIP-7702 delegate that lets a player grant a scoped, expiring key.
///
/// @dev Why 7702 rather than a 4337 smart account: in this protocol the address
///      *is* the identity. `GameEscrow` keys seats, rankings and payouts by the
///      address that staked, and a player's match history is their address.
///      Moving players onto freshly deployed contract accounts would rewrite
///      that identity and leave every existing seat behind. A 7702 delegation
///      keeps the exact same address and merely gives it code.
///
///      The account signs one EIP-7702 authorization pointing at this contract
///      and, in the same transaction, calls `grantSession` on itself. From then
///      on a session key held by the browser can log in and act within its
///      scope without another wallet prompt — which is the entire point, since
///      the login nonce alone otherwise costs a signature on every reconnect.
///
///      Storage lives in the delegating account, not here: under 7702 this code
///      runs with the EOA as `address(this)`, so every mapping below is
///      per-account. This contract is deployed once per chain and holds nothing.
///
///      Scope is enforced on three axes, because a session key that can do
///      anything is just the account key with extra steps:
///        * time    — every session expires, and there is no way to grant one that does not;
///        * value   — a cumulative native-token cap, so a leaked key cannot drain the account;
///        * calls   — an explicit (target, selector) allowlist, so a key scoped to
///                    joining matches cannot be used to move an avatar NFT.
contract SessionKeyDelegate is IERC1271 {
    using ECDSA for bytes32;

    struct Session {
        /// @dev Unix seconds. Zero means no session: there is no "never expires".
        uint48 validUntil;
        /// @dev Cumulative native value this key may move, in wei.
        uint128 spendCap;
        uint128 spent;
    }

    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 private constant ERC1271_INVALID = 0xffffffff;

    /// @dev EIP-712 type hash for a relayed call. The account and chain id are
    ///      in the domain, so a signature cannot be replayed onto another
    ///      account or another chain.
    bytes32 private constant CALL_TYPEHASH =
        keccak256("SessionCall(address target,uint256 value,bytes data,uint256 nonce)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant DOMAIN_NAME = keccak256("LastManStandingSession");
    bytes32 private constant DOMAIN_VERSION = keccak256("1");

    mapping(address sessionKey => Session) public sessions;
    /// @notice Calls a session key is allowed to make, by target and selector.
    mapping(address sessionKey => mapping(address target => mapping(bytes4 selector => bool))) public
        permitted;
    /// @notice Replay protection for relayed calls, per account.
    uint256 public sessionNonce;

    event SessionGranted(address indexed sessionKey, uint48 validUntil, uint128 spendCap);
    event SessionRevoked(address indexed sessionKey);
    event SessionCallExecuted(address indexed sessionKey, address indexed target, uint256 value);

    error NotSelf(address caller);
    error SessionExpired(address sessionKey);
    error SessionNotPermitted(address sessionKey, address target, bytes4 selector);
    error SpendCapExceeded(address sessionKey, uint256 attempted, uint128 remaining);
    error BadNonce(uint256 expected, uint256 supplied);
    error CallFailed(address target, bytes reason);
    error InvalidSession();

    /// @dev Only the account itself. Under 7702 that means a transaction the
    ///      player signed with their own key, addressed to their own address —
    ///      so granting a session always costs exactly one deliberate signature.
    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf(msg.sender);
        _;
    }

    /// @notice Grants a scoped, expiring session key.
    /// @param sessionKey Address of the key the client will hold.
    /// @param validUntil Expiry, in unix seconds. Must be in the future.
    /// @param spendCap Cumulative native value the key may move, in wei.
    /// @param targets Contracts the key may call, paired positionally with `selectors`.
    /// @param selectors Function selectors the key may call on those contracts.
    function grantSession(
        address sessionKey,
        uint48 validUntil,
        uint128 spendCap,
        address[] calldata targets,
        bytes4[] calldata selectors
    ) external onlySelf {
        if (sessionKey == address(0)) revert InvalidSession();
        if (validUntil <= block.timestamp) revert InvalidSession();
        if (targets.length != selectors.length) revert InvalidSession();

        // Reset rather than merge: re-granting an existing key must not
        // accumulate a spend allowance the player did not intend to give twice.
        sessions[sessionKey] = Session({validUntil: validUntil, spendCap: spendCap, spent: 0});
        for (uint256 i = 0; i < targets.length; ++i) {
            permitted[sessionKey][targets[i]][selectors[i]] = true;
        }

        emit SessionGranted(sessionKey, validUntil, spendCap);
    }

    /// @notice Ends a session immediately.
    /// @dev Deliberately leaves the permission entries in place: they are inert
    ///      without a live session, and clearing them would cost an unbounded
    ///      loop over a list this contract never stored.
    function revokeSession(address sessionKey) external onlySelf {
        delete sessions[sessionKey];
        emit SessionRevoked(sessionKey);
    }

    /// @notice True while `sessionKey` may still act for this account.
    function sessionActive(address sessionKey) public view returns (bool) {
        return sessions[sessionKey].validUntil > block.timestamp;
    }

    /// @notice Executes one call authorised by a session key.
    /// @dev Permissionless to submit: the signature is the authority, so any
    ///      relayer — the game server, a bundler, the player themselves — can
    ///      pay the gas. That is what removes the wallet prompt.
    function executeWithSession(
        address target,
        uint256 value,
        bytes calldata data,
        uint256 nonce,
        bytes calldata signature
    ) external payable returns (bytes memory result) {
        if (nonce != sessionNonce) revert BadNonce(sessionNonce, nonce);

        bytes32 digest =
            _hashTypedData(keccak256(abi.encode(CALL_TYPEHASH, target, value, keccak256(data), nonce)));
        address sessionKey = digest.recover(signature);

        Session storage session = sessions[sessionKey];
        if (session.validUntil <= block.timestamp) revert SessionExpired(sessionKey);

        // An empty calldata payload is a plain transfer; it has no selector, and
        // the zero selector is what such a permission must be granted against.
        bytes4 selector = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
        if (!permitted[sessionKey][target][selector]) {
            revert SessionNotPermitted(sessionKey, target, selector);
        }

        if (value > 0) {
            uint128 remaining = session.spendCap - session.spent;
            if (value > remaining) revert SpendCapExceeded(sessionKey, value, remaining);
            // Safe: `value <= remaining <= spendCap`, both uint128.
            // forge-lint: disable-next-line(unsafe-typecast)
            session.spent += uint128(value);
        }

        // Effects before interaction: the nonce advances first, so a target that
        // re-enters cannot replay this same authorisation.
        unchecked {
            ++sessionNonce;
        }

        bool ok;
        (ok, result) = target.call{value: value}(data);
        if (!ok) revert CallFailed(target, result);

        emit SessionCallExecuted(sessionKey, target, value);
    }

    /// @inheritdoc IERC1271
    /// @dev This is what lets the game server accept a login signed by the
    ///      session key: the gateway verifies against the *account*, and the
    ///      account answers that the session key spoke for it. Both the root
    ///      key and any live session key are valid signers — the root key
    ///      because the account never stops being an EOA under 7702.
    function isValidSignature(bytes32 hash, bytes memory signature) external view override returns (bytes4) {
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecover(hash, signature);
        if (error != ECDSA.RecoverError.NoError) return ERC1271_INVALID;
        if (signer == address(this)) return ERC1271_MAGIC;
        return sessionActive(signer) ? ERC1271_MAGIC : ERC1271_INVALID;
    }

    /// @notice The digest a session key must sign to authorise a call.
    /// @dev Exposed so a client can build the signature without reimplementing
    ///      the domain, and so tests assert against the contract's own view.
    function callDigest(address target, uint256 value, bytes calldata data, uint256 nonce)
        external
        view
        returns (bytes32)
    {
        return _hashTypedData(keccak256(abi.encode(CALL_TYPEHASH, target, value, keccak256(data), nonce)));
    }

    /// @dev Built per call rather than cached in an immutable: under 7702 this
    ///      code is shared by every delegating account, so a separator fixed at
    ///      deployment would name this contract instead of the account.
    function _hashTypedData(bytes32 structHash) private view returns (bytes32) {
        bytes32 domainSeparator =
            keccak256(abi.encode(DOMAIN_TYPEHASH, DOMAIN_NAME, DOMAIN_VERSION, block.chainid, address(this)));
        return MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
    }

    /// @dev The account must be able to receive the payouts it wins.
    receive() external payable {}
}
