// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Fixtures} from "../helpers/Fixtures.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {NothingToWithdraw} from "../../src/Errors.sol";
import {BridgeJoinReceiver} from "../../src/periphery/BridgeJoinReceiver.sol";
import {SpokeRouter} from "../../src/periphery/SpokeRouter.sol";
import {MockAcrossSpokePool} from "../../src/mocks/MockAcrossSpokePool.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {IAcrossSpokePool} from "../../src/vendor/across/IAcrossSpokePool.sol";
import {IWETH9} from "../../src/vendor/across/IWETH9.sol";

/// @dev The hub end. `pool` is the hub's SpokePool; a test fills it the way a
///      relayer would, with the message a `SpokeRouter` builds.
contract BridgeJoinReceiverTest is Fixtures {
    uint32 private constant SPOKE = 421_614;
    uint256 private constant PLAYER_PK = 0x9A7E7;
    /// @dev Arbitrum Sepolia's WETH, from `config/across.json`.
    address private constant SPOKE_WETH = 0x980B62Da83eFf3D4576C647993b0c1D7faf17c73;

    MockWETH private weth;
    MockAcrossSpokePool private pool;
    BridgeJoinReceiver private receiver;
    address private relayer;
    address private player;
    bytes32 private matchId;

    function setUp() public override {
        super.setUp();
        vm.warp(1_800_000_000);
        weth = new MockWETH();
        pool = new MockAcrossSpokePool(IWETH9(address(weth)));
        receiver = new BridgeJoinReceiver(owner, escrow, IAcrossSpokePool(address(pool)));
        vm.prank(owner);
        config.setBridgeReceiver(address(receiver));

        relayer = makeAddr("relayer");
        vm.deal(relayer, 100 ether);
        player = vm.addr(PLAYER_PK);

        vm.prank(players[0]);
        matchId = escrow.createMatch(STAKE, 4);
    }

    function _message(bytes32 id, address who) private pure returns (bytes memory) {
        return abi.encode(id, who, SPOKE);
    }

    /// @dev One relayer fill of WETH to the receiver, carrying `message`.
    function _fill(uint256 amount, bytes memory message) private {
        vm.prank(relayer);
        pool.fill{value: amount}(
            address(receiver), address(weth), amount, uint32(block.timestamp + 1 hours), message
        );
    }

    function _assertHoldsNothing() private view {
        assertEq(address(receiver).balance, 0);
        assertEq(weth.balanceOf(address(receiver)), 0);
        assertEq(address(escrow).balance, escrow.totalOwed() + escrow.totalEscrowed());
    }

    // --- In ------------------------------------------------------------------

    function test_aFillSeatsThePlayer() public {
        vm.expectEmit(true, true, false, true, address(escrow));
        emit GameEscrow.PlayerJoined(matchId, player, 0, SPOKE);
        _fill(STAKE, _message(matchId, player));

        assertTrue(escrow.hasSeat(matchId, player));
        assertEq(escrow.seatOrigin(matchId, player), SPOKE);
        assertEq(escrow.totalEscrowed(), STAKE);
        _assertHoldsNothing();
    }

    function test_moreThanTheStakeSeatsAndCreditsTheRest() public {
        _fill(STAKE + 0.2 ether, _message(matchId, player));
        assertTrue(escrow.hasSeat(matchId, player));
        assertEq(escrow.withdrawable(player), 0.2 ether);
        _assertHoldsNothing();
    }

    function test_tooLittleIsCreditedNotSeated() public {
        vm.expectEmit(true, true, false, true, address(escrow));
        emit GameEscrow.JoinRefunded(matchId, player, STAKE - 1, GameEscrow.JoinFailure.StakeTooLow);
        _fill(STAKE - 1, _message(matchId, player));
        assertFalse(escrow.hasSeat(matchId, player));
        assertEq(escrow.withdrawable(player), STAKE - 1);
        _assertHoldsNothing();
    }

    function test_aLobbyThatFilledInFlightIsCredited() public {
        for (uint256 i = 0; i < 4; ++i) {
            vm.prank(players[i]);
            escrow.join{value: STAKE}(matchId);
        }
        vm.expectEmit(true, true, false, true, address(escrow));
        emit GameEscrow.JoinRefunded(matchId, player, STAKE, GameEscrow.JoinFailure.LobbyFull);
        _fill(STAKE, _message(matchId, player));
        assertEq(escrow.withdrawable(player), STAKE);
        _assertHoldsNothing();
    }

    function test_aJoinPastTheDeadlineIsCredited() public {
        vm.warp(block.timestamp + 2 hours);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit GameEscrow.JoinRefunded(matchId, player, STAKE, GameEscrow.JoinFailure.WindowClosed);
        _fill(STAKE, _message(matchId, player));
        assertEq(escrow.withdrawable(player), STAKE);
        _assertHoldsNothing();
    }

    function test_anUnknownLobbyIsCredited() public {
        _fill(STAKE, _message(keccak256("nope"), player));
        assertEq(escrow.withdrawable(player), STAKE);
        _assertHoldsNothing();
    }

    /// @dev A message nobody can decode names nobody to credit: it is held,
    ///      and the fill still lands rather than leaving the deposit stuck.
    function test_aBadPayloadIsHeldForRecovery() public {
        bytes memory junk = hex"deadbeef";
        vm.expectEmit(true, false, false, true, address(receiver));
        emit BridgeJoinReceiver.Unroutable(address(0), STAKE, junk);
        _fill(STAKE, junk);
        assertEq(address(receiver).balance, STAKE);

        // An address with dirty upper bits does not decode either.
        bytes memory dirty = abi.encode(matchId, type(uint256).max, SPOKE);
        _fill(STAKE, dirty);
        assertEq(address(receiver).balance, 2 * STAKE);

        address safe = makeAddr("safe");
        vm.prank(owner);
        receiver.recover(address(0), safe, 2 * STAKE);
        assertEq(safe.balance, 2 * STAKE);
    }

    function test_theZeroPlayerIsHeld() public {
        _fill(STAKE, _message(matchId, address(0)));
        assertEq(address(receiver).balance, STAKE);
        assertEq(escrow.totalOwed(), 0);
    }

    /// @dev Only WETH becomes a seat. Any other token stays, to be recovered.
    function test_anotherTokenIsHeld() public {
        MockERC20 usdc = new MockERC20("USD Coin", "USDC");
        usdc.mint(relayer, 100e6);
        vm.startPrank(relayer);
        usdc.approve(address(pool), 100e6);
        bytes memory message = _message(matchId, player);
        vm.expectEmit(true, false, false, true, address(receiver));
        emit BridgeJoinReceiver.Unroutable(address(usdc), 100e6, message);
        pool.fill(address(receiver), address(usdc), 100e6, uint32(block.timestamp + 1 hours), message);
        vm.stopPrank();

        assertFalse(escrow.hasSeat(matchId, player));
        vm.prank(owner);
        receiver.recover(address(usdc), player, 100e6);
        assertEq(usdc.balanceOf(player), 100e6);
    }

    /// @dev Governance moved the receiver while a fill was in flight: the
    ///      escrow refuses this one, and it is held rather than reverted.
    function test_anEscrowThatRefusesIsHeld() public {
        vm.prank(owner);
        config.setBridgeReceiver(makeAddr("newReceiver"));
        _fill(STAKE, _message(matchId, player));
        assertFalse(escrow.hasSeat(matchId, player));
        assertEq(address(receiver).balance, STAKE);
    }

    function test_onlyTheSpokePoolCallsTheHandler() public {
        vm.expectRevert(abi.encodeWithSelector(BridgeJoinReceiver.NotSpokePool.selector, address(this)));
        receiver.handleV3AcrossMessage(address(weth), STAKE, relayer, _message(matchId, player));
    }

    function test_refusesStrayEth() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(receiver).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_onlyTheOwnerRecovers() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        receiver.recover(address(0), address(this), 1);
    }

    /// @dev The whole way: a router deposit on the spoke, read and filled on
    ///      the hub with what it says, as a relayer does.
    function test_endToEnd_fromSpokeRouterToASeat() public {
        MockWETH spokeWeth = new MockWETH();
        MockAcrossSpokePool spokePool = new MockAcrossSpokePool(IWETH9(address(spokeWeth)));
        vm.chainId(SPOKE);
        SpokeRouter router = new SpokeRouter(
            IAcrossSpokePool(address(spokePool)), address(spokeWeth), 31_337, address(receiver), address(weth)
        );
        vm.deal(player, 2 ether);
        vm.prank(player);
        router.join{value: STAKE + 0.001 ether}(
            matchId,
            address(0),
            SpokeRouter.Quote({
                outputAmount: STAKE,
                quoteTimestamp: uint32(block.timestamp),
                fillDeadline: uint32(block.timestamp + 1 hours),
                exclusiveRelayer: address(0),
                exclusivityParameter: 0
            })
        );
        vm.chainId(31_337);

        MockAcrossSpokePool.Deposit memory deposit = spokePool.getDeposit(0);
        assertEq(deposit.recipient, address(receiver));
        assertEq(deposit.outputToken, address(weth));
        vm.prank(relayer);
        pool.fill{value: deposit.outputAmount}(
            deposit.recipient,
            deposit.outputToken,
            deposit.outputAmount,
            deposit.fillDeadline,
            deposit.message
        );

        assertTrue(escrow.hasSeat(matchId, player));
        assertEq(escrow.seatOrigin(matchId, player), SPOKE);
        _assertHoldsNothing();
    }

    // --- Out -----------------------------------------------------------------

    function _withdrawal(address who, uint256 nonce)
        private
        view
        returns (BridgeJoinReceiver.Withdrawal memory)
    {
        return BridgeJoinReceiver.Withdrawal({
            player: who,
            hubChainId: block.chainid,
            destinationChainId: SPOKE,
            recipient: who,
            outputToken: SPOKE_WETH,
            maxFee: 0.01 ether,
            nonce: nonce,
            deadline: block.timestamp + 1 hours
        });
    }

    function _quote(uint256 outputAmount) private view returns (BridgeJoinReceiver.Quote memory) {
        return BridgeJoinReceiver.Quote({
            outputAmount: outputAmount,
            quoteTimestamp: uint32(block.timestamp),
            fillDeadline: uint32(block.timestamp + 1 hours),
            exclusiveRelayer: address(0),
            exclusivityParameter: 0
        });
    }

    function _sign(uint256 pk, BridgeJoinReceiver.Withdrawal memory w) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, receiver.withdrawalDigest(w));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Gives the player a balance in the escrow, as a refunded join does.
    function _credit(address who, uint256 amount) private {
        _fill(amount, _message(keccak256("gone"), who));
        assertEq(escrow.withdrawable(who), amount);
    }

    function test_withdrawToChain_bridgesTheWholeBalanceAsSigned() public {
        _credit(player, STAKE);
        BridgeJoinReceiver.Withdrawal memory w = _withdrawal(player, 0);
        uint256 output = STAKE - 0.002 ether;

        vm.expectEmit(true, true, false, true, address(receiver));
        emit BridgeJoinReceiver.WithdrawnToChain(player, SPOKE, player, STAKE, output);
        vm.prank(relayer);
        uint256 amount = receiver.withdrawToChainFor(w, _quote(output), _sign(PLAYER_PK, w));

        assertEq(amount, STAKE);
        assertEq(escrow.withdrawable(player), 0);
        assertEq(receiver.nonces(player), 1);
        MockAcrossSpokePool.Deposit memory deposit = pool.getDeposit(0);
        assertEq(deposit.depositor, player, "an unfilled withdrawal refunds the player on the hub");
        assertEq(deposit.recipient, player);
        assertEq(deposit.inputToken, address(weth));
        assertEq(deposit.outputToken, w.outputToken);
        assertEq(deposit.inputAmount, STAKE);
        assertEq(deposit.outputAmount, output);
        assertEq(deposit.destinationChainId, SPOKE);
        assertEq(deposit.message.length, 0);
        assertEq(relayer.balance, 100 ether - STAKE, "the relayer paid only the fill it made");
        _assertHoldsNothing();
    }

    function test_withdrawToChain_aSignatureWorksOnce() public {
        _credit(player, STAKE);
        BridgeJoinReceiver.Withdrawal memory w = _withdrawal(player, 0);
        bytes memory signature = _sign(PLAYER_PK, w);
        receiver.withdrawToChainFor(w, _quote(STAKE), signature);

        _credit(player, STAKE);
        vm.expectRevert(abi.encodeWithSelector(BridgeJoinReceiver.WrongNonce.selector, 1, 0));
        receiver.withdrawToChainFor(w, _quote(STAKE), signature);
    }

    function test_withdrawToChain_refusesAnotherSignerOrAlteredTerms() public {
        _credit(player, STAKE);
        BridgeJoinReceiver.Withdrawal memory w = _withdrawal(player, 0);
        bytes memory signed = _sign(0xBAD, w);
        vm.expectRevert(BridgeJoinReceiver.BadSignature.selector);
        receiver.withdrawToChainFor(w, _quote(STAKE), signed);

        bytes memory signature = _sign(PLAYER_PK, w);
        w.recipient = relayer;
        vm.expectRevert(BridgeJoinReceiver.BadSignature.selector);
        receiver.withdrawToChainFor(w, _quote(STAKE), signature);
    }

    function test_withdrawToChain_refusesAnExpiredOrForeignInstruction() public {
        _credit(player, STAKE);
        BridgeJoinReceiver.Withdrawal memory w = _withdrawal(player, 0);
        w.hubChainId = 8453;
        bytes memory signed = _sign(PLAYER_PK, w);
        vm.expectRevert(abi.encodeWithSelector(BridgeJoinReceiver.WrongHub.selector, 8453));
        receiver.withdrawToChainFor(w, _quote(STAKE), signed);

        w = _withdrawal(player, 0);
        vm.warp(w.deadline + 1);
        signed = _sign(PLAYER_PK, w);
        vm.expectRevert(abi.encodeWithSelector(BridgeJoinReceiver.WithdrawalExpired.selector, w.deadline));
        receiver.withdrawToChainFor(w, _quote(STAKE), signed);
    }

    function test_withdrawToChain_theFeeIsCappedBySignature() public {
        _credit(player, STAKE);
        BridgeJoinReceiver.Withdrawal memory w = _withdrawal(player, 0);
        bytes memory signature = _sign(PLAYER_PK, w);

        uint256 output = STAKE - w.maxFee - 1;
        vm.expectRevert(
            abi.encodeWithSelector(BridgeJoinReceiver.FeeTooHigh.selector, w.maxFee + 1, w.maxFee)
        );
        receiver.withdrawToChainFor(w, _quote(output), signature);

        vm.expectRevert(
            abi.encodeWithSelector(BridgeJoinReceiver.OutputExceedsInput.selector, STAKE + 1, STAKE)
        );
        receiver.withdrawToChainFor(w, _quote(STAKE + 1), signature);
    }

    /// @dev A relayer pays the gas, so dust is refused, as with `withdrawFor`.
    function test_withdrawToChain_refusesDustAndNothing() public {
        BridgeJoinReceiver.Withdrawal memory w = _withdrawal(player, 0);
        bytes memory signed = _sign(PLAYER_PK, w);
        vm.expectRevert(NothingToWithdraw.selector);
        receiver.withdrawToChainFor(w, _quote(1), signed);

        uint256 dust = escrow.MIN_WITHDRAW_FOR() - 1;
        _credit(player, dust);
        signed = _sign(PLAYER_PK, w);
        vm.expectRevert(abi.encodeWithSelector(BridgeJoinReceiver.BelowMinimum.selector, dust, dust + 1));
        receiver.withdrawToChainFor(w, _quote(dust), signed);
    }

    /// @dev A contract wallet signs through ERC-1271.
    function test_withdrawToChain_acceptsAContractWalletsSignature() public {
        Erc1271Wallet wallet = new Erc1271Wallet(player);
        _credit(address(wallet), STAKE);
        BridgeJoinReceiver.Withdrawal memory w = _withdrawal(address(wallet), 0);
        receiver.withdrawToChainFor(w, _quote(STAKE), _sign(PLAYER_PK, w));
        assertEq(escrow.withdrawable(address(wallet)), 0);
    }

    /// @dev Only the receiver can move a balance out this way.
    function test_withdrawToBridge_onlyTheReceiver() public {
        _credit(player, STAKE);
        vm.expectRevert(abi.encodeWithSelector(GameEscrow.NotBridgeReceiver.selector, address(this)));
        escrow.withdrawToBridge(player);
    }

    /// @dev Pins the type string, which the client builds the typed data from:
    ///      `packages/consensus` hashes the same instruction to the same digest.
    function test_withdrawalDigest_matchesTheTypedDataByHand() public view {
        BridgeJoinReceiver.Withdrawal memory w = _withdrawal(player, 7);
        bytes32 typeHash = keccak256(
            "Withdrawal(address player,uint256 hubChainId,uint256 destinationChainId,address recipient,address outputToken,uint256 maxFee,uint256 nonce,uint256 deadline)"
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,address verifyingContract)"),
                keccak256("LastManStanding"),
                keccak256("1"),
                address(receiver)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                typeHash,
                w.player,
                w.hubChainId,
                w.destinationChainId,
                w.recipient,
                w.outputToken,
                w.maxFee,
                w.nonce,
                w.deadline
            )
        );
        assertEq(receiver.withdrawalDigest(w), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }

    /// @dev Frozen, and the same vector as `packages/consensus/test/withdrawal.test.ts`:
    ///      what the client has a wallet sign is what the receiver checks. The
    ///      receiver's code is put at a fixed address, which the domain names.
    function test_withdrawalDigest_frozenVector() public {
        address at = 0x1111111111111111111111111111111111111111;
        vm.etch(at, address(receiver).code);
        BridgeJoinReceiver.Withdrawal memory w = BridgeJoinReceiver.Withdrawal({
            player: 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa,
            hubChainId: 84_532,
            destinationChainId: 421_614,
            recipient: 0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB,
            outputToken: SPOKE_WETH,
            maxFee: 1e15,
            nonce: 3,
            deadline: 1_800_000_000
        });
        assertEq(
            BridgeJoinReceiver(payable(at)).withdrawalDigest(w),
            0x5c24035ab95701f0bcca63331fc1c2ba82b5cb6496e7c6b90d93b33359b63b13
        );
    }
}

/// @dev A smart wallet owned by one key.
contract Erc1271Wallet is IERC1271 {
    address private immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (bytes32 r, bytes32 s) = abi.decode(signature[:64], (bytes32, bytes32));
        address signer = ecrecover(hash, uint8(signature[64]), r, s);
        return signer == owner ? IERC1271.isValidSignature.selector : bytes4(0);
    }
}
