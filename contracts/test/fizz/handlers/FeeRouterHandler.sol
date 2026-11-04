// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";

/// @notice Handles the interaction with FeeRouter
abstract contract FeeRouterHandler is Properties {
    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    function feeRouter_harvest_clamped(uint256 actorSeed) public {
        _useActor(actorSeed);
        if (escrow.withdrawable(address(feeRouter)) == 0 && address(feeRouter).balance == 0) return;
        feeRouter_harvest();
    }

    /// @dev ETH forced in, past the router's sender check.
    function feeRouter_donateETH(uint256 amount) public {
        amount = clampBetween(amount, 1, 10 ether);
        _forceSend(address(feeRouter), amount);
        ghosts.donatedRouterEth += amount;
    }

    function feeRouter_secondary(uint8 selector, uint256 arg0, uint256 toSeed) public {
        selector = uint8(selector % 2);
        if (selector == 0) _feeRouter_setStakerBps(uint16(clampBetween(arg0, 0, 10_000)));
        else _feeRouter_setTreasury(toSeed % 2 == 0 ? address(timelock) : actors[toSeed % actors.length]);
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function feeRouter_harvest() public asActor {
        SpPre memory p = _spPre(address(0));
        SpStake memory s = _spStake();
        uint256 credit = escrow.withdrawable(address(feeRouter));
        uint256 routerBalance = address(feeRouter).balance;
        uint16 stakerBps = feeRouter.stakerBps();
        address treasury = feeRouter.treasury();
        uint256 treasuryBefore = treasury.balance;
        uint256 got;
        try feeRouter.harvest() returns (uint256 amount) {
            got = amount;
        } catch (bytes memory reason) {
            // SP-27 (EXPLORATORY): ETH credited to the router can always be harvested.
            t(credit + routerBalance == 0, "SP-27: harvest reverted although the router is owed ETH");
            _spExitFailed(reason, "");
        }
        ghosts.donatedRouterEth = 0;
        uint256 toStakers = (got * stakerBps) / 10_000;
        ghosts.stakedEthDeposited += toStakers;
        if (toStakers != 0) ++ghosts.accrualOps;
        property_harvestSplit(p, s, got, credit, routerBalance, stakerBps, treasury, treasuryBefore);
        if (toStakers != 0) property_depositRewards(s, toStakers);
        _afterCall();
    }

    function _feeRouter_setStakerBps(uint16 stakerBps) internal asTimelock {
        feeRouter.setStakerBps(stakerBps);
        _afterCall();
    }

    function _feeRouter_setTreasury(address treasury) internal asTimelock {
        _noteAddr(treasury);
        feeRouter.setTreasury(treasury);
        _afterCall();
    }
}
