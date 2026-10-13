// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {GameEscrow} from "../src/GameEscrow.sol";
import {PlayerAvatars} from "../src/PlayerAvatars.sol";
import {SessionKeyDelegate} from "../src/SessionKeyDelegate.sol";
import {ZapJoin} from "../src/periphery/ZapJoin.sol";
import {IPoolManager} from "../src/interfaces/IPoolManager.sol";
import {HashLib} from "../src/libraries/HashLib.sol";
import {MockRandomnessOracle} from "../src/mocks/MockRandomnessOracle.sol";
import {MockMessenger} from "../src/mocks/MockMessenger.sol";

/// @notice Hub deploy: multisig-governed config, randomness oracle, hub escrow.
/// @dev Governance ends up as:
///
///        Safe --proposes, cancels--> TimelockController --owns--> ProtocolConfig
///         |                          (anyone may execute once       |
///         |                           the delay has passed)         +--> read by GameEscrow
///         +- guardian: may pause GameEscrow at once, never unpause
///         +- treasury: receives protocol fees
///         +- owns PlayerAvatars directly: cosmetic, holds no funds, needs no delay
///
///      The deployer holds no role once `run` returns.
///
///      The mock oracle and messenger are deployed on a local node only; anywhere
///      else pass `ORACLE` (a `ChainlinkVrfAdapter`) and, once spokes exist,
///      `MESSENGER` (a `LayerZeroMessenger`). Both are `Ownable2Step`, and whoever
///      owns them can choose seeds or forge cross-chain joins, so deploy them with
///      the timelock as `owner_`, never an EOA. The same goes for `SpokeEscrow`
///      on every spoke, each behind its own Safe and timelock.
contract Deploy is Script {
    /// @dev Anvil and Hardhat: the only chain on which `SAFE` may be left unset.
    uint256 private constant LOCAL_CHAIN_ID = 31_337;

    /// @dev Returned as one struct rather than as named values: each named
    ///      return is a stack slot held for the whole body, and this frame is
    ///      already at the limit without `via_ir`.
    struct Deployment {
        ProtocolConfig config;
        GameEscrow escrow;
        PlayerAvatars avatars;
        /// @dev Stateless and shared: every delegating account runs this same
        ///      code against its own storage, so one deployment per chain.
        SessionKeyDelegate sessionDelegate;
        /// @dev Join-with-any-token. Zero when `POOL_MANAGER` is unset.
        ZapJoin zap;
        TimelockController timelock;
        address safe;
        address oracle;
        address messenger;
    }

    error SafeRequired();
    error MockOffLocal();
    error DelayTooShort(uint256 delay, uint256 matchLifetime);

    function run() external returns (Deployment memory deployment) {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(pk);
        deployment.safe = _safe(deployer);

        vm.startBroadcast(pk);

        // Zero delay and the deployer as proposer only while it is being set
        // up: `_handOver` raises the delay and removes the deployer before the
        // broadcast ends.
        address[] memory proposers = new address[](1);
        proposers[0] = deployer;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        deployment.timelock = new TimelockController(0, proposers, executors, deployer);

        deployment.config = new ProtocolConfig(deployer, _params(deployment.safe), _payout());
        (deployment.oracle, deployment.messenger) = _transport();
        _configure(deployment.config, deployment.oracle, deployment.safe, deployer);

        deployment.escrow = new GameEscrow(deployment.config);
        // Cosmetic and per-chain: the same deployment is repeated on every
        // spoke, and the collections are independent of each other.
        deployment.avatars = new PlayerAvatars(
            deployment.safe,
            "LMS Avatars",
            "LMSA",
            vm.envOr("AVATAR_MAX_SUPPLY", uint256(10_000)),
            vm.envOr("AVATAR_BASE_URI", string("ipfs://bafyplaceholder/"))
        );
        deployment.sessionDelegate = new SessionKeyDelegate();
        deployment.zap = _zap(deployment.escrow);

        deployment.config.transferOwnership(address(deployment.timelock));
        _handOver(deployment.timelock, deployment.config, deployment.safe, deployer);

        vm.stopBroadcast();
    }

    /// @dev Required everywhere but a local node. Pointing it at the deployer's
    ///      own address is allowed, but it has to be a deliberate choice rather
    ///      than something a missing variable does silently.
    function _safe(address deployer) private view returns (address safe) {
        safe = vm.envOr("SAFE", address(0));
        if (safe != address(0)) return safe;
        if (block.chainid != LOCAL_CHAIN_ID) revert SafeRequired();
        return deployer;
    }

    /// @dev The mocks are for a local node only. `MockRandomnessOracle.fulfill`
    ///      is open to anyone, so on any other chain whoever calls it first
    ///      chooses the seed of every match.
    ///
    ///      Elsewhere `ORACLE` is required — a `ChainlinkVrfAdapter` whose owner
    ///      must then register the escrow with `setConsumer` — and `MESSENGER`
    ///      is optional: unset means a hub with no spokes yet.
    function _transport() private returns (address oracle, address messenger) {
        oracle = vm.envOr("ORACLE", address(0));
        messenger = vm.envOr("MESSENGER", address(0));
        if (block.chainid != LOCAL_CHAIN_ID) {
            if (oracle == address(0)) revert MockOffLocal();
            return (oracle, messenger);
        }
        // Answers nothing on its own: something must call `fulfill` after each
        // `lockMatch`, as a VRF node would. `npm run dev:fork` does.
        if (oracle == address(0)) oracle = address(new MockRandomnessOracle());
        if (messenger == address(0)) messenger = address(new MockMessenger());
    }

    function _params(address safe) private view returns (ProtocolConfig.Params memory) {
        return ProtocolConfig.Params({
            feeBps: 500,
            minSeats: 4,
            maxSeats: 8,
            joinWindow: 15 minutes,
            settleWindow: 2 hours,
            minStake: 0.001 ether,
            maxStake: 1 ether,
            treasury: vm.envOr("TREASURY", safe)
        });
    }

    function _payout() private pure returns (uint16[] memory payout) {
        payout = new uint16[](3);
        payout[0] = 6000;
        payout[1] = 2500;
        payout[2] = 1500;
    }

    /// @dev Called while the deployer still owns the config, which is what lets
    ///      the initial setup skip the timelock.
    function _configure(ProtocolConfig config, address oracle, address safe, address deployer) private {
        config.setRandomnessOracle(oracle);

        // The quorum is a multisig over results: independent attestor keys,
        // most of which must agree. `ATTESTOR` is the single-key fallback.
        address[] memory fallbackAttestors = new address[](1);
        fallbackAttestors[0] = vm.envOr("ATTESTOR", deployer);
        address[] memory attestors = vm.envOr("ATTESTORS", ",", fallbackAttestors);
        // A blank `ATTESTORS=` parses as an empty list rather than as unset.
        if (attestors.length == 0) attestors = fallbackAttestors;
        for (uint256 i = 0; i < attestors.length; ++i) {
            config.setAttestor(attestors[i], true);
        }
        // Majority by default: 1 of 1, 2 of 3, 3 of 5.
        config.setAttestorThreshold(uint32(vm.envOr("ATTESTOR_THRESHOLD", attestors.length / 2 + 1)));

        config.setRulesHash(HashLib.hashRules(_rules()));
        config.setGuardian(safe);
    }

    /// @dev Read from `config/rules.json` rather than typed in here, so the
    ///      deployed rules hash cannot drift from the rules the server plays:
    ///      `packages/protocol/test/parity.test.ts` checks that file field by
    ///      field against `DEFAULT_RULES`.
    function _rules() private view returns (HashLib.Rules memory rules) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/config/rules.json"));
        rules.minPlayers = uint16(vm.parseJsonUint(json, ".minPlayers"));
        rules.maxPlayers = uint16(vm.parseJsonUint(json, ".maxPlayers"));
        rules.startingHp = uint32(vm.parseJsonUint(json, ".startingHp"));
        rules.attackDamage = uint32(vm.parseJsonUint(json, ".attackDamage"));
        rules.riposteDamage = uint32(vm.parseJsonUint(json, ".riposteDamage"));
        rules.hideEvadeBps = uint16(vm.parseJsonUint(json, ".hideEvadeBps"));
        rules.hideStormBps = uint16(vm.parseJsonUint(json, ".hideStormBps"));
        rules.stormGraceRounds = uint16(vm.parseJsonUint(json, ".stormGraceRounds"));
        rules.stormBaseDamage = uint32(vm.parseJsonUint(json, ".stormBaseDamage"));
        rules.maxRounds = uint16(vm.parseJsonUint(json, ".maxRounds"));
    }

    /// @dev Only where Uniswap v4 is deployed. Ownerless, so there is nothing
    ///      to hand over: a different route or manager means a new deployment.
    function _zap(GameEscrow escrow) private returns (ZapJoin) {
        address manager = vm.envOr("POOL_MANAGER", address(0));
        if (manager == address(0)) return ZapJoin(payable(address(0)));
        return new ZapJoin(IPoolManager(manager), escrow);
    }

    /// @dev `ProtocolConfig` is `Ownable2Step`, so `transferOwnership` only
    ///      proposes: the timelock has to call `acceptOwnership` itself. While
    ///      its delay is still zero that can be scheduled and executed at once,
    ///      in the same batch that raises the delay to its real value, so the
    ///      timelock never owns the config with a zero delay outside that call.
    function _handOver(TimelockController timelock, ProtocolConfig config, address safe, address deployer)
        private
    {
        // A queued change must not be able to land on a match that was
        // already open when it was queued: the oracle and attestor set are
        // read live, not snapshotted, so players need time to see it coming.
        uint256 delay = vm.envOr("TIMELOCK_DELAY", uint256(1 days));
        ProtocolConfig.Params memory params = config.getParams();
        uint256 matchLifetime = uint256(params.joinWindow) + params.settleWindow;
        if (delay <= matchLifetime) revert DelayTooShort(delay, matchLifetime);

        address[] memory targets = new address[](2);
        targets[0] = address(config);
        targets[1] = address(timelock);
        uint256[] memory values = new uint256[](2);
        bytes[] memory payloads = new bytes[](2);
        payloads[0] = abi.encodeCall(config.acceptOwnership, ());
        payloads[1] = abi.encodeCall(timelock.updateDelay, (delay));
        // The timelock marks executed operations with timestamp 1, so at the
        // in-memory dry run's starting timestamp of 1 a zero-delay operation
        // reads as already done. No real chain is there, and a cheatcode is
        // never broadcast, so this only ever moves a simulation's clock.
        if (block.timestamp <= 1) vm.warp(2);
        timelock.scheduleBatch(targets, values, payloads, bytes32(0), bytes32(0), 0);
        timelock.executeBatch(targets, values, payloads, bytes32(0), bytes32(0));

        // Revoke before granting, so that on a local node, where the Safe may
        // be the deployer itself, it keeps the roles it is meant to end with.
        timelock.revokeRole(timelock.PROPOSER_ROLE(), deployer);
        timelock.revokeRole(timelock.CANCELLER_ROLE(), deployer);
        timelock.grantRole(timelock.PROPOSER_ROLE(), safe);
        timelock.grantRole(timelock.CANCELLER_ROLE(), safe);
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), deployer);
    }
}
