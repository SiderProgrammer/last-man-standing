// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Registry} from "./Registry.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {GameEscrow} from "../src/GameEscrow.sol";
import {PlayerAvatars} from "../src/PlayerAvatars.sol";
import {SessionKeyDelegate} from "../src/SessionKeyDelegate.sol";
import {ZapJoin} from "../src/periphery/ZapJoin.sol";
import {IPoolManager} from "../src/interfaces/IPoolManager.sol";
import {HashLib} from "../src/libraries/HashLib.sol";
import {MockRandomnessOracle} from "../src/mocks/MockRandomnessOracle.sol";
import {ChainlinkVrfAdapter} from "../src/oracles/ChainlinkVrfAdapter.sol";
import {IVRFCoordinatorV2Plus} from "../src/vendor/chainlink/IVRFCoordinatorV2Plus.sol";
import {MockMessenger} from "../src/mocks/MockMessenger.sol";
import {MockLayerZeroEndpoint} from "../src/mocks/MockLayerZeroEndpoint.sol";
import {LayerZeroMessenger} from "../src/adapters/LayerZeroMessenger.sol";
import {ILayerZeroEndpoint} from "../src/interfaces/ILayerZeroEndpoint.sol";
import {LmsToken} from "../src/governance/LmsToken.sol";
import {StakedLms} from "../src/governance/StakedLms.sol";
import {LmsGovernor} from "../src/governance/LmsGovernor.sol";
import {FeeRouter} from "../src/governance/FeeRouter.sol";
import {RewardsDistributor} from "../src/governance/RewardsDistributor.sol";
import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";

