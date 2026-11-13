# Across: what the cross-chain join relies on

A player on a spoke chain (Arbitrum, Optimism, Ethereum L1, or their testnets) joins a
hub lobby on Base by bridging the stake through [Across](https://across.to). This file
records what was checked about Across before building on it, and what was not.

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

## The live testnet deposit

Tried on 2026-11-12, from OP Sepolia into a Base Sepolia lobby, with
`npm run play -- join <match> --players 1 --from op --net testnet`:

- The deposit went out (OP Sepolia tx `0xe856e944…d04c`, deposit id 1000545,
  0.001 ETH plus a 0.0000043 ETH fee), and Across's API indexed it with the right
  recipient, output and message.
- **No testnet relayer filled it.** It stayed `pending` past the lobby's 20-minute join
  window. Over the same hours, Across's testnet relayers did fill deposits into Base
  Sepolia from Sepolia and Arbitrum Sepolia, all with an empty message. Ours was the only
  one with a message and the only one left unfilled. That points to the testnet
  relayers skipping message deposits, not to a fill that would fail.
- **The fill itself works.** `fillRelay` for that exact deposit, simulated on a Base
  Sepolia fork against the deployed pool, receiver and escrow, goes through (171k gas).
  During the join window it seats the player; after it, the 0.001 ETH is credited to the
  player on the hub, as designed.

- That deposit expired unfilled at its two-hour fill deadline. Across does not refund
  one on testnet, so its 0.001 ETH is gone.

**A live seat, with our own key as the relayer (2026-11-13).** A second join from OP
Sepolia, deposit id 1000546 (tx `0xa6cb79fc…da49`), was filled at once from
`DEPLOYER_PK` with the Base Sepolia pool's own `fillRelay` (tx `0x6fbbe674…e435`). The
real pool paid `BridgeJoinReceiver`, which seated the player in the open lobby, and the
escrow records the seat's origin as OP Sepolia. Across's API lists the deposit as
`filled` by that transaction.

So everything on our side is proven live on testnet: the spoke deposit, Across's real
pools, the receiver and the escrow. The one thing still not seen is a fill by Across's
own testnet relayers, which looks like their choice, not ours. Whether mainnet relayers
fill these deposits promptly is not measured either; the fork tests in
`AcrossFork.t.sol` prove the mainnet pools accept and fill them. The local stack and the unit tests keep using `MockAcrossSpokePool`.

To do it again:

1. Fund a player on a spoke and give it a little hub ETH for gas (`npm run testnet -- fund`).
2. `npm run play -- create --stake 0.001 --seats 4 --as 1 --net testnet`.
3. `npm run play -- join <match> --players 1 --from op --relay --net testnet` (or `arb`,
   `eth`). This quotes the fee, deposits, fills the deposit from `DEPLOYER_PK` (wrapping
   and approving WETH as needed), and waits for the seat. Without `--relay` it waits for
   Across's relayers instead. `npm run play -- relay <spoke tx> --from op` fills a
   deposit that was already made, up to its fill deadline.
   Follow a deposit at `https://testnet.across.to/api/deposit/status?originChainId=…&depositId=…`.

Our fill is asked to be repaid on Base Sepolia, but Across's testnet may never repay it:
count each `--relay` as costing the relayer the stake.
