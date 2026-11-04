// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {GameEscrow} from "../../src/GameEscrow.sol";
import {ProtocolConfig} from "../../src/ProtocolConfig.sol";
import {SessionKeyDelegate} from "../../src/SessionKeyDelegate.sol";
import {FeeRouter} from "../../src/governance/FeeRouter.sol";
import {LiquidityReserve} from "../../src/governance/LiquidityReserve.sol";
import {LmsGovernor} from "../../src/governance/LmsGovernor.sol";
import {LmsToken} from "../../src/governance/LmsToken.sol";
import {MultisigPhase} from "../../src/governance/MultisigPhase.sol";
import {RewardVesting} from "../../src/governance/RewardVesting.sol";
import {RewardsDistributor} from "../../src/governance/RewardsDistributor.sol";
import {StakedLms} from "../../src/governance/StakedLms.sol";
import {IPoolManager, PoolKey} from "../../src/interfaces/IPoolManager.sol";
import {HashLib} from "../../src/libraries/HashLib.sol";
import {SettlementLib} from "../../src/libraries/SettlementLib.sol";
import {MockAcrossSpokePool} from "../../src/mocks/MockAcrossSpokePool.sol";
import {MockERC20 as ProjectMockERC20} from "../../src/mocks/MockERC20.sol";
import {MockPoolManager} from "../../src/mocks/MockPoolManager.sol";
import {MockSequencerUptimeFeed} from "../../src/mocks/MockSequencerUptimeFeed.sol";
import {MockVrfCoordinator} from "../../src/mocks/MockVrfCoordinator.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {ChainlinkVrfAdapter} from "../../src/oracles/ChainlinkVrfAdapter.sol";
import {BridgeJoinReceiver} from "../../src/periphery/BridgeJoinReceiver.sol";
import {ZapJoin} from "../../src/periphery/ZapJoin.sol";
import {IAcrossSpokePool} from "../../src/vendor/across/IAcrossSpokePool.sol";
import {IWETH9} from "../../src/vendor/across/IWETH9.sol";
import {IVRFCoordinatorV2Plus} from "../../src/vendor/chainlink/IVRFCoordinatorV2Plus.sol";

import {Actor, ForceSendETH} from "./Actor.sol";
import {Clamp} from "./utils/Clamp.sol";
import {DecimalPrinter} from "./utils/DecimalPrinter.sol";
import {Deployer} from "./utils/Deployer.sol";
import {vm} from "./utils/Hevm.sol";
import {Logger} from "./utils/Logger.sol";
import {Math} from "./utils/Math.sol";
import {StringUtils} from "./utils/StringUtils.sol";
import {EnumerableSet} from "./utils/EnumerableSet.sol";

