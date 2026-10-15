// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";

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
///
///      Token receiver hooks. Delegating gives the EOA code, and a token that
///      transfers "safely" — `PlayerAvatars.mint` uses `_safeMint` — calls
///      `onERC721Received` on any address with code and reverts without it.
///      Without these hooks, turning on one-click play would stop a player from
///      ever minting an avatar or receiving a safe-transferred NFT again. A
///      plain EOA accepts everything, so the delegated one does too.
contract SessionKeyDelegate is IERC1271, IERC721Receiver, IERC1155Receiver {
    using ECDSA for bytes32;

    struct Session {
        /// @dev Unix seconds. Zero means no session: there is no "never expires".
        uint48 validUntil;
        /// @dev Cumulative native value this key may move, in wei.
        uint128 spendCap;
        uint128 spent;
    }

    /// @dev Everything this delegate stores, at one ERC-7201 namespace.
    ///
    ///      Under 7702 the storage is the player's own account, not this
    ///      contract's. Plain slots 0, 1, 2 would be shared with any other
    ///      delegate the player ever points their account at — a different
    ///      wallet's implementation would read our session table as its own
    ///      state. A namespaced root keeps the two layouts apart.
    ///
    /// @custom:storage-location erc7201:lms.session.v1
    struct Layout {
        mapping(address sessionKey => Session) sessions;
        /// @dev Bumped on every grant, so each grant starts from an empty
        ///      allowlist. Permissions are keyed by it, and the ones written
        ///      under an earlier epoch are simply never read again.
        mapping(address sessionKey => uint32) epochOf;
        mapping(
            address sessionKey
                => mapping(uint32 epoch => mapping(address target => mapping(bytes4 selector => bool)))
        ) permitted;
        /// @dev Replay protection for relayed calls, per account.
        uint256 nonce;
    }

    /// @dev `keccak256(abi.encode(uint256(keccak256("lms.session.v1")) - 1)) & ~bytes32(uint256(0xff))`
    bytes32 private constant LAYOUT_SLOT = 0x07ec1a45952760d8fb956aaf940b8ff509e88f045ea2d46fbee2898cc08df400;

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
    /// @dev Replaces any earlier grant to the same key outright: the spend
    ///      allowance restarts at zero and the allowlist is exactly `targets` ×
    ///      `selectors`. Narrowing a key's scope by re-granting it therefore
    ///      works, instead of silently keeping every call granted before.
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

        Layout storage $ = _layout();
        $.sessions[sessionKey] = Session({validUntil: validUntil, spendCap: spendCap, spent: 0});
        uint32 epoch = ++$.epochOf[sessionKey];
        for (uint256 i = 0; i < targets.length; ++i) {
            $.permitted[sessionKey][epoch][targets[i]][selectors[i]] = true;
        }

        emit SessionGranted(sessionKey, validUntil, spendCap);
    }

    /// @notice Ends a session immediately.
    /// @dev The allowlist needs no clearing: it is inert without a live
    ///      session, and the next grant starts a fresh epoch anyway.
    function revokeSession(address sessionKey) external onlySelf {
        delete _layout().sessions[sessionKey];
        emit SessionRevoked(sessionKey);
    }

    /// @notice A session's expiry and spend, by key.
    function sessions(address sessionKey)
        external
        view
        returns (uint48 validUntil, uint128 spendCap, uint128 spent)
    {
        Session memory session = _layout().sessions[sessionKey];
        return (session.validUntil, session.spendCap, session.spent);
    }

    /// @notice Whether the key's current grant may call `selector` on `target`.
    function permitted(address sessionKey, address target, bytes4 selector) public view returns (bool) {
        Layout storage $ = _layout();
        return $.permitted[sessionKey][$.epochOf[sessionKey]][target][selector];
    }

    /// @notice Nonce the next relayed call must carry.
    function sessionNonce() external view returns (uint256) {
        return _layout().nonce;
    }

    /// @notice True while `sessionKey` may still act for this account.
    function sessionActive(address sessionKey) public view returns (bool) {
        return _layout().sessions[sessionKey].validUntil > block.timestamp;
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
        Layout storage $ = _layout();
        if (nonce != $.nonce) revert BadNonce($.nonce, nonce);

        bytes32 digest =
            _hashTypedData(keccak256(abi.encode(CALL_TYPEHASH, target, value, keccak256(data), nonce)));
        address sessionKey = digest.recover(signature);

        Session storage session = $.sessions[sessionKey];
        if (session.validUntil <= block.timestamp) revert SessionExpired(sessionKey);

        // An empty calldata payload is a plain transfer; it has no selector, and
        // the zero selector is what such a permission must be granted against.
        bytes4 selector = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
        if (!permitted(sessionKey, target, selector)) {
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
            ++$.nonce;
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

    function _layout() private pure returns (Layout storage $) {
        assembly {
            $.slot := LAYOUT_SLOT
        }
    }

    /// @dev The account must be able to receive the payouts it wins.
    receive() external payable {}

    // --- Token receiver hooks ----------------------------------------------

    /// @inheritdoc IERC721Receiver
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @inheritdoc IERC1155Receiver
    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    /// @inheritdoc IERC1155Receiver
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IERC721Receiver).interfaceId
            || interfaceId == type(IERC1155Receiver).interfaceId || interfaceId == type(IERC1271).interfaceId;
    }
}
