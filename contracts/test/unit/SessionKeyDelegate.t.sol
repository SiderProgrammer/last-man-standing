// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SessionKeyDelegate} from "../../src/SessionKeyDelegate.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {PullPayable} from "../../src/PullPayable.sol";
import {PlayerAvatars} from "../../src/PlayerAvatars.sol";
import {UnknownMatch} from "../../src/Errors.sol";
import {Fixtures} from "../helpers/Fixtures.sol";

contract SessionKeyDelegateTest is Fixtures {
    SessionKeyDelegate private delegate;

    uint256 private constant PLAYER_PK = 0xA11CE5;
    uint256 private constant SESSION_PK = 0x5E5510;
    uint256 private constant STRANGER_PK = 0xBAD;

    address private player;
    address private sessionKey;
    address private relayer;

    uint48 private expiry;

    function setUp() public override {
        super.setUp();
        delegate = new SessionKeyDelegate(escrow);

        player = vm.addr(PLAYER_PK);
        sessionKey = vm.addr(SESSION_PK);
        relayer = makeAddr("relayer");
        expiry = uint48(block.timestamp + 1 days);

        vm.deal(player, 10 ether);
        // The player delegates their EOA to this implementation, which is what
        // EIP-7702 does: same address, now with code.
        vm.signAndAttachDelegation(address(delegate), PLAYER_PK);
    }

    function _account() private view returns (SessionKeyDelegate) {
        return SessionKeyDelegate(payable(player));
    }

    /// @dev Granting is a call the account makes to itself, which is the one
    ///      deliberate signature the whole design is built around.
    function _grant(uint128 valueCap, uint128 spendCap) private {
        vm.prank(player);
        _account().grantSession(sessionKey, expiry, valueCap, spendCap);
    }

    function _sign(uint256 pk, address to, uint256 value, bytes memory data)
        private
        view
        returns (bytes memory)
    {
        uint256 nonce = _account().sessionNonce();
        bytes32 digest = _account().callDigest(to, value, data, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Signs `data` for the escrow with the session key, and has the relayer submit it.
    function _relay(uint256 value, bytes memory data) private returns (bytes memory) {
        bytes memory signature = _sign(SESSION_PK, address(escrow), value, data);
        uint256 nonce = _account().sessionNonce();
        vm.prank(relayer);
        return _account().executeWithSession(address(escrow), value, data, nonce, signature);
    }

    function _lobby() private returns (bytes32 matchId) {
        vm.prank(players[0]);
        matchId = escrow.createMatch(STAKE, 4);
    }

    function _join(bytes32 matchId) private pure returns (bytes memory) {
        return abi.encodeCall(GameEscrow.join, (matchId));
    }

    function _expectNotPermitted(address target, bytes4 selector) private {
        vm.expectRevert(
            abi.encodeWithSelector(SessionKeyDelegate.SessionNotPermitted.selector, target, selector)
        );
    }

    // --- Delegation ----------------------------------------------------------

    function test_delegationGivesTheEoaCodeWithoutChangingItsAddress() public view {
        assertGt(player.code.length, 0);
        assertEq(player, vm.addr(PLAYER_PK));
        assertEq(address(_account().escrow()), address(escrow));
    }

    /// @dev Regression: delegating gives the EOA code, and `_safeMint` rejects
    ///      any account with code that lacks `onERC721Received`. One-click play
    ///      used to lock a player out of minting an avatar for good.
    function test_delegatedAccountCanStillMintAnAvatar() public {
        PlayerAvatars avatars = new PlayerAvatars(address(this), "LMS Avatars", "LMSA", 100, "ipfs://x/");

        vm.prank(player);
        uint256 tokenId = avatars.mint();
        assertEq(avatars.ownerOf(tokenId), player);
    }

    function test_rejectsADelegateWithNoEscrow() public {
        vm.expectRevert(SessionKeyDelegate.InvalidSession.selector);
        new SessionKeyDelegate(GameEscrow(payable(address(0))));
    }

    // --- Granting ------------------------------------------------------------

    function test_grantSessionStoresTheCaps() public {
        _grant(1 ether, 3 ether);

        (uint48 validUntil, uint128 valueCap, uint128 spendCap, uint128 spent) =
            _account().sessions(sessionKey);
        assertEq(validUntil, expiry);
        assertEq(valueCap, 1 ether);
        assertEq(spendCap, 3 ether);
        assertEq(spent, 0);
        assertTrue(_account().sessionActive(sessionKey));
    }

    /// @dev The whole security boundary: nobody but the account grants itself keys.
    function test_onlyTheAccountCanGrantASession() public {
        vm.prank(sessionKey);
        vm.expectRevert(abi.encodeWithSelector(SessionKeyDelegate.NotSelf.selector, sessionKey));
        _account().grantSession(sessionKey, expiry, 0, 0);
    }

    function test_onlyTheAccountCanRevokeASession() public {
        _grant(1 ether, 1 ether);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(SessionKeyDelegate.NotSelf.selector, relayer));
        _account().revokeSession(sessionKey);
    }

    function test_rejectsASessionThatNeverExpires() public {
        vm.prank(player);
        vm.expectRevert(SessionKeyDelegate.InvalidSession.selector);
        _account().grantSession(sessionKey, 0, 0, 0);
    }

    function test_rejectsASessionLongerThanTheMaximum() public {
        uint48 tooLate = uint48(block.timestamp + _account().MAX_SESSION_DURATION() + 1);
        vm.prank(player);
        vm.expectRevert(SessionKeyDelegate.InvalidSession.selector);
        _account().grantSession(sessionKey, tooLate, 0, 0);

        vm.prank(player);
        _account().grantSession(sessionKey, tooLate - 1, 0, 0);
    }

    function test_rejectsAValueCapAboveTheSpendCap() public {
        vm.prank(player);
        vm.expectRevert(SessionKeyDelegate.InvalidSession.selector);
        _account().grantSession(sessionKey, expiry, 2 ether, 1 ether);
    }

    function test_rejectsTheAccountItselfAsASessionKey() public {
        vm.prank(player);
        vm.expectRevert(SessionKeyDelegate.InvalidSession.selector);
        _account().grantSession(player, expiry, 0, 0);

        vm.prank(player);
        vm.expectRevert(SessionKeyDelegate.InvalidSession.selector);
        _account().grantSession(address(0), expiry, 0, 0);
    }

    // --- One-click join ------------------------------------------------------

    function test_aRelayerJoinsALobbyForThePlayer() public {
        _grant(STAKE, 2 * STAKE);
        bytes32 matchId = _lobby();
        uint256 relayerBalance = relayer.balance;

        _relay(STAKE, _join(matchId));

        address[] memory seats = escrow.getSeats(matchId);
        assertEq(seats.length, 1);
        assertEq(seats[0], player, "the seat is the account's, not the relayer's");
        assertEq(player.balance, 10 ether - STAKE, "the stake came from the account");
        assertEq(relayer.balance, relayerBalance, "the relayer paid gas only");
        assertEq(_account().sessionNonce(), 1);
        (,,, uint128 spent) = _account().sessions(sessionKey);
        assertEq(spent, STAKE);
    }

    function test_rejectsAJoinAboveTheValueCap() public {
        _grant(STAKE - 1, 2 * STAKE);
        bytes memory data = _join(_lobby());
        bytes memory signature = _sign(SESSION_PK, address(escrow), STAKE, data);

        vm.expectRevert(
            abi.encodeWithSelector(SessionKeyDelegate.ValueCapExceeded.selector, STAKE, STAKE - 1)
        );
        _account().executeWithSession(address(escrow), STAKE, data, 0, signature);
    }

    /// @dev A leaked session key must not be able to stake the whole account.
    function test_spendCapIsCumulativeAcrossCalls() public {
        _grant(STAKE, STAKE + STAKE / 2);
        _relay(STAKE, _join(_lobby()));

        bytes memory data = _join(_lobby());
        bytes memory signature = _sign(SESSION_PK, address(escrow), STAKE, data);
        vm.expectRevert(
            abi.encodeWithSelector(SessionKeyDelegate.SpendCapExceeded.selector, sessionKey, STAKE, STAKE / 2)
        );
        _account().executeWithSession(address(escrow), STAKE, data, 1, signature);
    }

    function test_regrantingResetsTheSpentAmountRatherThanAccumulating() public {
        _grant(STAKE, STAKE);
        _relay(STAKE, _join(_lobby()));

        _grant(STAKE, STAKE);

        (,, uint128 spendCap, uint128 spent) = _account().sessions(sessionKey);
        assertEq(spendCap, STAKE);
        assertEq(spent, 0);
    }

    // --- One-click collect ---------------------------------------------------

    function test_aRelayerCollectsWinningsToTheAccount() public {
        _grant(STAKE, STAKE);
        bytes32 matchId = _lobby();
        _relay(STAKE, _join(matchId));
        for (uint256 i = 1; i < 4; ++i) {
            vm.prank(players[i]);
            escrow.join{value: STAKE}(matchId);
        }
        _lockAndSeed(matchId, keccak256("seed"));
        // The seat order is the ranking, so the account wins.
        _settleAndFinalize(matchId);

        uint256 owed = escrow.withdrawable(player);
        assertGt(owed, 0);
        uint256 before = player.balance;

        _relay(0, abi.encodeCall(PullPayable.withdrawFor, (player)));

        assertEq(escrow.withdrawable(player), 0);
        assertEq(player.balance, before + owed);
    }

    /// @dev `withdrawFor` pays whoever it names; the key may only name the account.
    function test_rejectsAWithdrawalForSomeoneElse() public {
        _grant(STAKE, STAKE);
        bytes memory data = abi.encodeCall(PullPayable.withdrawFor, (relayer));
        bytes memory signature = _sign(SESSION_PK, address(escrow), 0, data);

        _expectNotPermitted(address(escrow), PullPayable.withdrawFor.selector);
        _account().executeWithSession(address(escrow), 0, data, 0, signature);
    }

    function test_rejectsAWithdrawalThatSendsValue() public {
        _grant(STAKE, STAKE);
        bytes memory data = abi.encodeCall(PullPayable.withdrawFor, (player));
        bytes memory signature = _sign(SESSION_PK, address(escrow), 1, data);

        _expectNotPermitted(address(escrow), PullPayable.withdrawFor.selector);
        _account().executeWithSession(address(escrow), 1, data, 0, signature);
    }

    // --- Scope ---------------------------------------------------------------

    /// @dev `withdraw(to)` would let a leaked key send the balance anywhere.
    function test_rejectsAnyOtherEscrowCall() public {
        _grant(STAKE, STAKE);
        bytes memory data = abi.encodeCall(PullPayable.withdraw, (relayer));
        bytes memory signature = _sign(SESSION_PK, address(escrow), 0, data);

        _expectNotPermitted(address(escrow), PullPayable.withdraw.selector);
        _account().executeWithSession(address(escrow), 0, data, 0, signature);
    }

    function test_rejectsACallToAnotherContract() public {
        _grant(STAKE, STAKE);
        PlayerAvatars avatars = new PlayerAvatars(address(this), "LMS Avatars", "LMSA", 100, "ipfs://x/");
        bytes memory data = abi.encodeCall(PlayerAvatars.mint, ());
        bytes memory signature = _sign(SESSION_PK, address(avatars), 0, data);

        _expectNotPermitted(address(avatars), PlayerAvatars.mint.selector);
        _account().executeWithSession(address(avatars), 0, data, 0, signature);
    }

    function test_rejectsAJoinWithTrailingBytes() public {
        _grant(STAKE, STAKE);
        bytes memory data = abi.encodePacked(_join(_lobby()), uint8(1));
        bytes memory signature = _sign(SESSION_PK, address(escrow), STAKE, data);

        _expectNotPermitted(address(escrow), GameEscrow.join.selector);
        _account().executeWithSession(address(escrow), STAKE, data, 0, signature);
    }

    function test_rejectsAPlainTransfer() public {
        _grant(STAKE, STAKE);
        bytes memory signature = _sign(SESSION_PK, address(escrow), STAKE, "");

        _expectNotPermitted(address(escrow), bytes4(0));
        _account().executeWithSession(address(escrow), STAKE, "", 0, signature);
    }

    // --- Authority -----------------------------------------------------------

    function test_rejectsASignatureFromAKeyWithNoSession() public {
        _grant(STAKE, STAKE);
        bytes memory data = _join(_lobby());
        bytes memory signature = _sign(STRANGER_PK, address(escrow), STAKE, data);

        vm.expectRevert(
            abi.encodeWithSelector(SessionKeyDelegate.SessionExpired.selector, vm.addr(STRANGER_PK))
        );
        _account().executeWithSession(address(escrow), STAKE, data, 0, signature);
    }

    function test_rejectsAnExpiredSession() public {
        _grant(STAKE, STAKE);
        bytes memory data = _join(_lobby());
        bytes memory signature = _sign(SESSION_PK, address(escrow), STAKE, data);

        vm.warp(expiry);
        vm.expectRevert(abi.encodeWithSelector(SessionKeyDelegate.SessionExpired.selector, sessionKey));
        _account().executeWithSession(address(escrow), STAKE, data, 0, signature);
    }

    function test_revokedSessionStopsWorkingImmediately() public {
        _grant(STAKE, STAKE);
        bytes memory data = _join(_lobby());
        bytes memory signature = _sign(SESSION_PK, address(escrow), STAKE, data);

        vm.prank(player);
        _account().revokeSession(sessionKey);

        assertFalse(_account().sessionActive(sessionKey));
        vm.expectRevert(abi.encodeWithSelector(SessionKeyDelegate.SessionExpired.selector, sessionKey));
        _account().executeWithSession(address(escrow), STAKE, data, 0, signature);
    }

    /// @dev A relayer that replays a submitted call must not get a second execution.
    function test_aSignatureCannotBeReplayed() public {
        _grant(STAKE, 2 * STAKE);
        bytes memory data = _join(_lobby());
        bytes memory signature = _sign(SESSION_PK, address(escrow), STAKE, data);
        _account().executeWithSession(address(escrow), STAKE, data, 0, signature);

        vm.expectRevert(abi.encodeWithSelector(SessionKeyDelegate.BadNonce.selector, 1, 0));
        _account().executeWithSession(address(escrow), STAKE, data, 0, signature);
    }

    /// @dev The signature covers the value, so a relayer cannot stake more than was signed.
    function test_aRelayerCannotChangeTheValue() public {
        _grant(STAKE, 2 * STAKE);
        bytes memory data = _join(_lobby());
        bytes memory signature = _sign(SESSION_PK, address(escrow), STAKE, data);

        // The signature recovers to some other key, which holds no session.
        vm.expectPartialRevert(SessionKeyDelegate.SessionExpired.selector);
        _account().executeWithSession(address(escrow), 2 * STAKE, data, 0, signature);
    }

    function test_bubblesUpTheEscrowsRevert() public {
        _grant(STAKE, STAKE);
        bytes32 unknown = keccak256("no such lobby");
        bytes memory data = _join(unknown);
        bytes memory signature = _sign(SESSION_PK, address(escrow), STAKE, data);

        vm.expectRevert(
            abi.encodeWithSelector(
                SessionKeyDelegate.CallFailed.selector,
                address(escrow),
                abi.encodeWithSelector(UnknownMatch.selector, unknown)
            )
        );
        _account().executeWithSession(address(escrow), STAKE, data, 0, signature);
        // Reverted whole: neither the nonce nor the spend moved.
        assertEq(_account().sessionNonce(), 0);
    }

    // --- ERC-1271: the account's own key, and nothing else ----------------------

    /// @dev Under 7702 the account never stops being an EOA, so its own key
    ///      must keep working, including for a contract-style check of its grant.
    function test_acceptsASignatureFromTheAccountsOwnKey() public view {
        bytes32 hash = keccak256("a session grant");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PLAYER_PK, hash);

        assertEq(_account().isValidSignature(hash, abi.encodePacked(r, s, v)), bytes4(0x1626ba7e));
    }

    /// @dev Regression: a live session key used to be a valid signer for the
    ///      account, so anything checking ERC-1271 — a permit, an order, a
    ///      login — took the key's word for the wallet's, with no cap at all.
    function test_rejectsASignatureFromALiveSessionKey() public {
        _grant(STAKE, STAKE);
        bytes32 hash = keccak256("a session grant");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_PK, hash);

        assertTrue(_account().sessionActive(sessionKey));
        assertEq(_account().isValidSignature(hash, abi.encodePacked(r, s, v)), bytes4(0xffffffff));
    }

    function test_rejectsASignatureFromAStranger() public view {
        bytes32 hash = keccak256("a session grant");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(STRANGER_PK, hash);

        assertEq(_account().isValidSignature(hash, abi.encodePacked(r, s, v)), bytes4(0xffffffff));
    }

    function test_rejectsAMalformedSignatureWithoutReverting() public view {
        assertEq(_account().isValidSignature(keccak256("x"), hex"1234"), bytes4(0xffffffff));
    }

    // --- Layout --------------------------------------------------------------

    /**
     * Frozen vector, pinned against `sessionCallDigest` in
     * `packages/protocol/test/session.test.ts`. A drift between the two would
     * not corrupt a match, but every relayed call would fail to recover the
     * session key and one-click play would silently stop working.
     */
    function test_callDigestMatchesTheFrozenVector() public {
        address account = address(0xA1);
        vm.chainId(11155111);
        vm.etch(account, address(delegate).code);

        bytes32 digest = SessionKeyDelegate(payable(account))
            .callDigest(address(0xB2), 1_000_000_000_000_000, hex"deadbeef", 7);

        assertEq(digest, 0xe0bb7f95c30aa264279556d9c60946f8e8fafb1468bbcd98dc74c8c0b13a5075);
    }

    /// @dev The account's low slots belong to whatever else the player may
    ///      delegate to one day; this delegate keeps to its ERC-7201 namespace.
    function test_stateLivesOnlyInTheNamespace() public {
        _grant(STAKE, STAKE);
        _relay(STAKE, _join(_lobby()));

        for (uint256 slot = 0; slot < 8; ++slot) {
            assertEq(vm.load(player, bytes32(slot)), bytes32(0));
        }
        bytes32 root = 0x4aa0ea22fecb5f5d36f8a5cc47e8eb04e47337348195f5e74cf0d206fc2d2300;
        assertEq(
            root, keccak256(abi.encode(uint256(keccak256("lms.session.v2")) - 1)) & ~bytes32(uint256(0xff))
        );
        // `nonce` is the second member of the layout.
        assertEq(uint256(vm.load(player, bytes32(uint256(root) + 1))), 1);
    }
}
