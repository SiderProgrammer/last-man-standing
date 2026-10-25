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
import {LmsToken} from "../src/governance/LmsToken.sol";
import {StakedLms} from "../src/governance/StakedLms.sol";
import {LmsGovernor} from "../src/governance/LmsGovernor.sol";
import {FeeRouter} from "../src/governance/FeeRouter.sol";
import {RewardsDistributor} from "../src/governance/RewardsDistributor.sol";
import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";

/// @notice Hub deploy: token-governed config, randomness oracle, attestors, hub escrow.
/// @dev Governance ends up as:
///
///        sLMS votes --> LmsGovernor --proposes, cancels--> TimelockController --owns--> ProtocolConfig
///                                                           ^  (anyone may execute     StakedLms
///        Safe --cancels (veto)------------------------------+   once the delay         FeeRouter
///         |                                                     has passed)
///         +- guardian: may pause GameEscrow at once, never unpause;
///         |            may veto a proposed result, which refunds every stake
///         +- receives the liquidity share of LMS, to seed a pool
///         +- treasury: receives the non-staker share of fees
///         +- owns PlayerAvatars directly: cosmetic, holds no funds, needs no delay
///
///      Fees: the escrow's treasury is `FeeRouter`, which passes the stakers'
///      share to `StakedLms` as ETH and forwards the rest to the treasury.
///
///      LMS: split between play-mining, the timelock, the team's vesting
///      wallet and the Safe; see `_distribute`.
///
///      The deployer holds no role and no tokens once `run` returns.
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
    /// @dev The hub's home: Ethereum L1.
    uint256 private constant MAINNET_CHAIN_ID = 1;

    /// @dev The LMS supply's split, in basis points. The timelock takes the
    ///      treasury and reserve shares, plus any rounding: see `_distribute`.
    uint256 private constant BPS = 10_000;
    uint256 private constant PLAY_MINING_BPS = 5_000;
    uint256 private constant TEAM_BPS = 1_500;
    uint256 private constant LIQUIDITY_BPS = 500;
    uint64 private constant TEAM_CLIFF = 365 days;
    uint64 private constant TEAM_VESTING = 3 * 365 days;

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
        LmsToken lms;
        StakedLms stakedLms;
        LmsGovernor governor;
        FeeRouter feeRouter;
        RewardsDistributor rewards;
        VestingWallet teamVesting;
        address safe;
        address oracle;
        address messenger;
    }

    error SafeRequired();
    error MockOffLocal();
    error DelayTooShort(uint256 delay, uint256 matchLifetime);
    error CooldownTooShort(uint256 cooldown, uint256 votingPeriodPlusDelay);
    error RewardsUnderfunded(uint256 budget, uint256 funded);
    error TeamBeneficiaryRequired();

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
        _governance(deployment, deployer);
        _distribute(deployment, deployer);

        deployment.config.transferOwnership(address(deployment.timelock));
        _handOver(deployment, deployer);

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
            // The hub is Ethereum L1, where a join costs real gas. Below about
            // 0.01 ETH the 5% fee is smaller than the gas of the join paying it.
            minStake: 0.01 ether,
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

        address[] memory attestors = _attestors(deployer);
        for (uint256 i = 0; i < attestors.length; ++i) {
            config.setAttestor(attestors[i], true);
        }
        // Majority by default: 1 of 1, 2 of 3, 3 of 5.
        config.setAttestorThreshold(uint32(vm.envOr("ATTESTOR_THRESHOLD", attestors.length / 2 + 1)));

        config.setRulesHash(HashLib.hashRules(_rules()));
        config.setGuardian(safe);
        // How long the Safe has to replay a disputed match and veto it.
        config.setChallengeWindow(uint64(vm.envOr("CHALLENGE_WINDOW", uint256(1 hours))));
    }

    /// @dev The quorum is a multisig over results: independent attestor keys,
    ///      most of which must agree. `ATTESTOR` is the single-key fallback.
    function _attestors(address deployer) private view returns (address[] memory attestors) {
        address[] memory fallbackAttestors = new address[](1);
        fallbackAttestors[0] = vm.envOr("ATTESTOR", deployer);
        attestors = vm.envOr("ATTESTORS", ",", fallbackAttestors);
        // A blank `ATTESTORS=` parses as an empty list rather than as unset.
        if (attestors.length == 0) attestors = fallbackAttestors;
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
        rules.strikeDamage = uint32(vm.parseJsonUint(json, ".strikeDamage"));
        rules.strikeHealBps = uint16(vm.parseJsonUint(json, ".strikeHealBps"));
        rules.guardReflectDamage = uint32(vm.parseJsonUint(json, ".guardReflectDamage"));
        rules.chargeBonusDamage = uint32(vm.parseJsonUint(json, ".chargeBonusDamage"));
        rules.chargeExposureBps = uint16(vm.parseJsonUint(json, ".chargeExposureBps"));
        rules.stallGraceRounds = uint16(vm.parseJsonUint(json, ".stallGraceRounds"));
        rules.stallDamage = uint32(vm.parseJsonUint(json, ".stallDamage"));
        rules.maxRounds = uint16(vm.parseJsonUint(json, ".maxRounds"));
    }

    /// @dev Only where Uniswap v4 is deployed. Ownerless, so there is nothing
    ///      to hand over: a different route or manager means a new deployment.
    function _zap(GameEscrow escrow) private returns (ZapJoin) {
        address manager = vm.envOr("POOL_MANAGER", address(0));
        if (manager == address(0)) return ZapJoin(payable(address(0)));
        return new ZapJoin(IPoolManager(manager), escrow);
    }

    /// @dev Token, staking vault, governor and — where v4 exists — the fee
    ///      router. The vault, the router and the timelock's roles are all
    ///      owned by the timelock, so the governor reaches them only through
    ///      the same delay as every other change.
    function _governance(Deployment memory deployment, address deployer) private {
        deployment.lms = new LmsToken(deployer, vm.envOr("LMS_SUPPLY", uint256(100_000_000e18)));

        // A voter must still be staked when the proposal they voted for
        // executes: a vote counts from the snapshot, so an unstake requested
        // right after it has to outlast the voting period and the delay.
        uint256 cooldown = vm.envOr("STAKE_COOLDOWN", uint256(7 days));
        uint256 votingPeriod = vm.envOr("VOTING_PERIOD", uint256(5 days));
        uint256 exposure = votingPeriod + _timelockDelay();
        if (cooldown <= exposure) revert CooldownTooShort(cooldown, exposure);

        deployment.stakedLms = new StakedLms(
            deployment.lms,
            address(deployment.timelock),
            uint64(cooldown),
            uint64(vm.envOr("REWARD_DURATION", uint256(7 days)))
        );

        deployment.governor = new LmsGovernor(
            deployment.stakedLms,
            deployment.timelock,
            uint48(vm.envOr("VOTING_DELAY", uint256(1 days))),
            uint32(votingPeriod),
            vm.envOr("PROPOSAL_THRESHOLD", uint256(100_000e18)),
            vm.envOr("QUORUM_PERCENT", uint256(4)),
            // 1% of the default supply: what a vote needs while little is staked.
            vm.envOr("QUORUM_FLOOR", uint256(1_000_000e18))
        );

        deployment.feeRouter = new FeeRouter(
            deployment.escrow,
            deployment.stakedLms,
            address(deployment.timelock),
            deployment.config.treasury(),
            uint16(vm.envOr("STAKER_FEE_BPS", _defaultStakerBps()))
        );
        // The deployer still owns the config, so this skips the timelock.
        ProtocolConfig.Params memory params = deployment.config.getParams();
        params.treasury = address(deployment.feeRouter);
        deployment.config.setParams(params);
    }

    /// @dev Nothing on Ethereum mainnet until there is legal advice on paying
    ///      holders a share of a gambling protocol's revenue; governance can
    ///      raise it with one proposal. Half everywhere else, to show the
    ///      mechanism working.
    function _defaultStakerBps() internal view returns (uint256) {
        return block.chainid == MAINNET_CHAIN_ID ? 0 : 5_000;
    }

    /// @dev Hands out the whole supply, so the deployer ends with none of its
    ///      own (on a local node, where it is also the Safe, it holds the Safe's):
    ///
    ///        50%  play-mining     RewardsDistributor, paid to players over four years
    ///        25%  treasury        the timelock: only a passed proposal can spend it
    ///        15%  team            a VestingWallet: nothing for a year, then linear over three
    ///         5%  liquidity       the Safe, to seed a pool
    ///         5%  reserve         the timelock, with the treasury
    ///
    ///      None of the tokens the timelock, the distributor or the vesting
    ///      wallet holds is staked, so none of them votes: governance starts
    ///      with the players, as play-mining pays them. The vesting wallet and
    ///      the distributor have no way to stake; the timelock could only by a
    ///      proposal, which needs votes it does not have.
    function _distribute(Deployment memory deployment, address deployer) private {
        LmsToken lms = deployment.lms;
        uint256 supply = lms.totalSupply();

        deployment.rewards = _rewards(deployment);
        uint256 play = (supply * PLAY_MINING_BPS) / BPS;
        lms.transfer(address(deployment.rewards), play);
        uint256 budget = deployment.rewards.totalBudget();
        if (budget > play) revert RewardsUnderfunded(budget, play);

        uint64 vestingStart = uint64(block.timestamp + TEAM_CLIFF);
        deployment.teamVesting = new VestingWallet(_teamBeneficiary(deployment.safe), vestingStart, TEAM_VESTING);
        uint256 team = (supply * TEAM_BPS) / BPS;
        lms.transfer(address(deployment.teamVesting), team);

        // Treasury and reserve, and the rounding of the other three. Counted,
        // not swept from the deployer's balance: on a local node the Safe *is*
        // the deployer, and a sweep after the Safe's share would take it too.
        uint256 liquidity = (supply * LIQUIDITY_BPS) / BPS;
        lms.transfer(address(deployment.timelock), supply - play - team - liquidity);
        lms.transfer(deployment.safe, liquidity);
        assert(lms.balanceOf(deployer) == (deployer == deployment.safe ? liquidity : 0));
    }

    function _rewards(Deployment memory deployment) private returns (RewardsDistributor) {
        uint256 epochLength = deployment.escrow.FEE_EPOCH();
        return new RewardsDistributor(
            deployment.escrow,
            deployment.stakedLms,
            address(deployment.timelock),
            // The first full epoch after the deploy, unless told otherwise.
            vm.envOr("REWARDS_FIRST_EPOCH", block.timestamp / epochLength + 1),
            (deployment.lms.totalSupply() * PLAY_MINING_BPS) / BPS,
            vm.envOr("MAX_REWARD_PER_ETH", uint256(100_000e18))
        );
    }

    /// @dev Required everywhere but a local node, like the Safe, so a missing
    ///      variable cannot quietly vest the team's tokens to the Safe.
    function _teamBeneficiary(address safe) internal view returns (address team) {
        team = vm.envOr("TEAM_BENEFICIARY", address(0));
        if (team != address(0)) return team;
        if (block.chainid != LOCAL_CHAIN_ID) revert TeamBeneficiaryRequired();
        return safe;
    }

    /// @dev A queued change must not be able to land on a match that was
    ///      already open when it was queued: the oracle and attestor set are
    ///      read live, not snapshotted, so players need time to see it coming.
    ///      Checked against the match lifetime in `_handOver`.
    function _timelockDelay() private view returns (uint256) {
        return vm.envOr("TIMELOCK_DELAY", uint256(1 days));
    }

    /// @dev `ProtocolConfig` is `Ownable2Step`, so `transferOwnership` only
    ///      proposes: the timelock has to call `acceptOwnership` itself. While
    ///      its delay is still zero that can be scheduled and executed at once,
    ///      in the same batch that raises the delay to its real value, so the
    ///      timelock never owns the config with a zero delay outside that call.
    function _handOver(Deployment memory deployment, address deployer) private {
        TimelockController timelock = deployment.timelock;
        ProtocolConfig config = deployment.config;
        address safe = deployment.safe;

        uint256 delay = _timelockDelay();
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
        // The governor is the only proposer. It also needs the canceller
        // role, which `GovernorTimelockControl` uses to cancel its own
        // queued proposals.
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(deployment.governor));
        timelock.grantRole(timelock.CANCELLER_ROLE(), address(deployment.governor));
        // The Safe's veto. Governance can revoke it through the timelock,
        // which is its own admin once the deployer renounces below.
        timelock.grantRole(timelock.CANCELLER_ROLE(), safe);
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), deployer);
    }
}
