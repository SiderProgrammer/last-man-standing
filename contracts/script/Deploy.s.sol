// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {GameEscrow} from "../src/GameEscrow.sol";
import {MatchMarket} from "../src/MatchMarket.sol";
import {SpokeEscrow} from "../src/SpokeEscrow.sol";
import {PlayerAvatars} from "../src/PlayerAvatars.sol";
import {SessionKeyDelegate} from "../src/SessionKeyDelegate.sol";
import {HashLib} from "../src/libraries/HashLib.sol";
import {MockRandomnessOracle} from "../src/mocks/MockRandomnessOracle.sol";
import {MockMessenger} from "../src/mocks/MockMessenger.sol";

/// @notice Testnet deploy: timelock-owned config, mock oracle, hub escrow, spectator market.
/// @dev Swap `MockRandomnessOracle` for `ChainlinkVrfAdapter` and `MockMessenger` for
///      `LayerZeroMessenger` once those endpoints exist on the target testnet.
contract Deploy is Script {
    /// @dev Returned as one struct rather than as six named values: each named
    ///      return is a stack slot held for the whole body, and this frame is
    ///      already at the limit without `via_ir`.
    struct Deployment {
        ProtocolConfig config;
        GameEscrow escrow;
        MatchMarket market;
        PlayerAvatars avatars;
        /// @dev Stateless and shared: every delegating account runs this same
        ///      code against its own storage, so one deployment per chain.
        SessionKeyDelegate sessionDelegate;
        address oracle;
        address messenger;
    }

    function run() external returns (Deployment memory deployment) {
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

        ProtocolConfig config = new ProtocolConfig(deployer, params, payout);
        MockRandomnessOracle mockOracle = new MockRandomnessOracle();
        mockOracle.setAutoFulfill(true);
        MockMessenger mockMessenger = new MockMessenger();

        config.setRandomnessOracle(address(mockOracle));
        config.setAttestor(attestor, true);
        config.setAttestorThreshold(1);
        config.setRulesHash(HashLib.hashRules(4, 8, 100, 34, 20, 6000, 3000, 5000, 2, 6, 30));

        GameEscrow escrow = new GameEscrow(config);
        // Cosmetic and per-chain: the same deployment is repeated on every
        // spoke, and the collections are independent of each other. The
        // settings are read inline because this frame is already near the
        // stack limit.
        deployment = Deployment({
            config: config,
            escrow: escrow,
            market: new MatchMarket(escrow),
            avatars: new PlayerAvatars(
                deployer,
                "LMS Avatars",
                "LMSA",
                vm.envOr("AVATAR_MAX_SUPPLY", uint256(10_000)),
                vm.envOr("AVATAR_BASE_URI", string("ipfs://bafyplaceholder/"))
            ),
            sessionDelegate: new SessionKeyDelegate(),
            oracle: address(mockOracle),
            messenger: address(mockMessenger)
        });

        config.transferOwnership(address(timelock));

        vm.stopBroadcast();
    }
}
