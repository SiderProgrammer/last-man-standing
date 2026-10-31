# Across: what the cross-chain join relies on

A player on a spoke chain (Arbitrum, Optimism, Ethereum L1, or their testnets) joins a
hub lobby on Base by bridging the stake through [Across](https://across.to). This file
records what was checked about Across before building on it (FIX_PLAN step 6.1), and
what was not.

## Pinned version

- Interfaces are vendored, not installed: `contracts/src/vendor/across/`, from
  `across-protocol/contracts` **v5.0.27** (`7445f72de17900544605c7e6706c5fb3b3784738`).
  Only `depositV3`, the message-handler interface and WETH's wrap and unwrap are used.
- SpokePool and WETH addresses for every chain are in
  [`contracts/config/across.json`](../contracts/config/across.json), copied from that
  tag's `broadcast/deployed-addresses.json`. Each was then confirmed against a live
  quote from the Across API, which names the SpokePool and the input token it expects.
  The deploy scripts read the file and write the addresses they used into
  `deployments/<chainId>.json`, beside everything else they deployed.

## What a fill does (from the pinned source)

| Question | Answer |
|---|---|
| Does a contract recipient get WETH or ETH? | **WETH.** `_unwrapwrappedNativeTokenTo` unwraps only for an EOA or a 7702-delegated account; any other contract gets the wrapped token. `BridgeJoinReceiver` unwraps it. |
| Is the message handler called? | Yes: after the transfer, if the message is not empty and the recipient has code, `handleV3AcrossMessage(outputToken, amount, relayer, message)`. |
| What if the handler reverts? | The whole fill reverts. Relayers simulate before filling, so the deposit stays unfilled; after `fillDeadline` it is refunded to the `depositor` **on the origin chain, in WETH**. On testnet that refund is not reliable (see below), which is why `BridgeJoinReceiver` never reverts once the caller is the SpokePool. |
| Paying in ETH | `depositV3` with `inputToken` = the chain's WETH and `msg.value == inputAmount` wraps the ETH itself. |
| `outputToken` | Must be set: zero reverts with `InvalidOutputToken`. Joins name the hub's WETH; a withdrawal names the destination's, which the player signs. |
| Timing limits | `quoteTimestamp` within `depositQuoteTimeBuffer` before now, `fillDeadline` within `fillDeadlineBuffer` after now. The API's quote supplies both. |
| How much arrives? | Exactly `outputAmount`. V3 relayers fill the amount the deposit names or not at all, so a stale fee makes a deposit wait and then refund, never arrive short. |
| Any message a fill refuses? | `fillRelay` refuses a message whose first word is `keccak256("AcrossV5MessagePrefix.V1")` (those fill another way). A join message starts with a match id, a hash of the escrow's address and a counter, so it is never that. |

## Fees and fill time

Read from the suggested-fees API on 2026-10-31, for a 0.001 ETH WETH→WETH transfer into
Base:

| Route | Total fee | Fee % | API fill estimate | Minimum deposit |
|---|---|---|---|---|
| Arbitrum Sepolia → Base Sepolia | 2.39e12 wei | 0.24% | 10 s | 3.8e12 wei |
| Arbitrum One → Base | 2.35e12 wei | 0.24% | 1 s | 0.000223 ETH |

So a minimum-stake join costs about a quarter of a percent. Mainnet's minimum deposit
is above dust but below the 0.001 ETH minimum stake. A withdrawal to a spoke of less
than the minimum cannot be bridged; the player withdraws it on Base instead.

## Checked against the real pools

`contracts/test/fork/AcrossFork.t.sol`, opt-in with an RPC per chain, passed on
2026-10-31 against public RPCs:

- `SpokeRouter.join` is a deposit Across's pools on Arbitrum, Optimism and Ethereum
  accept, for Base's WETH.
- On Base, the pool's own `fillRelay` pays `BridgeJoinReceiver` in WETH and calls its
  handler, which seats the player; a fill with an unreadable message still lands, and
  the value waits in the receiver.
- `withdrawToChainFor` makes a deposit the Base pool accepts.

## Not done

- **A real testnet deposit with a message** (step 6.1's live check, and the optional
  demo it mentions) has not been made: it needs a funded key on a testnet spoke. The
  fill time above is the API's own estimate, not a measurement. Across documents its
  testnet as unreliable: fills take about a minute, relayers have no incentive, and
  unfilled deposits are **not** refunded. So the local stack and the unit tests use
  `MockAcrossSpokePool`, and the real contracts are checked by the fork tests above.

To make the live check, with a little Arbitrum Sepolia ETH:

1. Deploy the hub on Base Sepolia, and `DeploySpoke.s.sol` on Arbitrum Sepolia.
2. Quote `inputToken`=Arbitrum Sepolia WETH, `outputToken`=Base Sepolia WETH,
   `recipient`=the hub's `BridgeJoinReceiver`, `message`=the join's message, from
   `https://testnet.across.to/api/suggested-fees`.
3. Call `SpokeRouter.join` with the quote, and watch for `PlayerJoined` (or
   `JoinRefunded`) on the hub escrow. Or use the client, built with
   `VITE_ACROSS_API=https://testnet.across.to/api`; see [TESTNET.md](TESTNET.md).
