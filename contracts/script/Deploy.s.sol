// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {GameEscrow} from "../src/GameEscrow.sol";
import {MatchMarket} from "../src/MatchMarket.sol";
import {SpokeEscrow} from "../src/SpokeEscrow.sol";
import {HashLib} from "../src/libraries/HashLib.sol";
import {MockRandomnessOracle} from "../src/mocks/MockRandomnessOracle.sol";
import {MockMessenger} from "../src/mocks/MockMessenger.sol";

/// @notice Testnet deploy: timelock-owned config, mock oracle, hub escrow, spectator market.
/// @dev Swap `MockRandomnessOracle` for `ChainlinkVrfAdapter` and `MockMessenger` for
///      `LayerZeroMessenger` once those endpoints exist on the target testnet.
contract Deploy is Script {
    function run()
        external
        returns (ProtocolConfig config, GameEscrow escrow, MatchMarket market, address oracle, address messenger)
    {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(pk);
        address treasury = vm.envOr("TREASURY", deployer);
        address attestor = vm.envOr("ATTESTOR", deployer);

        vm.startBroadcast(pk);

        address[] memory proposers = new address[](1);
        proposers[0] = deployer;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        TimelockController timelock = new TimelockController(1 days, proposers, executors, deployer);

        ProtocolConfig.Params memory params = ProtocolConfig.Params({
            feeBps: 500,
            minSeats: 4,
            maxSeats: 8,
            joinWindow: 15 minutes,
            settleWindow: 2 hours,
            minStake: 0.001 ether,
            maxStake: 1 ether,
            treasury: treasury
        });
        uint16[] memory payout = new uint16[](3);
        payout[0] = 6000;
        payout[1] = 2500;
        payout[2] = 1500;

        config = new ProtocolConfig(deployer, params, payout);
        MockRandomnessOracle mockOracle = new MockRandomnessOracle();
        mockOracle.setAutoFulfill(true);
        MockMessenger mockMessenger = new MockMessenger();

        config.setRandomnessOracle(address(mockOracle));
        config.setAttestor(attestor, true);
        config.setAttestorThreshold(1);
        config.setRulesHash(HashLib.hashRules(4, 8, 100, 34, 20, 6000, 3000, 5000, 2, 6, 30));

        escrow = new GameEscrow(config);
        market = new MatchMarket(escrow);

        config.transferOwnership(address(timelock));

        vm.stopBroadcast();

        oracle = address(mockOracle);
        messenger = address(mockMessenger);
    }
}
