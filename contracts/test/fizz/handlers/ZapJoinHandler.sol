// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";

/// @notice Handles the interaction with ZapJoin: joining a lobby in any token.
abstract contract ZapJoinHandler is Properties {
    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    /// @dev `route` picks a deep pool, a pool too thin for the stake, or two
    ///      hops. `tightBudget` sets the budget one wei under the cost.
    function zap_joinWithToken_clamped(
        uint256 actorSeed,
        uint256 matchSeed,
        uint256 slack,
        uint8 route,
        bool tightBudget
    ) public {
        _useActor(actorSeed);
        bytes32 matchId = _joinableMatch(matchSeed, actor);
        if (matchId == bytes32(0)) return;

        uint256 stake = escrow.getMatch(matchId).stake;
        // What the pool asks, rounded up as the mock's exact-output quote is.
        uint256 cost = (stake * ZAP_TOKEN_PER_ETH + 1e18 - 1) / 1e18;
        route = uint8(route % 3);
        ZapJoin.PathKey[] memory path = _path(route);

        ProjectMockERC20(path[0].intermediateCurrency).mint(actor, cost);
        uint256 budget = tightBudget ? cost - 1 : cost + clampBetween(slack, 0, 1e18);
        // A pool that fills only part of the stake never seats anyone.
        if (route == 1 && stake > 0.0001 ether) {
            vm.prank(actor);
            try zap.joinWithToken(matchId, path, budget, block.timestamp) {
                t(false, "SP-30: a partial-fill pool seated a player");
            } catch {}
            return;
        }
        zap_joinWithToken(matchId, path, budget, block.timestamp);
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function zap_joinWithToken(
        bytes32 matchId,
        ZapJoin.PathKey[] memory path,
        uint256 maxAmountIn,
        uint256 deadline
    ) public asActor {
        SpPre memory p = _spPre(address(0));
        uint256 poolManagerEth = address(poolManager).balance;
        address tokenIn = path[0].intermediateCurrency;
        uint256 tokenBefore = ProjectMockERC20(tokenIn).balanceOf(actor);
        zap.joinWithToken(matchId, path, maxAmountIn, deadline);
        property_zapJoinConserves(p, poolManagerEth, matchId, actor, tokenIn, tokenBefore, maxAmountIn);
        _afterCall();
    }

    // ――――――――――――――――――――――――― Private ――――――――――――――――――――――――――

    function _path(uint8 route) private view returns (ZapJoin.PathKey[] memory path) {
        if (route == 2) {
            path = new ZapJoin.PathKey[](2);
            path[0] = _hop(address(zapTokenB), ZAP_FEE);
            path[1] = _hop(address(zapToken), ZAP_FEE);
            return path;
        }
        path = new ZapJoin.PathKey[](1);
        path[0] = _hop(address(zapToken), route == 1 ? ZAP_THIN_FEE : ZAP_FEE);
    }

    function _hop(address currency, uint24 fee) private pure returns (ZapJoin.PathKey memory) {
        return ZapJoin.PathKey({
            intermediateCurrency: currency,
            fee: fee,
            tickSpacing: ZAP_TICK_SPACING,
            hooks: address(0),
            hookData: ""
        });
    }
}