/// @notice Hub deploy, on Base or Base Sepolia: token-governed config,
///         randomness oracle, attestors, hub escrow.
/// @dev Governance ends up as:
///
///        sLMS votes --> LmsGovernor --proposes, cancels--> TimelockController --owns--> ProtocolConfig
///                                                           ^  (anyone may execute     StakedLms
///        Safe --cancels (veto)------------------------------+   once the delay         FeeRouter
///         |                                                     has passed)           PlayerAvatars
///         |                                                                           ChainlinkVrfAdapter
///         +- guardian: may pause GameEscrow at once, for a week at most;
///         |            may veto a proposed result, which refunds every stake
///         +- receives the liquidity share of LMS, to seed a pool
///         +- treasury: receives the non-staker share of fees
///
///      Fees: the escrow's treasury is `FeeRouter`, which passes the stakers'
///      share to `StakedLms` as ETH and forwards the rest to the treasury.
///
///      LMS: split between play-mining, the timelock, the team's vesting
///      wallet and the Safe; see `_distribute`.
///
///      The deployer holds no role and no tokens once `run` returns.
///
///      `MOCKS` picks the mock oracle and messenger or real ones. It defaults
///      to true on a local node and must be false anywhere else. With it false
///      the oracle is Chainlink VRF v2.5: pass `VRF_SUBSCRIPTION_ID`, a native-
///      funded subscription the Safe owns, and this script deploys a
///      `ChainlinkVrfAdapter` for it, makes the escrow its consumer and hands
///      it to the timelock. The Safe then adds the adapter to the subscription.
///      The coordinator and key hash default to Chainlink's on Base and Base
///      Sepolia (`VRF_COORDINATOR`, `VRF_KEY_HASH` override them). `ORACLE`
///      passes an adapter deployed separately instead. Cross-chain joins need a
///      hub `LayerZeroMessenger`: pass `LZ_ENDPOINT` and this script deploys
///      one, points it at the escrow and hands it to the timelock with the
///      config — or pass `MESSENGER` for one deployed separately, which must
///      then be owned by the timelock, never an EOA: whoever owns it can forge
///      cross-chain joins. On a local node, `MOCK_LZ=true` puts the messenger
///      over a `MockLayerZeroEndpoint`, which `npm run dev:fork` relays.
///
///      On a broadcast it writes `deployments/<chainId>.json` (see `Registry`),
///      which the server reads for its addresses. Add `--verify` to the
///      `forge script` command to verify every contract on the explorer.
///
///      Spokes come after, each with `DeploySpoke.s.sol` on its own chain,
///      behind its own Safe and timelock. The hub learns about each one by a
///      governance proposal — `setRemoteChain` on the config and `setPeer` on
///      the messenger, which the governance screen's "Add a spoke chain"
///      template builds — because both are the timelock's by then. A join sent
///      before that executes is not lost: the messenger parks it, and it is
///      retried into the seat once the proposal lands.
contract Deploy is Registry {
    /// @dev Anvil and Hardhat: the only chain on which `SAFE` may be left unset.
    uint256 private constant LOCAL_CHAIN_ID = 31_337;
    /// @dev The hub's home.
    uint256 private constant BASE_CHAIN_ID = 8453;
    uint256 private constant BASE_SEPOLIA_CHAIN_ID = 84_532;

    /// @dev Chainlink VRF v2.5 on Base: the coordinator and the 2 gwei lane.
    address private constant BASE_VRF_COORDINATOR = 0xd5D517aBE5cF79B7e95eC98dB0f0277788aFF634;
    bytes32 private constant BASE_VRF_KEY_HASH =
        0x00b81b5a830cb0a4009fbd8904de511e28631e62ce5ad231373d3cdad373ccab;
    /// @dev On Base Sepolia, whose only lane is 30 gwei.
    address private constant BASE_SEPOLIA_VRF_COORDINATOR = 0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE;
    bytes32 private constant BASE_SEPOLIA_VRF_KEY_HASH =
        0x9e1344a1247c8a1785d0a4681a27152bffdb43666ae5bf7d14d24a5efd44bf71;
    /// @dev Chainlink's L2 sequencer uptime feed on Base. Base Sepolia has none.
    address private constant BASE_SEQUENCER_FEED = 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433;
    /// @dev Blocks before the VRF node answers: 6 s on Base.
    uint256 private constant DEFAULT_VRF_CONFIRMATIONS = 3;
    /// @dev The escrow's `fulfillRandomness` costs about 50k; the rest is headroom.
    uint256 private constant DEFAULT_VRF_CALLBACK_GAS = 200_000;

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
        /// @dev The hub messenger this script deployed, if any; it is also
        ///      `messenger`. Zero when `MESSENGER` was passed or no endpoint was.
        LayerZeroMessenger hubLz;
        /// @dev The VRF adapter this script deployed, if any; it is also
        ///      `oracle`. Zero with the mocks, or when `ORACLE` was passed.
        ChainlinkVrfAdapter vrf;
        /// @dev The head when the script started: no contract here is older.
        uint256 deployBlock;
    }

    /// @dev Gas the executor gives `lzReceive` on the far side: a hub join is
    ///      about 120k, and the messenger keeps a reserve to park a failure.
    uint256 private constant DEFAULT_RECEIVE_GAS = 350_000;

    error SafeRequired();
    error MockOffLocal();
    error OracleRequired();
    error DelayTooShort(uint256 delay, uint256 matchLifetime);
    error CooldownTooShort(uint256 cooldown, uint256 votingPeriodPlusDelay);
    error RewardsUnderfunded(uint256 budget, uint256 funded);
    error TeamBeneficiaryRequired();

    function run() external returns (Deployment memory deployment) {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(pk);
        deployment.safe = _safe(deployer);
        deployment.deployBlock = block.number;

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
        _transport(deployment, deployer);
        _configure(deployment.config, deployment.oracle, deployment.safe, deployer);

        deployment.escrow = new GameEscrow(deployment.config);
        _wireHubMessenger(deployment);
        _wireVrf(deployment);
        // Cosmetic and per-chain: the same deployment is repeated on every
        // spoke, and the collections are independent of each other.
        deployment.avatars = new PlayerAvatars(
            address(deployment.timelock),
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
        _record(registry(deployment));
    }

    /// @notice The `deployments/<chainId>.json` contents for `deployment`.
    function registry(Deployment memory deployment) public returns (string memory) {
        _entry("config", address(deployment.config));
        _entry("escrow", address(deployment.escrow));
        _entry("avatars", address(deployment.avatars));
        _entry("sessionDelegate", address(deployment.sessionDelegate));
        _entry("zapJoin", address(deployment.zap));
        _entry("timelock", address(deployment.timelock));
        _entry("lmsToken", address(deployment.lms));
        _entry("stakedLms", address(deployment.stakedLms));
        _entry("governor", address(deployment.governor));
        _entry("feeRouter", address(deployment.feeRouter));
        _entry("rewardsDistributor", address(deployment.rewards));
        _entry("teamVesting", address(deployment.teamVesting));
        _entry("safe", deployment.safe);
        _entry("randomnessOracle", deployment.oracle);
        _entry("messenger", deployment.messenger);
        return _registry(deployment.deployBlock);
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
    ///      Without mocks the oracle is VRF (see the contract notes) and a
    ///      messenger is optional: neither `LZ_ENDPOINT` nor `MESSENGER` means a
    ///      hub with no spokes yet. `MOCKS=false` on a local node is a fork run
    ///      against the real ones.
    function _transport(Deployment memory deployment, address deployer) private {
        address oracle = vm.envOr("ORACLE", address(0));
        address messenger = vm.envOr("MESSENGER", address(0));
        address endpoint = vm.envOr("LZ_ENDPOINT", address(0));
        bool local = block.chainid == LOCAL_CHAIN_ID;
        bool mocks = _mocks(local);

        if (mocks && !local) revert MockOffLocal();
        if (!mocks && oracle == address(0)) {
            deployment.vrf = _vrfAdapter(deployer);
            oracle = address(deployment.vrf);
        }
        // Answers nothing on its own: something must call `fulfill` after each
        // `lockMatch`, as a VRF node would. `npm run dev:fork` does.
        if (oracle == address(0)) oracle = address(new MockRandomnessOracle());
        deployment.oracle = oracle;

        if (messenger != address(0)) {
            deployment.messenger = messenger;
            return;
        }
        LayerZeroMessenger hubLz;
        if (endpoint == address(0) && mocks && vm.envOr("MOCK_LZ", false)) {
            endpoint = address(new MockLayerZeroEndpoint());
        }
        if (endpoint != address(0)) {
            // Owned by the deployer only until `_handOver`, like the config.
            hubLz = new LayerZeroMessenger(
                deployer,
                ILayerZeroEndpoint(endpoint),
                address(0),
                uint128(vm.envOr("RECEIVE_GAS", DEFAULT_RECEIVE_GAS))
            );
            messenger = address(hubLz);
        } else if (mocks) {
            messenger = address(new MockMessenger());
        }
        deployment.messenger = messenger;
        deployment.hubLz = hubLz;
    }

    /// @dev Owned by the deployer only until `_handOver`, like the config.
    function _vrfAdapter(address deployer) private returns (ChainlinkVrfAdapter) {
        uint256 subId = _vrfSubscription();
        (address coordinator, bytes32 keyHash) = _vrfLane();
        if (subId == 0 || coordinator == address(0)) revert OracleRequired();
        return new ChainlinkVrfAdapter(
            deployer,
            IVRFCoordinatorV2Plus(coordinator),
            keyHash,
            subId,
            uint16(vm.envOr("VRF_CONFIRMATIONS", DEFAULT_VRF_CONFIRMATIONS)),
            uint32(vm.envOr("VRF_CALLBACK_GAS", DEFAULT_VRF_CALLBACK_GAS))
        );
    }

    /// @dev `VRF_SUBSCRIPTION_ID`. Virtual so a test can set it without
    ///      `vm.setEnv`, which every test in the process would see.
    function _vrfSubscription() internal view virtual returns (uint256) {
        return vm.envOr("VRF_SUBSCRIPTION_ID", uint256(0));
    }

    function _vrfLane() private view returns (address coordinator, bytes32 keyHash) {
        if (block.chainid == BASE_CHAIN_ID) {
            (coordinator, keyHash) = (BASE_VRF_COORDINATOR, BASE_VRF_KEY_HASH);
        }
        if (block.chainid == BASE_SEPOLIA_CHAIN_ID) {
            (coordinator, keyHash) = (BASE_SEPOLIA_VRF_COORDINATOR, BASE_SEPOLIA_VRF_KEY_HASH);
        }
        coordinator = vm.envOr("VRF_COORDINATOR", coordinator);
        keyHash = vm.envOr("VRF_KEY_HASH", keyHash);
    }

    /// @dev The escrow is the adapter's one consumer. Ownership follows in
    ///      `_handOver`.
    function _wireVrf(Deployment memory deployment) private {
        ChainlinkVrfAdapter vrf = deployment.vrf;
        if (address(vrf) == address(0)) return;
        vrf.setConsumer(address(deployment.escrow), true);
        vrf.transferOwnership(address(deployment.timelock));
    }

    /// @dev `MOCKS`, defaulting to whether this is a local node. Virtual so a
    ///      test can force it without `vm.setEnv`, which every test in the
    ///      process would see.
    function _mocks(bool local) internal view virtual returns (bool) {
        return vm.envOr("MOCKS", local);
    }

    /// @dev Points the hub messenger at the escrow and makes the timelock its
    ///      endpoint delegate, the one that sets its verifiers. Ownership
    ///      follows in `_handOver`.
    function _wireHubMessenger(Deployment memory deployment) private {
        LayerZeroMessenger hubLz = deployment.hubLz;
        if (address(hubLz) == address(0)) return;
        hubLz.setApp(address(deployment.escrow));
        hubLz.setDelegate(address(deployment.timelock));
        hubLz.transferOwnership(address(deployment.timelock));
    }

    function _params(address safe) private view returns (ProtocolConfig.Params memory) {
        return ProtocolConfig.Params({
            feeBps: 500,
            minSeats: 4,
            maxSeats: 8,
            // Base confirms in about 2 s, so a lobby fills and a match settles
            // in minutes; the windows only have to cover a slow server.
            joinWindow: 10 minutes,
            settleWindow: 1 hours,
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

        address[] memory attestors = _attestors(deployer);
        // Majority by default: 1 of 1, 2 of 3, 3 of 5.
        config.setAttestorSet(attestors, uint32(vm.envOr("ATTESTOR_THRESHOLD", attestors.length / 2 + 1)));

        config.setRulesHash(HashLib.hashRules(_rules()));
        config.setGuardian(safe);
        // How long the Safe has to replay a disputed match and veto it.
        config.setChallengeWindow(uint64(vm.envOr("CHALLENGE_WINDOW", uint256(1 hours))));
        config.setSequencerUptimeFeed(
            vm.envOr("SEQUENCER_FEED", block.chainid == BASE_CHAIN_ID ? BASE_SEQUENCER_FEED : address(0))
        );
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
        uint256 cooldown = vm.envOr("STAKE_COOLDOWN", uint256(10 days));
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

    /// @dev Nothing on Base mainnet until there is legal advice on paying
    ///      holders a share of a gambling protocol's revenue; governance can
    ///      raise it with one proposal. Half everywhere else, to show the
    ///      mechanism working.
    function _defaultStakerBps() internal view returns (uint256) {
        return block.chainid == BASE_CHAIN_ID ? 0 : 5_000;
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
        deployment.teamVesting =
            new VestingWallet(_teamBeneficiary(deployment.safe), vestingStart, TEAM_VESTING);
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
    function _teamBeneficiary(address safe) internal view virtual returns (address team) {
        team = vm.envOr("TEAM_BENEFICIARY", address(0));
        if (team != address(0)) return team;
        if (block.chainid != LOCAL_CHAIN_ID) revert TeamBeneficiaryRequired();
        return safe;
    }

    /// @dev A queued change must not be able to land on a match that was
    ///      already open when it was queued, so the delay must outlast a whole
    ///      match, dispute included. `ProtocolConfig` enforces it; `_handOver`
    ///      checks first, for a clearer error.
    function _timelockDelay() private view returns (uint256) {
        return vm.envOr("TIMELOCK_DELAY", uint256(3 days));
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
        uint256 matchLifetime = config.matchLifetime();
        if (delay <= matchLifetime) revert DelayTooShort(delay, matchLifetime);

        // The delay is raised first: the config refuses an owner whose delay
        // is shorter than a match. The hub messenger and the VRF adapter, if
        // this script deployed them, are accepted in the same batch: like the
        // config, never owned by a zero-delay timelock.
        bool withLz = address(deployment.hubLz) != address(0);
        bool withVrf = address(deployment.vrf) != address(0);
        uint256 calls = 2 + (withLz ? 1 : 0) + (withVrf ? 1 : 0);
        address[] memory targets = new address[](calls);
        uint256[] memory values = new uint256[](calls);
        bytes[] memory payloads = new bytes[](calls);
        targets[0] = address(timelock);
        payloads[0] = abi.encodeCall(timelock.updateDelay, (delay));
        targets[1] = address(config);
        payloads[1] = abi.encodeCall(config.acceptOwnership, ());
        if (withLz) {
            targets[2] = address(deployment.hubLz);
            payloads[2] = abi.encodeCall(deployment.hubLz.acceptOwnership, ());
        }
        if (withVrf) {
            targets[calls - 1] = address(deployment.vrf);
            payloads[calls - 1] = abi.encodeCall(deployment.vrf.acceptOwnership, ());
        }
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
