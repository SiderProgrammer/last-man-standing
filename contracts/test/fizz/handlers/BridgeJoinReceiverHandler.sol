// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";

/// @notice Handles the interaction with BridgeJoinReceiver: Across fills in,
///         signed withdrawals out.
abstract contract BridgeJoinReceiverHandler is Properties {
    uint32 private constant REMOTE_CHAIN = 421_614;

    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    /// @dev A well-formed fill for a seat that is free: exactly the stake, more, or too little.
    function bridge_fillJoin_clamped(uint256 matchSeed, uint256 playerSeed, uint256 amount, uint8 mode)
        public
    {
        address player = actors[playerSeed % actors.length];
        bytes32 matchId = _joinableMatch(matchSeed, player);
        if (matchId == bytes32(0)) return;
        uint256 stake = escrow.getMatch(matchId).stake;
        mode = uint8(mode % 3);
        uint256 fill = stake;
        if (mode == 1) fill = stake + clampBetween(amount, 1, 1 ether);
        if (mode == 2) fill = clampBetween(amount, 1, stake);
        bridge_fill(address(weth), fill, abi.encode(matchId, player, REMOTE_CHAIN));
    }

    /// @dev A well-formed fill for any match at all: closed, full, or already joined.
    function bridge_fillAnyMatch_clamped(uint256 matchSeed, uint256 playerSeed, uint256 amount) public {
        if (matchIds.length == 0) return;
        bytes32 matchId = matchIds[matchSeed % matchIds.length];
        address player = actors[playerSeed % actors.length];
        bridge_fill(
            address(weth), clampBetween(amount, 1, 2 ether), abi.encode(matchId, player, REMOTE_CHAIN)
        );
    }

    /// @dev What the receiver must hold rather than route: a message that does
    ///      not decode, one naming no player, and a token that is not WETH.
    function bridge_fillUnroutable_clamped(uint256 amount, bytes memory junk, uint8 mode) public {
        amount = clampBetween(amount, 1, 2 ether);
        mode = uint8(mode % 3);
        if (mode == 0) {
            bridge_fill(address(weth), amount, bytes.concat(hex"01", junk));
        } else if (mode == 1) {
            bridge_fill(address(weth), amount, abi.encode(bytes32(0), address(0), REMOTE_CHAIN));
        } else {
            bridge_fill(address(zapToken), amount, abi.encode(bytes32(0), actors[0], REMOTE_CHAIN));
        }
    }

    /// @dev The pool reporting WETH that never arrived, so `_unwrap` falls back
    ///      to ETH the receiver already holds. The Across SpokePool is trusted
    ///      for this; a held-value property should say what happens if it lies.
    function bridge_handleOnHeldEth_clamped(uint256 matchSeed, uint256 playerSeed, uint256 amount) public {
        if (matchIds.length == 0 || address(bridgeReceiver).balance == 0) return;
        bytes32 matchId = matchIds[matchSeed % matchIds.length];
        address player = actors[playerSeed % actors.length];
        amount = clampBetween(amount, 1, address(bridgeReceiver).balance);
        bridge_handleV3AcrossMessage(address(weth), amount, abi.encode(matchId, player, REMOTE_CHAIN));
    }

    /// @dev Bridges a signer's whole balance out. `mode` picks a valid request or
    ///      one thing wrong with it: a fee over the cap, past its deadline, a
    ///      stale nonce, or another key's signature.
    function bridge_withdrawToChainFor_clamped(
        uint256 signerSeed,
        uint256 fee,
        uint256 recipientSeed,
        uint8 mode
    ) public {
        address player = signerActors[signerSeed % signerActors.length];
        uint256 amount = escrow.withdrawable(player);
        if (amount == 0) return;
        fee = clampBetween(fee, 0, amount);
        mode = uint8(mode % 5);

        BridgeJoinReceiver.Withdrawal memory w = BridgeJoinReceiver.Withdrawal({
            player: player,
            hubChainId: block.chainid,
            destinationChainId: REMOTE_CHAIN,
            recipient: actors[recipientSeed % actors.length],
            outputToken: address(weth),
            maxFee: mode == 1 && fee > 0 ? fee - 1 : fee,
            nonce: bridgeReceiver.nonces(player) + (mode == 3 ? 1 : 0),
            deadline: mode == 2 ? block.timestamp - 1 : block.timestamp + 1 hours
        });
        BridgeJoinReceiver.Quote memory q = BridgeJoinReceiver.Quote({
            outputAmount: amount - fee,
            quoteTimestamp: uint32(block.timestamp),
            fillDeadline: uint32(block.timestamp + 1 hours),
            exclusiveRelayer: address(0),
            exclusivityParameter: 0
        });
        uint256 key = signerKeyOf[
            mode == 4 ? signerActors[(signerSeed % signerActors.length + 1) % signerActors.length] : player
        ];
        bytes memory signature = _sign(key, bridgeReceiver.withdrawalDigest(w, q));
        // A fee over the cap, an expired deadline, a wrong nonce and another key's signature must all be refused.
        if (mode >= 2 || (mode == 1 && fee > 0)) {
            vm.prank(actor);
            try bridgeReceiver.withdrawToChainFor(w, q, signature) {
                t(false, "SP-19: a bridge-out with a bad fee, deadline, nonce or signature succeeded");
            } catch {}
            return;
        }
        if (escrow.paused()) {
            vm.prank(actor);
            try bridgeReceiver.withdrawToChainFor(w, q, signature) {
                t(false, "SP-14: a bridge-out went through while paused");
            } catch {}
            return;
        }
        bridge_withdrawToChainFor(w, q, signature);
    }

    function bridge_secondary(uint8 selector, uint256 amount, uint256 toSeed) public {
        selector = uint8(selector % 3);
        address to = actors[toSeed % actors.length];
        if (selector == 0) {
            _bridge_recover(address(0), to, clampBetween(amount, 0, address(bridgeReceiver).balance));
        } else if (selector == 1) {
            _bridge_recover(
                address(zapToken), to, clampBetween(amount, 0, zapToken.balanceOf(address(bridgeReceiver)))
            );
        } else {
            _bridge_recover(
                address(weth), to, clampBetween(amount, 0, weth.balanceOf(address(bridgeReceiver)))
            );
        }
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    /// @dev One relayer fill through the mock SpokePool, paying the receiver and
    ///      then calling its handler, as Across does.
    function bridge_fill(address token, uint256 amount, bytes memory message) public {
        _noteJoinMessage(message);
        SpBridge memory b = _spBridgePre(token, amount, message);
        uint32 fillDeadline = uint32(block.timestamp + 1 hours);
        if (token == address(weth)) {
            acrossPool.fill{value: amount}(address(bridgeReceiver), token, amount, fillDeadline, message);
            property_bridgeJoinConserves(b, amount);
        } else {
            zapToken.mint(address(this), amount);
            zapToken.approve(address(acrossPool), amount);
            acrossPool.fill(address(bridgeReceiver), address(zapToken), amount, fillDeadline, message);
        }
        _afterCall();
    }

    /// @dev Called as the SpokePool: once the caller is known, the handler never reverts (SP-18).
    function bridge_handleV3AcrossMessage(address token, uint256 amount, bytes memory message) public {
        _noteJoinMessage(message);
        vm.prank(address(acrossPool));
        try bridgeReceiver.handleV3AcrossMessage(token, amount, address(this), message) {}
        catch {
            t(false, "SP-18: the receiver's handler reverted for the SpokePool");
        }
        _afterCall();
    }

    function bridge_withdrawToChainFor(
        BridgeJoinReceiver.Withdrawal memory w,
        BridgeJoinReceiver.Quote memory q,
        bytes memory signature
    ) public asActor {
        _noteAddr(w.player);
        _noteAddr(w.recipient);
        SpOut memory o = _spOutPre(w.player);
        bridgeReceiver.withdrawToChainFor(w, q, signature);
        property_bridgeWithdrawOut(o, w, q);
        _afterCall();
    }

    function _bridge_recover(address token, address to, uint256 amount) internal asTimelock {
        bridgeReceiver.recover(token, to, amount);
        _afterCall();
    }

    /// @dev Every player a message names must be known to the sums over known addresses.
    function _noteJoinMessage(bytes memory message) private {
        try bridgeReceiver.decodeJoin(message) returns (bytes32, address player, uint32) {
            _noteAddr(player);
        } catch {}
    }
}
