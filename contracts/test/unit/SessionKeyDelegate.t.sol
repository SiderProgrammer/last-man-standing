// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {SessionKeyDelegate} from "../../src/SessionKeyDelegate.sol";
import {PlayerAvatars} from "../../src/PlayerAvatars.sol";

/// @dev Stand-in for whatever the session key is allowed to call.
contract Target {
    uint256 public calls;
    uint256 public received;

    function ping() external payable {
        ++calls;
        received += msg.value;
    }

    function forbidden() external {
        ++calls;
    }

    function boom() external pure {
        revert("nope");
    }
}

contract SessionKeyDelegateTest is Test {
    SessionKeyDelegate private delegate;
    Target private target;

    uint256 private constant PLAYER_PK = 0xA11CE;
    uint256 private constant SESSION_PK = 0x5E5510;
    uint256 private constant STRANGER_PK = 0xBAD;

    address private player;
    address private sessionKey;

    uint48 private expiry;

    function setUp() public {
        delegate = new SessionKeyDelegate();
        target = new Target();

        player = vm.addr(PLAYER_PK);
        sessionKey = vm.addr(SESSION_PK);
        expiry = uint48(block.timestamp + 1 days);

        vm.deal(player, 10 ether);
        // The player delegates their EOA to this implementation, which is what
        // EIP-7702 does: same address, now with code.
        vm.signAndAttachDelegation(address(delegate), PLAYER_PK);
    }

    /// @dev Granting is a call the account makes to itself, which is the one
    ///      deliberate signature the whole design is built around.
    function _grant(uint128 spendCap) private {
        address[] memory targets = new address[](1);
        targets[0] = address(target);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = Target.ping.selector;

        vm.prank(player);
        SessionKeyDelegate(payable(player)).grantSession(sessionKey, expiry, spendCap, targets, selectors);
    }

    function _sign(uint256 pk, address to, uint256 value, bytes memory data)
        private
        view
        returns (bytes memory)
    {
        uint256 nonce = SessionKeyDelegate(payable(player)).sessionNonce();
        bytes32 digest = SessionKeyDelegate(payable(player)).callDigest(to, value, data, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_DelegationGivesTheEoaCodeWithoutChangingItsAddress() public view {
        assertGt(player.code.length, 0);
        assertEq(player, vm.addr(PLAYER_PK));
    }

    /// @dev Regression: delegating gives the EOA code, and `_safeMint` rejects
    ///      any account with code that lacks `onERC721Received`. One-click play
    ///      used to lock a player out of minting an avatar for good.
    function test_DelegatedAccountCanStillMintAnAvatar() public {
        PlayerAvatars avatars = new PlayerAvatars(address(this), "LMS Avatars", "LMSA", 100, "ipfs://x/");

        vm.prank(player);
        uint256 tokenId = avatars.mint();
        assertEq(avatars.ownerOf(tokenId), player);
    }

    function test_SessionKeyCanMintAnAvatarForTheAccount() public {
        PlayerAvatars avatars = new PlayerAvatars(address(this), "LMS Avatars", "LMSA", 100, "ipfs://x/");
        address[] memory targets = new address[](1);
        targets[0] = address(avatars);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = PlayerAvatars.mint.selector;
        vm.prank(player);
        SessionKeyDelegate(payable(player)).grantSession(sessionKey, expiry, 0, targets, selectors);

        bytes memory data = abi.encodeCall(PlayerAvatars.mint, ());
        bytes memory signature = _sign(SESSION_PK, address(avatars), 0, data);
        SessionKeyDelegate(payable(player)).executeWithSession(address(avatars), 0, data, 0, signature);

        assertTrue(avatars.hasMinted(player));
    }

    function test_GrantSessionStoresTheScope() public {
        _grant(1 ether);

        (uint48 validUntil, uint128 spendCap, uint128 spent) =
            SessionKeyDelegate(payable(player)).sessions(sessionKey);
        assertEq(validUntil, expiry);
        assertEq(spendCap, 1 ether);
        assertEq(spent, 0);
        assertTrue(SessionKeyDelegate(payable(player)).sessionActive(sessionKey));
    }

    /// @dev The whole security boundary: nobody but the account grants itself keys.
    function test_OnlyTheAccountCanGrantASession() public {
        address[] memory targets = new address[](0);
        bytes4[] memory selectors = new bytes4[](0);

        vm.prank(sessionKey);
        vm.expectRevert(abi.encodeWithSelector(SessionKeyDelegate.NotSelf.selector, sessionKey));
        SessionKeyDelegate(payable(player)).grantSession(sessionKey, expiry, 0, targets, selectors);
    }

    function test_RejectsASessionThatNeverExpires() public {
        address[] memory targets = new address[](0);
        bytes4[] memory selectors = new bytes4[](0);

        vm.prank(player);
        vm.expectRevert(SessionKeyDelegate.InvalidSession.selector);
        SessionKeyDelegate(payable(player)).grantSession(sessionKey, 0, 0, targets, selectors);
    }

    function test_RejectsMismatchedPermissionArrays() public {
        address[] memory targets = new address[](2);
        bytes4[] memory selectors = new bytes4[](1);

        vm.prank(player);
        vm.expectRevert(SessionKeyDelegate.InvalidSession.selector);
        SessionKeyDelegate(payable(player)).grantSession(sessionKey, expiry, 0, targets, selectors);
    }

    // --- Relayed execution -------------------------------------------------

    function test_AnyoneMayRelayACallTheSessionKeySigned() public {
        _grant(1 ether);
        bytes memory data = abi.encodeCall(Target.ping, ());
        bytes memory signature = _sign(SESSION_PK, address(target), 0, data);

        // A relayer with no relationship to the player submits it: the
        // signature is the authority, which is what removes the wallet prompt.
        vm.prank(address(0xDEFEC8));
        SessionKeyDelegate(payable(player)).executeWithSession(address(target), 0, data, 0, signature);

        assertEq(target.calls(), 1);
        assertEq(SessionKeyDelegate(payable(player)).sessionNonce(), 1);
    }

    function test_ValueComesFromTheAccountAndCountsAgainstTheCap() public {
        _grant(1 ether);
        bytes memory data = abi.encodeCall(Target.ping, ());
        bytes memory signature = _sign(SESSION_PK, address(target), 0.4 ether, data);

        SessionKeyDelegate(payable(player)).executeWithSession(address(target), 0.4 ether, data, 0, signature);

        assertEq(target.received(), 0.4 ether);
        assertEq(player.balance, 9.6 ether);

        (,, uint128 spent) = SessionKeyDelegate(payable(player)).sessions(sessionKey);
        assertEq(spent, 0.4 ether);
    }

    /// @dev A leaked session key must not be able to drain the account.
    function test_SpendCapIsCumulativeAcrossCalls() public {
        _grant(0.5 ether);
        bytes memory data = abi.encodeCall(Target.ping, ());

        bytes memory first = _sign(SESSION_PK, address(target), 0.3 ether, data);
        SessionKeyDelegate(payable(player)).executeWithSession(address(target), 0.3 ether, data, 0, first);

        bytes memory second = _sign(SESSION_PK, address(target), 0.3 ether, data);
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionKeyDelegate.SpendCapExceeded.selector, sessionKey, 0.3 ether, 0.2 ether
            )
        );
        SessionKeyDelegate(payable(player)).executeWithSession(address(target), 0.3 ether, data, 1, second);
    }

    function test_RejectsACallOutsideTheAllowlist() public {
        _grant(1 ether);
        bytes memory data = abi.encodeCall(Target.forbidden, ());
        bytes memory signature = _sign(SESSION_PK, address(target), 0, data);

        vm.expectRevert(
            abi.encodeWithSelector(
                SessionKeyDelegate.SessionNotPermitted.selector,
                sessionKey,
                address(target),
                Target.forbidden.selector
            )
        );
        SessionKeyDelegate(payable(player)).executeWithSession(address(target), 0, data, 0, signature);
    }

    function test_RejectsAPermittedSelectorOnAnUnpermittedTarget() public {
        _grant(1 ether);
        Target other = new Target();
        bytes memory data = abi.encodeCall(Target.ping, ());
        bytes memory signature = _sign(SESSION_PK, address(other), 0, data);

        vm.expectRevert(
            abi.encodeWithSelector(
                SessionKeyDelegate.SessionNotPermitted.selector,
                sessionKey,
                address(other),
                Target.ping.selector
            )
        );
        SessionKeyDelegate(payable(player)).executeWithSession(address(other), 0, data, 0, signature);
    }

    function test_RejectsASignatureFromAKeyWithNoSession() public {
        _grant(1 ether);
        bytes memory data = abi.encodeCall(Target.ping, ());
        bytes memory signature = _sign(STRANGER_PK, address(target), 0, data);

        vm.expectRevert(
            abi.encodeWithSelector(SessionKeyDelegate.SessionExpired.selector, vm.addr(STRANGER_PK))
        );
        SessionKeyDelegate(payable(player)).executeWithSession(address(target), 0, data, 0, signature);
    }

    function test_RejectsAnExpiredSession() public {
        _grant(1 ether);
        bytes memory data = abi.encodeCall(Target.ping, ());
        bytes memory signature = _sign(SESSION_PK, address(target), 0, data);

        vm.warp(expiry + 1);
        vm.expectRevert(abi.encodeWithSelector(SessionKeyDelegate.SessionExpired.selector, sessionKey));
        SessionKeyDelegate(payable(player)).executeWithSession(address(target), 0, data, 0, signature);
    }

    function test_RevokedSessionStopsWorkingImmediately() public {
        _grant(1 ether);
        bytes memory data = abi.encodeCall(Target.ping, ());
        bytes memory signature = _sign(SESSION_PK, address(target), 0, data);

        vm.prank(player);
        SessionKeyDelegate(payable(player)).revokeSession(sessionKey);

        assertFalse(SessionKeyDelegate(payable(player)).sessionActive(sessionKey));
        vm.expectRevert(abi.encodeWithSelector(SessionKeyDelegate.SessionExpired.selector, sessionKey));
        SessionKeyDelegate(payable(player)).executeWithSession(address(target), 0, data, 0, signature);
    }

    /// @dev A relayer that replays a submitted call must not get a second execution.
    function test_ASignatureCannotBeReplayed() public {
        _grant(1 ether);
        bytes memory data = abi.encodeCall(Target.ping, ());
        bytes memory signature = _sign(SESSION_PK, address(target), 0, data);

        SessionKeyDelegate(payable(player)).executeWithSession(address(target), 0, data, 0, signature);

        vm.expectRevert(abi.encodeWithSelector(SessionKeyDelegate.BadNonce.selector, 1, 0));
        SessionKeyDelegate(payable(player)).executeWithSession(address(target), 0, data, 0, signature);
    }

    function test_RegrantingResetsTheSpentAmountRatherThanAccumulating() public {
        _grant(0.5 ether);
        bytes memory data = abi.encodeCall(Target.ping, ());
        bytes memory signature = _sign(SESSION_PK, address(target), 0.4 ether, data);
        SessionKeyDelegate(payable(player)).executeWithSession(address(target), 0.4 ether, data, 0, signature);

        _grant(0.5 ether);

        (, uint128 spendCap, uint128 spent) = SessionKeyDelegate(payable(player)).sessions(sessionKey);
        assertEq(spendCap, 0.5 ether);
        assertEq(spent, 0);
    }

    function test_BubblesUpTheTargetsRevert() public {
        address[] memory targets = new address[](1);
        targets[0] = address(target);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = Target.boom.selector;
        vm.prank(player);
        SessionKeyDelegate(payable(player)).grantSession(sessionKey, expiry, 0, targets, selectors);

        bytes memory data = abi.encodeCall(Target.boom, ());
        bytes memory signature = _sign(SESSION_PK, address(target), 0, data);

        vm.expectRevert();
        SessionKeyDelegate(payable(player)).executeWithSession(address(target), 0, data, 0, signature);
    }

    // --- ERC-1271, which is how the game server accepts a session login ----

    function test_AcceptsALoginSignedByALiveSessionKey() public {
        _grant(0);
        bytes32 hash = keccak256("Last Man Standing login\nnonce:abc123");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_PK, hash);

        assertEq(
            SessionKeyDelegate(payable(player)).isValidSignature(hash, abi.encodePacked(r, s, v)),
            bytes4(0x1626ba7e)
        );
    }

    /// @dev Under 7702 the account never stops being an EOA, so its own key
    ///      must keep working — otherwise a player who clears their browser
    ///      could not log in at all.
    function test_AcceptsALoginSignedByTheAccountsOwnKey() public view {
        bytes32 hash = keccak256("Last Man Standing login\nnonce:abc123");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PLAYER_PK, hash);

        assertEq(
            SessionKeyDelegate(payable(player)).isValidSignature(hash, abi.encodePacked(r, s, v)),
            bytes4(0x1626ba7e)
        );
    }

    function test_RejectsALoginFromAStranger() public view {
        bytes32 hash = keccak256("Last Man Standing login\nnonce:abc123");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(STRANGER_PK, hash);

        assertEq(
            SessionKeyDelegate(payable(player)).isValidSignature(hash, abi.encodePacked(r, s, v)),
            bytes4(0xffffffff)
        );
    }

    function test_RejectsALoginFromAnExpiredSessionKey() public {
        _grant(0);
        bytes32 hash = keccak256("Last Man Standing login\nnonce:abc123");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_PK, hash);

        vm.warp(expiry + 1);
        assertEq(
            SessionKeyDelegate(payable(player)).isValidSignature(hash, abi.encodePacked(r, s, v)),
            bytes4(0xffffffff)
        );
    }

    function test_RejectsAMalformedSignatureWithoutReverting() public view {
        bytes32 hash = keccak256("Last Man Standing login\nnonce:abc123");

        assertEq(SessionKeyDelegate(payable(player)).isValidSignature(hash, hex"1234"), bytes4(0xffffffff));
    }

    /**
     * Frozen vector, pinned against `sessionCallDigest` in
     * `packages/protocol/test/session.test.ts`. A drift between the two would
     * not corrupt a match, but every relayed call would fail to recover the
     * session key and players would silently lose prompt-free play.
     */
    function test_CallDigestMatchesTheFrozenVector() public {
        address account = address(0xA1);
        vm.chainId(11155111);
        vm.etch(account, address(delegate).code);

        bytes32 digest = SessionKeyDelegate(payable(account))
            .callDigest(address(0xB2), 1_000_000_000_000_000, hex"deadbeef", 7);

        assertEq(digest, 0xa23e142a5be00813755910b17a5ea68658ea7c7c86e8aec3db159ad4bcf4a476);
    }

    /// @dev Regression: permissions used to outlive the grant that wrote them,
    ///      so re-granting a key with a narrower scope kept the wider one.
    function test_RegrantingWithANarrowerScopeDropsTheOldSelectors() public {
        address[] memory targets = new address[](2);
        targets[0] = address(target);
        targets[1] = address(target);
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = Target.ping.selector;
        selectors[1] = Target.forbidden.selector;
        vm.prank(player);
        SessionKeyDelegate(payable(player)).grantSession(sessionKey, expiry, 1 ether, targets, selectors);
        assertTrue(SessionKeyDelegate(payable(player)).permitted(sessionKey, address(target), Target.forbidden.selector));

        vm.prank(player);
        SessionKeyDelegate(payable(player)).revokeSession(sessionKey);
        _grant(1 ether);

        assertTrue(SessionKeyDelegate(payable(player)).permitted(sessionKey, address(target), Target.ping.selector));
        assertFalse(SessionKeyDelegate(payable(player)).permitted(sessionKey, address(target), Target.forbidden.selector));

        bytes memory data = abi.encodeCall(Target.forbidden, ());
        bytes memory signature = _sign(SESSION_PK, address(target), 0, data);
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionKeyDelegate.SessionNotPermitted.selector,
                sessionKey,
                address(target),
                Target.forbidden.selector
            )
        );
        SessionKeyDelegate(payable(player)).executeWithSession(address(target), 0, data, 0, signature);
    }

    /// @dev The account's low slots belong to whatever else the player may
    ///      delegate to one day; this delegate keeps to its ERC-7201 namespace.
    function test_StateLivesOnlyInTheNamespace() public {
        _grant(1 ether);
        bytes memory data = abi.encodeCall(Target.ping, ());
        bytes memory signature = _sign(SESSION_PK, address(target), 0.1 ether, data);
        SessionKeyDelegate(payable(player)).executeWithSession(address(target), 0.1 ether, data, 0, signature);

        for (uint256 slot = 0; slot < 8; ++slot) {
            assertEq(vm.load(player, bytes32(slot)), bytes32(0));
        }
        bytes32 root = 0x07ec1a45952760d8fb956aaf940b8ff509e88f045ea2d46fbee2898cc08df400;
        assertEq(
            root,
            keccak256(abi.encode(uint256(keccak256("lms.session.v1")) - 1)) & ~bytes32(uint256(0xff))
        );
        // `nonce` is the fourth member of the layout.
        assertEq(uint256(vm.load(player, bytes32(uint256(root) + 3))), 1);
    }
}
