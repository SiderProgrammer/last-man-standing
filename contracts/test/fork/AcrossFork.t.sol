// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Fixtures} from "../helpers/Fixtures.sol";
import {BridgeJoinReceiver} from "../../src/periphery/BridgeJoinReceiver.sol";
import {SpokeRouter} from "../../src/periphery/SpokeRouter.sol";
import {IAcrossSpokePool} from "../../src/vendor/across/IAcrossSpokePool.sol";

/// @dev The fill side of Across's SpokePool, as v5.0.27 declares it. Only the
///      fork tests fill: nothing in `src` ever does.
interface IAcrossFiller {
    struct V3RelayData {
        bytes32 depositor;
        bytes32 recipient;
        bytes32 exclusiveRelayer;
        bytes32 inputToken;
        bytes32 outputToken;
        uint256 inputAmount;
        uint256 outputAmount;
        uint256 originChainId;
        uint256 depositId;
        uint32 fillDeadline;
        uint32 exclusivityDeadline;
        bytes message;
    }

    function fillRelay(V3RelayData calldata relayData, uint256 repaymentChainId, bytes32 repaymentAddress)
        external;

    function numberOfDeposits() external view returns (uint32);
}

/// @dev Addresses from `config/across.json`.
abstract contract AcrossMainnet {
    address internal constant BASE_POOL = 0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64;
    address internal constant BASE_WETH = 0x4200000000000000000000000000000000000006;
    address internal constant ARBITRUM_POOL = 0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A;
    address internal constant ARBITRUM_WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address internal constant OPTIMISM_POOL = 0x6f26Bf09B1C792e3228e5467807a900A503c0281;
    address internal constant OPTIMISM_WETH = 0x4200000000000000000000000000000000000006;
    address internal constant ETHEREUM_POOL = 0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5;
    address internal constant ETHEREUM_WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    function _b32(address account) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }
}