/// @notice Deploys the hub the way `script/Deploy.s.sol` does: real contracts
///         for everything in the protocol, mocks only for the three external
///         systems (Chainlink VRF, Across, Uniswap v4) and the sequencer feed.
///
/// @dev Windows differ from the deploy defaults on purpose. Medusa moves time
///      only by its between-call delays, and `vm.warp` does not reliably persist
///      across transactions, so a 10-minute join window would expire before a
///      lobby could fill. These stay legal under `ProtocolConfig`: every one is
///      within `MAX_WINDOW`, the timelock delay still exceeds `matchLifetime`,
///      and the cooldown still exceeds voting period plus delay (Deploy's rule).
abstract contract Base is StringUtils, Clamp, Deployer, Math {
    using DecimalPrinter for uint256;

    string[] internal ACTOR_LABELS =
        ["ActorA", "ActorB", "ActorC", "SignerA", "SignerB", "SignerC", "SessionA", "SessionB"];
    uint256 internal constant BLOCK_INTERVAL = 12 seconds;
    uint256 internal constant INITIAL_ETH_BALANCE = 1_000 ether;
    uint256 internal constant INITIAL_TOKEN_BALANCE = 1_000_000e18;
    uint256 internal constant INITIAL_STAKE = 200_000e18;

    // Lifetime: 5d + 10m + 1h + 5d + 1d + 2d = 13d 1h 10m, under the 14d delay.
    uint64 internal constant JOIN_WINDOW = 5 days;
    uint64 internal constant SETTLE_WINDOW = 5 days;
    uint64 internal constant CHALLENGE_WINDOW = 1 days;
    uint256 internal constant TIMELOCK_DELAY = 14 days;
    // Deploy's rule: cooldown > voting period + timelock delay.
    uint64 internal constant STAKE_COOLDOWN = 20 days;
    uint48 internal constant VOTING_DELAY = 1 hours;
    uint32 internal constant VOTING_PERIOD = 5 days;
    uint64 internal constant REWARD_DURATION = 7 days;
    uint256 internal constant PROPOSAL_THRESHOLD = 100_000e18;
    uint256 internal constant QUORUM_PERCENT = 4;
    uint256 internal constant QUORUM_FLOOR = 300_000e18;
    uint256 internal constant MULTISIG_PHASE = 30 days;

    uint256 internal constant LMS_SUPPLY = 100_000_000e18;
    uint256 internal constant PLAY_MINING_SHARE = 50_000_000e18;
    uint256 internal constant LIQUIDITY_SHARE = 5_000_000e18;
    uint256 internal constant LMS_PER_ETH_DISCOUNT = 20_000e18;
    uint16 internal constant STAKER_BPS = 5_000;
    uint256 internal constant MAX_REWARD_PER_ETH = 10_000e18;
    uint256 internal constant MAX_REWARD_PER_WALLET = 20_000e18;

    uint256 internal constant ATTESTOR_COUNT = 5;
    uint256 internal constant ATTESTOR_KEY_BASE = 0xA77E57;
    uint256 internal constant SIGNER_KEY_BASE = 0x51C4E2;
    uint256 internal constant SESSION_KEY_BASE = 0x5E5510;
    uint256 internal constant SESSION_KEY_COUNT = 3;
    uint256 internal constant ZAP_TOKEN_PER_ETH = 2_000e18;
    uint24 internal constant ZAP_FEE = 3_000;
    uint24 internal constant ZAP_THIN_FEE = 500;
    int24 internal constant ZAP_TICK_SPACING = 60;

    bytes32 internal constant MATCH_ABORT_TYPEHASH = keccak256("MatchAbort(bytes32 matchId)");

    // ―――――――――――――――――――――――――― Ghosts ――――――――――――――――――――――――――

    /// @dev What `_trackMatches` remembers of a match, for the write-once checks (GL-06).
    struct MatchRec {
        bool seen;
        uint128 stake;
        uint32 termsId;
        uint16 maxSeats;
        bool matchmade;
        uint40 joinDeadline;
        // From Pending.
        bool lockedSeen;
        address oracle;
        uint32 attVer;
        // From Live.
        bool liveSeen;
        bytes32 seed;
        // From Proposed.
        bool proposedSeen;
        bytes32 rankingHash;
        bytes32 historyRoot;
        bytes32 transcriptHash;
        uint16 rounds;
        // Once the match has left Open.
        bool closedSeen;
        uint16 seatCountAtClose;
        // A terminal match's whole record, seats and seat discounts included.
        bool hasFp;
        bytes32 frozenFp;
        bytes32 frozenSeatsFp;
    }

    /// @dev Bits of `Ghosts.violated`, set by the `_afterCall` hook and asserted by the
    ///      matching global property. One bit per observation that cannot be a property
    ///      on its own because it compares two points in time.
    uint256 internal constant V_STATUS = 1 << 5; // GL-05
    uint256 internal constant V_RECORD = 1 << 6; // GL-06
    uint256 internal constant V_FEE_DOWN = 1 << 9; // GL-09
    uint256 internal constant V_EPOCH_FROZEN = 1 << 10; // GL-10
    uint256 internal constant V_DEADLINE = 1 << 11; // GL-11
    uint256 internal constant V_ACCUMULATOR = 1 << 16; // GL-16
    uint256 internal constant V_REWARD_TERMS = 1 << 20; // GL-20
    uint256 internal constant V_SESSION = 1 << 25; // GL-25
    uint256 internal constant V_PROPOSAL_STATE = 1 << 27; // GL-27
    uint256 internal constant V_PHASE = 1 << 28; // GL-28
    uint256 internal constant V_CONFIG = 1 << 30; // GL-30

    /// @dev Cap on `extraAddrs`; past it `knownOverflow` turns sums of parts into upper bounds.
    uint256 internal constant MAX_EXTRA_ADDRS = 24;

    struct Ghosts {
        // Forced ETH, tracked by the donation handlers (GL-01, GL-15, GL-24).
        uint256 donatedEscrowEth;
        uint256 donatedStakedEth;
        /// @dev ETH forced into the FeeRouter since its last successful harvest.
        uint256 donatedRouterEth;
        /// @dev LMS sent straight to a contract by `lms_transfer` / `stakedLms_donateLms`, by recipient.
        mapping(address => uint256) lmsDirectIn;
        // Addresses handed to unclamped handlers, beyond `actors` (deduped, capped).
        address[] extraAddrs;
        mapping(address => bool) isExtra;
        bool knownOverflow;
        // Flows the handlers record.
        uint256 sweptStakedLms;
        uint256 rewardsSwept;
        uint256 reserveReleased;
        uint256 burnedLms;
        uint256 stakedEthDeposited;
        uint256 stakedEthClaimed;
        uint256 accrualOps;
        // Hook state (see `_afterCall` in Snapshots.sol).
        uint256 violated;
        mapping(bytes32 => uint8) lastStatus;
        mapping(bytes32 => MatchRec) matchRec;
        mapping(uint32 => bytes32) termsHash;
        uint32 lastTermsCount;
        mapping(bytes32 => uint40) originalDeadline;
        mapping(bytes32 => mapping(address => bool)) disputedBy;
        mapping(uint256 => uint256) lastEpochFees;
        mapping(uint256 => bool) frozenFlag;
        mapping(uint256 => uint256) frozenEpochFees;
        mapping(uint256 => mapping(address => bool)) frozenSeen;
        mapping(uint256 => mapping(address => uint256)) frozenFeesPaid;
        uint256 maxRps;
        uint256 maxLastAccrual;
        mapping(uint256 => bool) rateSeen;
        mapping(uint256 => uint256) rateRec;
        mapping(uint256 => uint256) capRec;
        mapping(address => mapping(uint256 => bool)) claimedSeen;
        mapping(address => mapping(uint256 => uint256)) amtRec;
        uint64 lastGuardianPauseAt;
        mapping(address => mapping(address => uint64)) grantTime;
        mapping(address => uint256) maxNonce;
        mapping(uint32 => bytes32) setHash;
        mapping(uint32 => uint32) thAt;
        uint32 maxAttVer;
        address lmsTokenSeen;
        mapping(uint256 => uint8) lastProposalState;
        uint256 timelockLmsFloor;
        bool phaseRetired;
        bool phaseLostSeen;
    }

    Ghosts internal ghosts;

    /// @dev Records an address a handler passed to the protocol, so sums over
    ///      "known addresses" (GL-02, GL-09, GL-13, GL-14, GL-18) can include it.
    ///      Call it from every handler that hands a fuzzer-chosen address to the protocol.
    function _noteAddr(address account) internal {
        if (account == address(0) || ghosts.isExtra[account]) return;
        for (uint256 i = 0; i < actors.length; ++i) {
            if (actors[i] == account) return;
        }
        if (ghosts.extraAddrs.length >= MAX_EXTRA_ADDRS) {
            ghosts.knownOverflow = true;
            return;
        }
        ghosts.isExtra[account] = true;
        ghosts.extraAddrs.push(account);
    }

    /// @dev `actors` followed by `ghosts.extraAddrs`.
    function _known() internal view returns (address[] memory known) {
        uint256 n = actors.length;
        uint256 m = ghosts.extraAddrs.length;
        known = new address[](n + m);
        for (uint256 i = 0; i < n; ++i) {
            known[i] = actors[i];
        }
        for (uint256 j = 0; j < m; ++j) {
            known[n + j] = ghosts.extraAddrs[j];
        }
    }

    // ―――――――――――――――――――――――――― Actors ――――――――――――――――――――――――――

    /// @dev Eight, as many as the largest lobby: three contract wallets, three
    ///      key-holding EOAs (bridge withdrawals are signed), two session accounts.
    address[] internal actors;
    address internal actor;
    address internal admin;

    /// @dev The key behind each EOA actor; zero for the contract wallets.
    mapping(address account => uint256 key) internal signerKeyOf;
    address[] internal signerActors;

    /// @dev Stand-ins for EIP-7702 accounts: each is its own `SessionKeyDelegate`
    ///      instance, so `address(this)` is the account and storage is per account,
    ///      exactly what a delegated EOA sees.
    SessionKeyDelegate[] internal sessionAccounts;
    address[] internal sessionKeys;
    mapping(address sessionKey => uint256 key) internal sessionKeyOf;

    address internal guardian;
    address internal matchmaker;
    address internal safe;
    /// @dev An address with no role, for calls a role must refuse.
    address internal outsider;

    modifier asActor() virtual {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    modifier asAdmin() virtual {
        vm.startPrank(admin);
        _;
        vm.stopPrank();
    }

    /// @dev Stands for a call the timelock executes once its delay has passed.
    modifier asTimelock() {
        vm.startPrank(address(timelock));
        _;
        vm.stopPrank();
    }

    modifier asGuardian() {
        vm.startPrank(guardian);
        _;
        vm.stopPrank();
    }

    modifier asMatchmaker() {
        vm.startPrank(matchmaker);
        _;
        vm.stopPrank();
    }

    modifier asSafe() {
        vm.startPrank(safe);
        _;
        vm.stopPrank();
    }

    // ―――――――――――――――――――――――― Contracts ―――――――――――――――――――――――――

    TimelockController internal timelock;
    ProtocolConfig internal config;
    GameEscrow internal escrow;
    LmsToken internal lms;
    StakedLms internal stakedLms;
    LmsGovernor internal governor;
    FeeRouter internal feeRouter;
    RewardsDistributor internal rewards;
    RewardVesting internal vesting;
    LiquidityReserve internal reserve;
    MultisigPhase internal phase;
    ChainlinkVrfAdapter internal vrf;
    BridgeJoinReceiver internal bridgeReceiver;
    ZapJoin internal zap;

    MockVrfCoordinator internal coordinator;
    MockSequencerUptimeFeed internal sequencerFeed;
    MockAcrossSpokePool internal acrossPool;
    MockWETH internal weth;
    MockPoolManager internal poolManager;
    ProjectMockERC20 internal zapToken;
    ProjectMockERC20 internal zapTokenB;

    /// @dev Sorted by address, as `SignatureLib.recoverAscending` requires.
    address[] internal attestorPool;
    uint256[] internal attestorKeys;

    // ――――――――――――――――――――――― Registries ――――――――――――――――――――――――

    /// @dev What handlers pick from, so valid identifiers reach the protocol.
    bytes32[] internal matchIds;
    uint256[] internal vrfRequestIds;
    mapping(bytes32 matchId => address[]) internal proposedRanking;
    /// @dev Fee epochs a match finalised in, for rewards and vesting handlers.
    uint256[] internal feeEpochs;
    mapping(uint256 epoch => bool) internal seenFeeEpoch;

    struct Proposal {
        address[] targets;
        uint256[] values;
        bytes[] calldatas;
        bytes32 descriptionHash;
        uint256 id;
    }

    Proposal[] internal proposals;
    uint256 internal proposalNonce;

    struct ScheduledOp {
        address target;
        bytes data;
        bytes32 salt;
    }

    ScheduledOp[] internal scheduledOps;
    uint256 internal saltNonce;

    // ―――――――――――――――――――――――――― Setup ―――――――――――――――――――――――――――

    function setup() internal {
        admin = address(this);
        guardian = address(0x6A2D);
        matchmaker = address(0x3A7C4);
        safe = address(0x5AFE);
        outsider = address(0xBAD);

        _deployTimelock();
        _deployConfigAndEscrow();
        _deployExternalMocks();
        _deployPeriphery();
        _deployGovernance();
        _distributeLms();
        _handOver();
        setupActors();
        ghosts.timelockLmsFloor = lms.balanceOf(address(timelock));
    }

    /// @dev The deployer holds the admin role only until `_handOver`.
    function _deployTimelock() private {
        address[] memory proposers = new address[](0);
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new TimelockController(TIMELOCK_DELAY, proposers, executors, address(this));
    }

    function _deployConfigAndEscrow() private {
        // The treasury is a placeholder until `_deployGovernance` names the router.
        ProtocolConfig.Params memory params = ProtocolConfig.Params({
            feeBps: 500,
            minSeats: 4,
            maxSeats: 8,
            joinWindow: JOIN_WINDOW,
            settleWindow: SETTLE_WINDOW,
            minStake: 0.001 ether,
            maxStake: 1 ether,
            treasury: address(timelock)
        });
        uint16[] memory payout = new uint16[](3);
        payout[0] = 6_000;
        payout[1] = 2_500;
        payout[2] = 1_500;
        config = new ProtocolConfig(address(this), params, payout);

        coordinator = new MockVrfCoordinator();
        vrf = new ChainlinkVrfAdapter(
            address(this), IVRFCoordinatorV2Plus(address(coordinator)), keccak256("lane"), 1, 3, 200_000
        );
        sequencerFeed = new MockSequencerUptimeFeed();
        sequencerFeed.set(true, 0);

        _sortAttestors();
        address[] memory initial = new address[](3);
        for (uint256 i = 0; i < 3; ++i) {
            initial[i] = attestorPool[i];
        }
        config.setRandomnessOracle(address(vrf));
        config.setAttestorSet(initial, 2);
        config.setRulesHash(HashLib.hashRules(HashLib.defaultRules()));
        config.setGuardian(guardian);
        config.setChallengeWindow(CHALLENGE_WINDOW);
        config.setSequencerUptimeFeed(address(sequencerFeed));
        config.setMatchmaker(matchmaker);

        escrow = new GameEscrow(config);
        vrf.setConsumer(address(escrow), true);
    }

    function _sortAttestors() private {
        for (uint256 i = 0; i < ATTESTOR_COUNT; ++i) {
            uint256 key = ATTESTOR_KEY_BASE + i;
            attestorKeys.push(key);
            attestorPool.push(vm.addr(key));
        }
        for (uint256 i = 0; i < ATTESTOR_COUNT; ++i) {
            for (uint256 j = i + 1; j < ATTESTOR_COUNT; ++j) {
                if (attestorPool[j] < attestorPool[i]) {
                    (attestorPool[i], attestorPool[j]) = (attestorPool[j], attestorPool[i]);
                    (attestorKeys[i], attestorKeys[j]) = (attestorKeys[j], attestorKeys[i]);
                }
            }
        }
    }

    function _deployExternalMocks() private {
        weth = new MockWETH();
        acrossPool = new MockAcrossSpokePool(IWETH9(address(weth)));

        poolManager = new MockPoolManager();
        zapToken = new ProjectMockERC20("Zap Token", "ZAP");
        zapTokenB = new ProjectMockERC20("Zap Token B", "ZAPB");
        // Input token to ETH: one deep pool, and one that fills only part of a stake.
        poolManager.setPool(_poolKey(address(zapToken), address(0), ZAP_FEE), ZAP_TOKEN_PER_ETH, 0);
        poolManager.setPool(
            _poolKey(address(zapToken), address(0), ZAP_THIN_FEE), ZAP_TOKEN_PER_ETH, 0.0001 ether
        );
        // A first hop, at one to one, for two-hop routes.
        poolManager.setPool(_poolKey(address(zapTokenB), address(zapToken), ZAP_FEE), 1e18, 0);
        (bool ok,) = payable(address(poolManager)).call{value: 10_000 ether}("");
        require(ok, "Base: funding the pool manager failed");
    }

    function _deployPeriphery() private {
        bridgeReceiver =
            new BridgeJoinReceiver(address(timelock), escrow, IAcrossSpokePool(address(acrossPool)));
        config.setBridgeReceiver(address(bridgeReceiver));
        zap = new ZapJoin(IPoolManager(address(poolManager)), escrow);
    }

    function _deployGovernance() private {
        lms = new LmsToken(address(this), LMS_SUPPLY);
        stakedLms = new StakedLms(lms, address(timelock), STAKE_COOLDOWN, REWARD_DURATION);
        governor = new LmsGovernor(
            stakedLms, timelock, VOTING_DELAY, VOTING_PERIOD, PROPOSAL_THRESHOLD, QUORUM_PERCENT, QUORUM_FLOOR
        );
        feeRouter = new FeeRouter(escrow, stakedLms, address(timelock), address(timelock), STAKER_BPS);

        ProtocolConfig.Params memory params = config.getParams();
        params.treasury = address(feeRouter);
        config.setParams(params);
        config.setLmsToken(address(lms));
        config.setLmsPerEthDiscount(LMS_PER_ETH_DISCOUNT);

        rewards = new RewardsDistributor(
            escrow,
            lms,
            address(timelock),
            block.timestamp / escrow.FEE_EPOCH() + 1,
            PLAY_MINING_SHARE,
            MAX_REWARD_PER_ETH,
            MAX_REWARD_PER_WALLET
        );
        vesting = rewards.vesting();
        reserve = new LiquidityReserve(lms, safe, address(stakedLms), address(timelock));
    }

    /// @dev What the actors do not get goes to the timelock, as the treasury share does.
    function _distributeLms() private {
        lms.transfer(address(rewards), PLAY_MINING_SHARE);
        lms.transfer(address(reserve), LIQUIDITY_SHARE);
        lms.transfer(
            address(timelock), LMS_SUPPLY - PLAY_MINING_SHARE - LIQUIDITY_SHARE - 8 * INITIAL_TOKEN_BALANCE
        );
    }

    /// @dev As `Deploy._handOver`: the governor and the multisig phase propose and
    ///      cancel, and the deployer ends up with no role.
    function _handOver() private {
        config.transferOwnership(address(timelock));
        vm.prank(address(timelock));
        config.acceptOwnership();
        vrf.transferOwnership(address(timelock));
        vm.prank(address(timelock));
        vrf.acceptOwnership();

        phase = new MultisigPhase(timelock, safe, address(lms), block.timestamp + MULTISIG_PHASE);
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.CANCELLER_ROLE(), address(governor));
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(phase));
        timelock.grantRole(timelock.CANCELLER_ROLE(), address(phase));
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), address(this));
    }

    function setupActors() internal {
        vm.label(admin, "Admin");

        for (uint256 i = 0; i < 3; ++i) {
            actors.push(address(new Actor{value: INITIAL_ETH_BALANCE}()));
        }
        for (uint256 i = 0; i < 3; ++i) {
            uint256 key = SIGNER_KEY_BASE + i;
            address signer = vm.addr(key);
            vm.deal(signer, INITIAL_ETH_BALANCE);
            signerKeyOf[signer] = key;
            signerActors.push(signer);
            actors.push(signer);
        }
        for (uint256 i = 0; i < 2; ++i) {
            SessionKeyDelegate account = new SessionKeyDelegate(escrow);
            vm.deal(address(account), INITIAL_ETH_BALANCE);
            sessionAccounts.push(account);
            actors.push(address(account));
        }
        for (uint256 i = 0; i < SESSION_KEY_COUNT; ++i) {
            uint256 key = SESSION_KEY_BASE + i;
            address sessionKey = vm.addr(key);
            sessionKeyOf[sessionKey] = key;
            sessionKeys.push(sessionKey);
        }

        for (uint256 i = 0; i < actors.length; ++i) {
            address _actor = actors[i];
            vm.label(_actor, ACTOR_LABELS[i]);
            lms.transfer(_actor, INITIAL_TOKEN_BALANCE);

            vm.startPrank(_actor);
            lms.approve(address(escrow), type(uint256).max);
            lms.approve(address(stakedLms), type(uint256).max);
            zapToken.approve(address(zap), type(uint256).max);
            zapTokenB.approve(address(zap), type(uint256).max);
            // Staked from the start, so votes exist before any proposal.
            stakedLms.deposit(INITIAL_STAKE);
            vm.stopPrank();
        }
        actor = actors[0];
    }

    // ――――――――――――――――――――――――― Helpers ――――――――――――――――――――――――――

    // Maps an arbitrary address to an actor address
    function toActor(address addy) internal view returns (address) {
        return actors[uint256(uint160(addy)) % actors.length];
    }

    // Maps an arbitrary address to an actor address that is different from the current actor
    function toActorNotCurrent(address addy) internal view returns (address) {
        address _actor = actors[uint256(uint160(addy)) % actors.length];
        if (_actor == actor) {
            _actor = actors[(uint256(uint160(addy)) + 1) % actors.length];
        }
        return _actor;
    }

    function _useActor(uint256 seed) internal {
        actor = actors[seed % actors.length];
    }

    /// @dev Under Foundry a pranked call spends the pranked address's ETH; under
    ///      Medusa the harness pays. Do not assert on an actor's ETH around a
    ///      payable call: read the protocol's side of the transfer instead.
    function _fund(address account, uint256 amount) internal {
        if (account.balance < amount) vm.deal(account, amount);
    }

    // Sums the native token balances of all actors
    function sumActorsBalances() internal view returns (uint256 sumOfBalances) {
        for (uint256 i; i < actors.length; i++) {
            sumOfBalances += actors[i].balance;
        }
    }

    // Sums the ERC-20 token balances of all actors for a given token
    function sumActorsERC20Balances(address _token) internal view returns (uint256 sumOfBalances) {
        for (uint256 i; i < actors.length; i++) {
            bytes memory data = abi.encodeWithSignature("balanceOf(address)", actors[i]);
            (bool success, bytes memory result) = _token.staticcall(data);
            require(success, "sumActorsERC20Balances: failed to get balance");
            sumOfBalances += abi.decode(result, (uint256));
        }
    }

    function skipBlocks(uint256 blocks) internal {
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + blocks * BLOCK_INTERVAL);
    }

    function skipTime(uint256 time) internal {
        uint256 blocks = (time + BLOCK_INTERVAL - 1) / BLOCK_INTERVAL;
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + time);
    }

    /// @dev The first match at or after `seed` in `status`; zero if there is none.
    function _matchInStatus(uint256 seed, GameEscrow.MatchStatus status) internal view returns (bytes32) {
        uint256 count = matchIds.length;
        for (uint256 i = 0; i < count; ++i) {
            bytes32 matchId = matchIds[(seed % count + i) % count];
            if (escrow.getMatch(matchId).status == status) return matchId;
        }
        return bytes32(0);
    }

    /// @dev Whether `player` may take a seat in `matchId` right now.
    function _canSeat(bytes32 matchId, address player) internal view returns (bool) {
        GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
        return info.status == GameEscrow.MatchStatus.Open && block.timestamp < info.joinDeadline
            && info.seatCount < info.maxSeats && !escrow.hasSeat(matchId, player)
            && (!info.matchmade || escrow.rostered(matchId, player));
    }

    /// @dev The first lobby at or after `seed` with a seat for `player`; zero if none.
    function _joinableMatch(uint256 seed, address player) internal view returns (bytes32) {
        uint256 count = matchIds.length;
        for (uint256 i = 0; i < count; ++i) {
            bytes32 matchId = matchIds[(seed % count + i) % count];
            if (_canSeat(matchId, player)) return matchId;
        }
        return bytes32(0);
    }

    function _shuffled(address[] memory seats, uint256 seed) internal pure returns (address[] memory order) {
        order = seats;
        for (uint256 i = order.length; i > 1; --i) {
            uint256 j = uint256(keccak256(abi.encode(seed, i))) % i;
            (order[i - 1], order[j]) = (order[j], order[i - 1]);
        }
    }

    function _trackFeeEpoch() internal {
        uint256 epoch = block.timestamp / escrow.FEE_EPOCH();
        if (seenFeeEpoch[epoch]) return;
        seenFeeEpoch[epoch] = true;
        feeEpochs.push(epoch);
    }

    /// @dev A quorum of attestor set `version` signing `digest`, ascending by signer.
    function _signQuorum(uint32 version, bytes32 digest) internal returns (bytes memory signatures) {
        uint32 threshold = config.thresholdOf(version);
        uint32 signed;
        for (uint256 i = 0; i < ATTESTOR_COUNT && signed < threshold; ++i) {
            if (!config.isAttestorAt(version, attestorPool[i])) continue;
            signatures = bytes.concat(signatures, _sign(attestorKeys[i], digest));
            ++signed;
        }
    }

    function _sign(uint256 key, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _resultDigest(
        bytes32 matchId,
        uint32 rounds,
        bytes32 historyRoot,
        bytes32 transcriptHash,
        address[] memory ranking
    ) internal view returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(
            escrow.domainSeparator(),
            SettlementLib.hashMatchResult(matchId, rounds, historyRoot, transcriptHash, ranking)
        );
    }

    function _abortDigest(bytes32 matchId) internal view returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(
            escrow.domainSeparator(), keccak256(abi.encode(MATCH_ABORT_TYPEHASH, matchId))
        );
    }

    /// @dev The key of a pool between two currencies, in v4's sorted order.
    function _poolKey(address a, address b, uint24 fee) internal pure returns (PoolKey memory) {
        (address currency0, address currency1) = a < b ? (a, b) : (b, a);
        return PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: fee,
            tickSpacing: ZAP_TICK_SPACING,
            hooks: address(0)
        });
    }

    /// @dev Sends ETH to `to` even if it refuses plain transfers, as a selfdestruct would.
    function _forceSend(address to, uint256 amount) internal {
        new ForceSendETH{value: amount}(to);
    }
}
