// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";

import {GameEscrow} from "./GameEscrow.sol";
import {PullPayable} from "./PullPayable.sol";

/// @title SessionKeyDelegate
/// @notice EIP-7702 delegate for one-click play: a browser-held key may join
///         lobbies and collect winnings for the account, within caps, with a
///         relayer paying the gas.
///
/// @dev Why 7702 rather than a 4337 smart account: in this protocol the address
///      *is* the identity. `GameEscrow` keys seats, rankings and payouts by the
///      address that staked, and a player's match history is their address.
///      A 7702 delegation keeps the exact same address and merely gives it code.
///
///      The account signs one EIP-7702 authorization pointing at this contract
///      and, in the same transaction, calls `grantSession` on itself. From then
///      on the session key signs calls that anyone may submit, so the player
///      sees no prompt and pays no gas for a join. The stake itself always
///      comes from the account's own balance.
///
///      Storage lives in the delegating account, not here: under 7702 this code
///      runs with the EOA as `address(this)`, so every mapping below is
///      per-account. This contract is deployed once per chain and holds nothing.
///
///      Scope is fixed in code rather than granted, because a session key that
///      can be pointed at anything is the account key with extra steps:
///        * calls  — `join(matchId)` and `withdrawFor(account)` on `escrow`, and
///                   nothing else. `withdrawFor` only ever pays the account, so
///                   a leaked key can stake the player's ETH into lobbies but
///                   never send it anywhere;
///        * value  — a cap per call and a cap in total, both set at grant;
///        * time   — every session expires, within `MAX_SESSION_DURATION`.
///
///      Logins are not this contract's business. The game server checks an
///      off-chain grant the wallet signed, and `isValidSignature` answers for
///      the account's own key only: a session key never speaks for the account
///      off-chain, where no cap could bound what it signs.
///
///      Token receiver hooks. Delegating gives the EOA code, and a token that
///      transfers "safely" — `PlayerAvatars.mint` uses `_safeMint` — calls
///      `onERC721Received` on any address with code and reverts without it.
///      A plain EOA accepts everything, so the delegated one does too.
contract SessionKeyDelegate is IERC1271, IERC721Receiver, IERC1155Receiver {
    using ECDSA for bytes32;

    struct Session {
        /// @dev Unix seconds. Zero means no session: there is no "never expires".
        uint48 validUntil;
        /// @dev Most native value one call may move, in wei.
        uint128 valueCap;
        /// @dev Cumulative native value this key may move, in wei.
        uint128 spendCap;
        uint128 spent;
    }

    /// @dev Everything this delegate stores, at one ERC-7201 namespace.
    ///
    ///      Under 7702 the storage is the player's own account, not this
    ///      contract's. Plain slots 0, 1, 2 would be shared with any other
    ///      delegate the player ever points their account at. A namespaced
    ///      root keeps the two layouts apart; v2 because the v1 layout held an
    ///      allowlist this version does not, and must never read.
    ///
    /// @custom:storage-location erc7201:lms.session.v2
    struct Layout {
        mapping(address sessionKey => Session) sessions;
        /// @dev Replay protection for relayed calls, per account.
        uint256 nonce;
    }

    /// @dev `keccak256(abi.encode(uint256(keccak256("lms.session.v2")) - 1)) & ~bytes32(uint256(0xff))`
    bytes32 private constant LAYOUT_SLOT = 0x4aa0ea22fecb5f5d36f8a5cc47e8eb04e47337348195f5e74cf0d206fc2d2300;

    /// @notice The longest a session may run. A leaked key is worth no more than this.
    uint256 public constant MAX_SESSION_DURATION = 7 days;

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
    bytes32 private constant DOMAIN_VERSION = keccak256("2");

    /// @notice The one contract a session key may call.
    /// @dev An immutable lives in the code, so it reads the same from every
    ///      delegating account. A new escrow means a new delegate, and a
    ///      player re-delegates to use it.
    GameEscrow public immutable escrow;

    event SessionGranted(address indexed sessionKey, uint48 validUntil, uint128 valueCap, uint128 spendCap);
    event SessionRevoked(address indexed sessionKey);
    event SessionCallExecuted(address indexed sessionKey, bytes4 indexed selector, uint256 value);

    error NotSelf(address caller);
    error SessionExpired(address sessionKey);
    error SessionNotPermitted(address target, bytes4 selector);
    error ValueCapExceeded(uint256 value, uint128 valueCap);
    error SpendCapExceeded(address sessionKey, uint256 attempted, uint128 remaining);
    error BadNonce(uint256 expected, uint256 supplied);
    error CallFailed(address target, bytes reason);
    error InvalidSession();

    constructor(GameEscrow escrow_) {
        if (address(escrow_) == address(0)) revert InvalidSession();
        escrow = escrow_;
    }

    /// @dev Only the account itself. Under 7702 that means a transaction the
    ///      player signed with their own key, addressed to their own address —
    ///      so granting a session always costs exactly one deliberate signature.
    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf(msg.sender);
        _;
    }

    /// @notice Grants a session key, replacing any earlier grant to it.
    /// @dev The spend restarts at zero.
    /// @param sessionKey Address of the key the client will hold.
    /// @param validUntil Expiry, in unix seconds: in the future, and within
    ///        `MAX_SESSION_DURATION`.
    /// @param valueCap Most native value one call may move, in wei.
    /// @param spendCap Cumulative native value the key may move, in wei.
    function grantSession(address sessionKey, uint48 validUntil, uint128 valueCap, uint128 spendCap)
        external
        onlySelf
    {
        if (sessionKey == address(0) || sessionKey == address(this)) revert InvalidSession();
        if (validUntil <= block.timestamp || validUntil > block.timestamp + MAX_SESSION_DURATION) {
            revert InvalidSession();
        }
        if (valueCap > spendCap) revert InvalidSession();

        _layout().sessions[sessionKey] =
            Session({validUntil: validUntil, valueCap: valueCap, spendCap: spendCap, spent: 0});
        emit SessionGranted(sessionKey, validUntil, valueCap, spendCap);
    }

    /// @notice Ends a session immediately.
    function revokeSession(address sessionKey) external onlySelf {
        delete _layout().sessions[sessionKey];
        emit SessionRevoked(sessionKey);
    }

    /// @notice A session's expiry, caps and spend, by key.
    function sessions(address sessionKey)
        external
        view
        returns (uint48 validUntil, uint128 valueCap, uint128 spendCap, uint128 spent)
    {
        Session memory session = _layout().sessions[sessionKey];
        return (session.validUntil, session.valueCap, session.spendCap, session.spent);
    }

    /// @notice Nonce the next relayed call must carry.
    function sessionNonce() external view returns (uint256) {
        return _layout().nonce;
    }

    /// @notice True while `sessionKey` may still act for this account.
    function sessionActive(address sessionKey) public view returns (bool) {
        return _layout().sessions[sessionKey].validUntil > block.timestamp;
    }

    /// @notice Executes one escrow call authorised by a session key.
    /// @dev Permissionless to submit: the signature is the authority, so any
    ///      relayer can pay the gas. Not payable: the value comes from the
    ///      account's balance, never from whoever submits.
    /// @param target Must be `escrow`. Signed, so the key says what it meant.
    /// @param data `join(matchId)`, or `withdrawFor(account)` naming this account.
    function executeWithSession(
        address target,
        uint256 value,
        bytes calldata data,
        uint256 nonce,
        bytes calldata signature
    ) external returns (bytes memory result) {
        Layout storage $ = _layout();
        if (nonce != $.nonce) revert BadNonce($.nonce, nonce);

        address sessionKey = _callDigest(target, value, data, nonce).recover(signature);
        Session storage session = $.sessions[sessionKey];
        if (session.validUntil <= block.timestamp) revert SessionExpired(sessionKey);

        bytes4 selector = _checkCall(target, value, data);
        _spend(session, sessionKey, value);

        // Effects before interaction: the nonce advances first, so a target that
        // re-enters cannot replay this same authorisation.
        unchecked {
            ++$.nonce;
        }

        bool ok;
        (ok, result) = target.call{value: value}(data);
        if (!ok) revert CallFailed(target, result);

        emit SessionCallExecuted(sessionKey, selector, value);
    }

    /// @inheritdoc IERC1271
    /// @dev The account's own key only. The game server checks a contract
    ///      wallet's session grant through here; a delegated EOA's grant
    ///      recovers to the account offline and never needs to ask.
    function isValidSignature(bytes32 hash, bytes memory signature) external view override returns (bytes4) {
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecover(hash, signature);
        if (error != ECDSA.RecoverError.NoError) return ERC1271_INVALID;
        return signer == address(this) ? ERC1271_MAGIC : ERC1271_INVALID;
    }

    /// @notice The digest a session key must sign to authorise a call.
    /// @dev Exposed so a client can build the signature without reimplementing
    ///      the domain, and so tests assert against the contract's own view.
    function callDigest(address target, uint256 value, bytes calldata data, uint256 nonce)
        external
        view
        returns (bytes32)
    {
        return _callDigest(target, value, data, nonce);
    }

    function _callDigest(address target, uint256 value, bytes calldata data, uint256 nonce)
        private
        view
        returns (bytes32)
    {
        return _hashTypedData(keccak256(abi.encode(CALL_TYPEHASH, target, value, keccak256(data), nonce)));
    }

    /// @dev Counts `value` against both caps, or reverts.
    function _spend(Session storage session, address sessionKey, uint256 value) private {
        if (value > session.valueCap) revert ValueCapExceeded(value, session.valueCap);
        uint128 remaining = session.spendCap - session.spent;
        if (value > remaining) revert SpendCapExceeded(sessionKey, value, remaining);
        // Safe: `value <= remaining <= spendCap`, both uint128.
        // forge-lint: disable-next-line(unsafe-typecast)
        session.spent += uint128(value);
    }

    /// @dev The whole scope of a session key. Reverts unless the call is one
    ///      of the two it may make, with arguments that keep the value with
    ///      the account. Returns the selector.
    function _checkCall(address target, uint256 value, bytes calldata data)
        private
        view
        returns (bytes4 selector)
    {
        if (data.length >= 4) selector = bytes4(data[:4]);
        if (target != address(escrow)) revert SessionNotPermitted(target, selector);
        // Exactly one word of arguments: no trailing bytes for a future
        // overload, or a lenient decoder, to read differently.
        if (data.length != 36) revert SessionNotPermitted(target, selector);

        if (selector == GameEscrow.join.selector) return selector;
        if (selector == PullPayable.withdrawFor.selector) {
            if (value != 0 || abi.decode(data[4:], (address)) != address(this)) {
                revert SessionNotPermitted(target, selector);
            }
            return selector;
        }
        revert SessionNotPermitted(target, selector);
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