/// @dev The hub end against Across's real SpokePool on Base: a relayer fill
///      pays the receiver WETH and calls its handler, and a withdrawal is a
///      deposit the real pool accepts. This is what proves the vendored
///      interface, the WETH-to-a-contract behaviour and the handler signature
///      match the deployed pool; the unit suite runs against
///      `MockAcrossSpokePool` and cannot.
///
///      Opt-in, because it needs an RPC: `BASE_RPC_URL=… forge test --match-path test/fork/*`.
///      Skipped otherwise.
contract AcrossHubForkTest is Fixtures, AcrossMainnet {
    BridgeJoinReceiver private receiver;
    address private relayer;
    address private player;
    bytes32 private matchId;

    function setUp() public override {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        super.setUp();

        receiver = new BridgeJoinReceiver(owner, escrow, IAcrossSpokePool(BASE_POOL));
        vm.prank(owner);
        config.setBridgeReceiver(address(receiver));

        relayer = makeAddr("relayer");
        deal(BASE_WETH, relayer, 100 ether);
        vm.prank(relayer);
        IERC20(BASE_WETH).approve(BASE_POOL, type(uint256).max);
        player = makeAddr("player");

        vm.prank(players[0]);
        matchId = escrow.createMatch(STAKE, 4);
    }

    /// @dev What a relayer submits for a deposit `SpokeRouter` made on Arbitrum.
    function _fill(uint256 amount, bytes memory message, uint256 depositId) private {
        IAcrossFiller.V3RelayData memory relay = IAcrossFiller.V3RelayData({
            depositor: _b32(player),
            recipient: _b32(address(receiver)),
            exclusiveRelayer: bytes32(0),
            inputToken: _b32(ARBITRUM_WETH),
            outputToken: _b32(BASE_WETH),
            inputAmount: amount + 0.001 ether,
            outputAmount: amount,
            originChainId: 42_161,
            depositId: depositId,
            fillDeadline: uint32(block.timestamp + 1 hours),
            exclusivityDeadline: 0,
            message: message
        });
        vm.prank(relayer);
        IAcrossFiller(BASE_POOL).fillRelay(relay, 8453, _b32(relayer));
    }

    function test_fork_aFillSeatsThePlayer() public {
        _fill(STAKE, abi.encode(matchId, player, uint32(42_161)), 1);

        assertTrue(escrow.hasSeat(matchId, player));
        assertEq(escrow.seatOrigin(matchId, player), 42_161);
        assertEq(address(receiver).balance, 0);
        assertEq(IERC20(BASE_WETH).balanceOf(address(receiver)), 0);
    }

    /// @dev The fill lands even with a message nobody can read: the value
    ///      waits in the receiver instead of the deposit waiting forever.
    function test_fork_aBadMessageStillFills() public {
        _fill(STAKE, hex"c0ffee", 2);
        assertEq(address(receiver).balance, STAKE);
    }

    function test_fork_aWithdrawalIsADepositThePoolAccepts() public {
        _fill(STAKE, abi.encode(keccak256("gone"), player, uint32(42_161)), 3);
        assertEq(escrow.withdrawable(player), STAKE);

        uint256 playerPk = uint256(keccak256("fork player"));
        address signer = vm.addr(playerPk);
        _fill(STAKE, abi.encode(keccak256("gone"), signer, uint32(42_161)), 4);

        BridgeJoinReceiver.Withdrawal memory w = BridgeJoinReceiver.Withdrawal({
            player: signer,
            hubChainId: block.chainid,
            destinationChainId: 42_161,
            recipient: signer,
            outputToken: ARBITRUM_WETH,
            maxFee: 0.01 ether,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(playerPk, receiver.withdrawalDigest(w));
        uint32 depositsBefore = IAcrossFiller(BASE_POOL).numberOfDeposits();
        uint256 poolWethBefore = IERC20(BASE_WETH).balanceOf(BASE_POOL);

        receiver.withdrawToChainFor(
            w,
            BridgeJoinReceiver.Quote({
                outputAmount: STAKE - 0.003 ether,
                quoteTimestamp: uint32(block.timestamp),
                fillDeadline: uint32(block.timestamp + 1 hours),
                exclusiveRelayer: address(0),
                exclusivityParameter: 0
            }),
            abi.encodePacked(r, s, v)
        );

        assertEq(IAcrossFiller(BASE_POOL).numberOfDeposits(), depositsBefore + 1);
        assertEq(IERC20(BASE_WETH).balanceOf(BASE_POOL), poolWethBefore + STAKE);
        assertEq(escrow.withdrawable(signer), 0);
    }
}

/// @dev The spoke end against Across's real SpokePools on Arbitrum,
///      Optimism and Ethereum: `SpokeRouter.join` is a deposit each pool
///      accepts, for the hub's WETH on Base.
///
///      Opt-in: `ARBITRUM_RPC_URL=… OPTIMISM_RPC_URL=… MAINNET_RPC_URL=… forge test --match-path test/fork/*`.
///      Each test is skipped without its RPC.
contract AcrossSpokeForkTest is Test, AcrossMainnet {
    uint256 private constant STAKE = 0.01 ether;

    function _joinOn(string memory rpcVar, address pool, address weth) private {
        string memory rpc = vm.envOr(rpcVar, string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);

        address hubReceiver = makeAddr("hubReceiver");
        SpokeRouter router = new SpokeRouter(IAcrossSpokePool(pool), weth, 8453, hubReceiver, BASE_WETH);
        assertEq(IAcrossSpokePool(pool).wrappedNativeToken(), weth, "the address book's WETH");

        address player = makeAddr("player");
        vm.deal(player, 1 ether);
        uint32 depositsBefore = IAcrossFiller(pool).numberOfDeposits();
        uint256 poolWethBefore = IERC20(weth).balanceOf(pool);
        // A fork's deterministic addresses can already hold dust.
        uint256 routerBefore = address(router).balance;

        vm.prank(player);
        router.join{value: STAKE + 0.0005 ether}(
            keccak256("match"),
            address(0),
            SpokeRouter.Quote({
                outputAmount: STAKE,
                quoteTimestamp: uint32(block.timestamp),
                fillDeadline: uint32(block.timestamp + 1 hours),
                exclusiveRelayer: address(0),
                exclusivityParameter: 0
            })
        );

        assertEq(IAcrossFiller(pool).numberOfDeposits(), depositsBefore + 1);
        assertEq(IERC20(weth).balanceOf(pool), poolWethBefore + STAKE + 0.0005 ether);
        assertEq(address(router).balance, routerBefore, "the router keeps nothing");
    }

    function test_fork_joinsFromArbitrum() public {
        _joinOn("ARBITRUM_RPC_URL", ARBITRUM_POOL, ARBITRUM_WETH);
    }

    function test_fork_joinsFromOptimism() public {
        _joinOn("OPTIMISM_RPC_URL", OPTIMISM_POOL, OPTIMISM_WETH);
    }

    function test_fork_joinsFromEthereum() public {
        _joinOn("MAINNET_RPC_URL", ETHEREUM_POOL, ETHEREUM_WETH);
    }
}
