// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";

/// @notice Handles the interaction with SessionKeyDelegate. Each session account
///         is its own instance, standing in for an EIP-7702 delegated EOA.
abstract contract SessionKeyDelegateHandler is Properties {
    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    function session_grantSession_clamped(
        uint256 accountSeed,
        uint256 keySeed,
        uint256 duration,
        uint256 valueCap,
        uint256 spendCap
    ) public {
        address account = address(sessionAccounts[accountSeed % sessionAccounts.length]);
        address sessionKey = sessionKeys[keySeed % sessionKeys.length];
        spendCap = clampBetween(spendCap, 0, 5 ether);
        valueCap = clampBetween(valueCap, 0, spendCap);
        duration = clampBetween(duration, 1, 7 days);
        session_grantSession(
            account, sessionKey, uint48(block.timestamp + duration), uint128(valueCap), uint128(spendCap)
        );
    }

    function session_revokeSession_clamped(uint256 accountSeed, uint256 keySeed) public {
        session_revokeSession(
            address(sessionAccounts[accountSeed % sessionAccounts.length]),
            sessionKeys[keySeed % sessionKeys.length]
        );
    }

    /// @dev A relayed call a session key signed. `mode` picks one of the two calls
    ///      in scope, or something the delegate must refuse: `withdraw` to a free
    ///      address, `withdrawFor` another account, a join over the value cap, or
    ///      another target entirely.
    function session_execute_clamped(
        uint256 relayerSeed,
        uint256 accountSeed,
        uint256 keySeed,
        uint256 matchSeed,
        uint8 mode
    ) public {
        _useActor(relayerSeed);
        SessionKeyDelegate account = sessionAccounts[accountSeed % sessionAccounts.length];
        address sessionKey = sessionKeys[keySeed % sessionKeys.length];
        mode = uint8(mode % 6);

        address target = address(escrow);
        uint256 value;
        bytes memory data;
        if (mode == 0) {
            bytes32 matchId = _joinableMatch(matchSeed, address(account));
            if (matchId == bytes32(0)) return;
            value = escrow.getMatch(matchId).stake;
            data = abi.encodeWithSelector(escrow.join.selector, matchId);
        } else if (mode == 1) {
            data = abi.encodeWithSelector(escrow.withdrawFor.selector, address(account));
        } else if (mode == 2) {
            data = abi.encodeWithSelector(escrow.withdraw.selector, outsider);
        } else if (mode == 3) {
            data = abi.encodeWithSelector(escrow.withdrawFor.selector, outsider);
        } else if (mode == 4) {
            bytes32 matchId = _joinableMatch(matchSeed, address(account));
            if (matchId == bytes32(0)) return;
            (, uint128 valueCap,,) = account.sessions(sessionKey);
            value = uint256(valueCap) + 1;
            data = abi.encodeWithSelector(escrow.join.selector, matchId);
        } else {
            target = address(feeRouter);
            data = abi.encodeWithSelector(feeRouter.harvest.selector);
        }

        uint256 nonce = account.sessionNonce();
        bytes memory signature =
            _sign(sessionKeyOf[sessionKey], account.callDigest(target, value, data, nonce));
        _fund(address(account), value);
        // Anything but a join or a withdrawFor for itself, inside the value cap, must be refused.
        if (mode >= 2) {
            vm.prank(actor);
            try account.executeWithSession(target, value, data, nonce, signature) {
                t(false, "SP-32: a session executed a call outside its scope");
            } catch {}
            return;
        }
        session_executeWithSession(address(account), target, value, data, nonce, signature);
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function session_executeWithSession(
        address account,
        address target,
        uint256 value,
        bytes memory data,
        uint256 nonce,
        bytes memory signature
    ) public asActor {
        SessionKeyDelegate delegate_ = SessionKeyDelegate(payable(account));
        address key = _spRecover(delegate_.callDigest(target, value, data, nonce), signature);
        uint256 nonceBefore = delegate_.sessionNonce();
        (,,, uint128 spentBefore) = delegate_.sessions(key);
        delegate_.executeWithSession(target, value, data, nonce, signature);
        property_sessionExecuted(account, key, nonceBefore, spentBefore, target, value, data);
        _afterCall();
    }

    /// @dev Only the account may call: under 7702, a transaction to itself.
    function session_grantSession(
        address account,
        address sessionKey,
        uint48 validUntil,
        uint128 valueCap,
        uint128 spendCap
    ) public {
        vm.prank(account);
        SessionKeyDelegate(payable(account)).grantSession(sessionKey, validUntil, valueCap, spendCap);
        ghosts.grantTime[account][sessionKey] = uint64(block.timestamp);
        property_sessionGrant(account, sessionKey, validUntil, valueCap, spendCap);
        _afterCall();
    }

    function session_revokeSession(address account, address sessionKey) public {
        vm.prank(account);
        SessionKeyDelegate(payable(account)).revokeSession(sessionKey);
        property_sessionRevoke(account, sessionKey);
        _afterCall();
    }
}
