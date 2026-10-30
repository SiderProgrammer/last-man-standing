# Last Man Standing — feature reference

Every mechanism, standard and subsystem in the project: what it does, why it is
there, and where to find it.

This is the "what is this and why" document. Two others cover different ground,
and none of the three repeats another:

| Document | Answers |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the game plays and how the system is put together, as a narrative |
| **`FEATURES.md`** (this file) | What each feature is for, one entry at a time |
| [`TODO.md`](TODO.md) | What is unfinished and in what order it blocks a demo |

**Status labels** used throughout:

- **Live** — implemented and exercised end to end.
- **Unit-tested** — implemented and covered by tests, but never run against a
  deployed contract or a real RPC.
- **Mocked** — the third-party integration behind it is a local stub.
- **Known issue** — implemented, but with a flaw documented in the review.

Test counts at the time of writing: **190 TypeScript tests** across 18 files,
**95 Foundry tests** across 15 suites.

---

## Standards and protocols used

A quick index, since most of these are the reason a given file exists at all.

| Standard | Where | Why it is used |
| --- | --- | --- |
| **EIP-712** typed structured data | `SettlementLib`, `SessionKeyDelegate`, `protocol/eip712.ts` | Attestors and players sign a readable structure, not an opaque digest, and the domain binds a signature to one contract and one chain |
| **EIP-1153** transient storage | `SeatSetLib` | A scratch set that self-clears at end of transaction, turning the settlement permutation check from quadratic to linear |
| **EIP-1193** provider interface | `client/wallet.ts` | The browser talks to any injected wallet without knowing which one |
| **EIP-7702** EOA code delegation | `SessionKeyDelegate` | Session keys without changing the player's address — see [Account abstraction](#account-abstraction) |
| **ERC-721** non-fungible token | `PlayerAvatars` | Cosmetic avatars, one collection per chain |
| **ERC-4626** tokenised vault | `StakedLms` | A standard staking interface, with the exchange rate fixed at 1:1 — see [Token governance and staking](#token-governance-and-staking) |
| **ERC-5805 / ERC-6372** votes and clock | `StakedLms`, `LmsGovernor` | Checkpointed voting power read at a past timestamp, so votes cannot be flash-borrowed |
| **ERC-2612** permit | `LmsToken` | Approve the vault and stake in one transaction |
| **ERC-1271** contract signature validation | `SessionKeyDelegate.isValidSignature` | Lets the game server accept a login signed by a session key rather than the account key |
| **ERC-4337** account abstraction | *considered, not used* | Rejected because it would change every player's address; reasoning in [Account abstraction](#account-abstraction) |
| **LayerZero v2** messaging | `LayerZeroMessenger` | Concrete transport behind the chain-agnostic messenger interface |
| **Chainlink VRF v2.5** | `ChainlinkVrfAdapter` | Concrete source behind the chain-agnostic randomness interface |
| **Uniswap v4** | `ZapJoin` | Swaps any token for exactly the stake in native ETH — see [Paying in any token](#paying-in-any-token) |

---

## Contents

1. [Escrow and match lifecycle](#escrow-and-match-lifecycle)
2. [Hidden information: commit–reveal](#hidden-information-commitreveal)
3. [Settlement and the attestor quorum](#settlement-and-the-attestor-quorum)
4. [Randomness oracle](#randomness-oracle)
5. [Cross-chain](#cross-chain)
6. [Paying in any token](#paying-in-any-token)
7. [Governance](#governance)
8. [Token governance and staking](#token-governance-and-staking)
9. [Account abstraction](#account-abstraction)
10. [Identity and avatars](#identity-and-avatars)
11. [Gas engineering in Yul](#gas-engineering-in-yul)
12. [The off-chain engine](#the-off-chain-engine)
13. [The game server](#the-game-server)
14. [The browser client](#the-browser-client)
15. [Testing and verification](#testing-and-verification)

---

## Escrow and match lifecycle

`contracts/src/GameEscrow.sol` · **Unit-tested**

### What it does

Holds every stake and decides who gets paid. A match moves through a fixed
status machine:

```
createMatch   →  Open      terms snapshotted from ProtocolConfig
join          →  Open      a stake arrives, locally or bridged from a spoke
lockMatch     →  Pending   seat list final, randomness requested
fulfillRandomness → Live   seed delivered, the server may start play
settle        →  Settled   quorum-signed result accepted, payouts credited
cancelMatch   →  Cancelled every stake refundable
```

The match id is `keccak256(abi.encode(block.chainid, address(this), matchNonce++))`,
so ids from two deployments or two chains can never collide.

### Why each piece is there

- **Terms are snapshotted at creation.** Stake, fee, seat range, deadlines,
  payout schedule and rules hash are copied into the match when the lobby opens.
  Purpose: a governance change cannot alter the deal a player already staked
  into.
- **Locking and cancelling are permissionless.** Anyone may lock a full lobby,
  or one that is quorate and expired; anyone may cancel a match that has blown
  its deadline. Purpose: players never depend on the operator to recover a
  stake. The keeper key is a convenience, not a trusted role.
- **The seed is requested only after the seat list is final.** Purpose: nobody
  can decide whether to join based on the seed.
- **Payments are pull-based throughout.** Settlement credits an internal
  balance; nothing transfers until the recipient calls `withdraw`. Purpose: one
  reverting recipient cannot block a whole payout loop.
- **Pausing leaves `cancelMatch` and `withdraw` open.** Purpose: pausing can
  never trap player funds.
- **Fee remainder is swept to the treasury.** Integer division leftovers are
  assigned rather than stranded, so the pool is always fully distributed.

### The solvency invariant

`address(this).balance == totalOwed + totalEscrowed`, asserted by a Foundry
invariant campaign that drives the contract through random call sequences. This
is the single strongest safety property in the codebase: it holds across joins,
cancels, settlements and withdrawals in any order.

---

## Hidden information: commit–reveal

`packages/protocol/src/game/hash.ts` · `contracts/src/libraries/HashLib.sol` · **Live**

### What it does

During the commit window a player publishes only:

```
keccak256(abi.encode(matchId, round, seat, action, target, salt))
```

When the reveal window opens, they publish the preimage and the server checks it
against the commitment.

### Why

The server is authoritative and fast, which means it sees everything — unless it
physically cannot. Until the reveal window opens the server holds hashes, not
moves, so it cannot leak or trade on a pending action even if it wanted to.

Three details carry most of the weight:

- **`matchId`, `round` and `seat` are inside the hash.** Purpose: a commitment
  cannot be replayed into a later round or claimed by another seat.
- **`target` is forced to zero for every action but Strike.** Purpose: otherwise the
  number of plausible preimages would leak whether the player intended to
  strike.
- **The salt is per player per round**, persisted to `localStorage` before it is
  sent. Purpose: a refresh between commit and reveal would otherwise leave a
  commitment the player can no longer open, costing them the round.

### The history root

Each resolved round is hashed and chained into a running root, seeded with the
rules hash. Purpose: a result can only be verified against the rule set it was
actually played under, and the signed result commits to the entire match rather
than just the final ranking.

---

## Settlement and the attestor quorum

`GameEscrow.settle` · `contracts/src/libraries/SignatureLib.sol` ·
`packages/server/src/chain/attestor.ts` · **Unit-tested**

### What it does

The server plays the match, then signs an EIP-712 `MatchResult`
(`matchId`, `rounds`, `historyRoot`, `ranking`) under the domain
`LastManStanding` v1. A quorum of attestor signatures is submitted to `settle`,
which verifies them and *proposes* the result. It pays out through `finalize`
once the challenge window has closed; until then the guardian may `veto` it,
refunding every stake.

### Why it is built this way

- **EIP-712 rather than a raw digest.** Purpose: an attestor signing with a
  hardware wallet sees a structured result, and the domain binds the signature to
  one escrow on one chain.
- **Signatures must arrive in strictly ascending signer order**
  (`SignatureLib.recoverAscending`). Purpose: one rule simultaneously rejects
  duplicate signers, canonicalises the set, and costs a single comparison per
  signature instead of a nested membership loop.
- **`s` is bounded to the lower half-order and `v` to {27, 28}.** Purpose: a
  signature cannot be replayed in its malleable form.
- **The ranking must be an exact permutation of the seat set**
  (`SeatSetLib.assertPermutation`). Purpose: this caps what a compromised quorum
  can do. It can reorder the finish — it cannot omit a player, repeat one, or
  pay an address that never staked.

### Trust model, stated plainly

The quorum is trusted for the **ordering** of a result, not its **contents**.
Because the signed digest commits to the history root, anyone holding the seed
and the published move log can replay the match and *show* a signed result was
fabricated. Every player's browser runs that replay when the match ends.

Acting on it is the guardian's job, not the contract's: during the challenge
window the Safe can `veto` a result the replay does not support, and every
stake is refunded. There is no on-chain replay and no slashing — a deliberate
choice while the rules are still changing, since an on-chain verifier means
keeping a second, Solidity copy of the kernel bit-for-bit identical.

---

## Randomness oracle

`contracts/src/interfaces/IRandomnessOracle.sol` ·
`contracts/src/oracles/ChainlinkVrfAdapter.sol` · **Mocked**

### What it does

Supplies the per-match seed that every roll in the match is drawn from. The escrow requests
randomness when a lobby locks; the oracle answers; the escrow binds the answer
to the match and goes `Live`:

```solidity
bytes32 seed = keccak256(abi.encode(randomness, matchId));
```

### Why

- **The interface is deliberately narrow** — one `requestRandomness(context)`
  and one `fulfillRandomness(requestId, randomness)` callback. Purpose: a
  Chainlink VRF subscription, a drand relay or a test double all fit behind it,
  and the escrow never imports a vendor SDK. Swapping providers is a config
  change, not a rewrite.
- **The seed is drawn *after* the lobby closes.** Purpose: neither the server
  nor any player can pick moves against rolls they already know, and nobody can
  decide whether to join based on the seed.
- **The answer is bound to the match id.** Purpose: one oracle response cannot
  seed two matches, and a zero response is still a usable seed.
- **A dead request is survivable.** If the oracle never answers, `cancelMatch`
  refunds every stake once the deadline passes.

`ChainlinkVrfAdapter` maps a VRF v2.5 subscription onto this interface, tracking
its own request ids so a fulfilment can be routed back to the right consumer.
It currently targets a minimal local coordinator interface and runs against
`MockVrfCoordinator`.

> **Round entropy.** The match seed alone is public from `MatchStarted`, so it
> never drives a roll directly. Each round's rolls come from
> `roundSeed(seed, round, salts)` over every salt revealed that round, which
> nobody knows until all reveals are in.

---

## Cross-chain

`contracts/src/SpokeEscrow.sol` · `contracts/src/interfaces/ICrossChainMessenger.sol` ·
`contracts/src/adapters/LayerZeroMessenger.sol` · `packages/protocol/src/chain/chains.ts` ·
**Live on the local fork; not yet on testnets**

### What it does

Lets players on different chains sit in the same lobby and share one prize pool.

The model is **hub and spoke**. The hub chain holds all escrowed value and all
match state. A spoke holds nothing but a forwarding gate:

```
player on spoke → SpokeEscrow.join(matchId, stake)
                → messenger carries (matchId, player) + the staked value
                → hub GameEscrow.receiveMessage() seats them
                → hub records seatOrigin[matchId][player] = srcChainId
```

A stake that arrives for a seat that can no longer be taken is credited to the
player on the hub, never reverted, so nothing is stranded in transit. Payouts
stay on the hub, where `withdrawFor` lets a keeper push them to the player.

### When the hub cannot take a delivery

`LayerZeroMessenger.lzReceive` · `retry` · `packages/server/src/chain/crossChain.ts`

The refund above only helps once `receiveMessage` runs. If the hub refuses the
delivery outright — the spoke went live before governance registered it, a peer
is registered wrong, the messenger has no app — the escrow reverts. LayerZero's
executor then keeps the stake it was paid to deliver and only reports the
failure; the message stays retryable, but whoever retries has to bring the
stake again.

So the hub messenger never lets that happen. Once a message is authenticated,
it calls the escrow inside a `try`, with a reserve of gas held back; a refused
delivery is **parked**: its hash is stored by guid, its value stays in the
messenger, and `DeliveryParked` carries everything needed to retry it.
`retry(guid, …)` is permissionless and needs no value: it hands the delivery to
the escrow again, which authenticates it exactly as on arrival. Purpose: a
configuration mistake costs players a wait, never their stake. The server's
`CrossChainWatcher` retries parked deliveries on every poll, so the wait ends
as soon as the fix executes.

A call with less gas than a real join plus that reserve reverts rather than
parks. Anyone may execute a verified LayerZero message, and gas estimation
lands on the cheapest call that "succeeds" — which, with a `try`, is one that
starves the escrow and parks. Refusing those leaves the message for a properly
gassed execution. `receiveGas` is bounded below for the same reason.

### Joining from a spoke, in the client

`packages/client/src/screens/lobby.ts` · **Live on the local fork**

The server lists each spoke's `SpokeEscrow` in `hello`. A wallet on one of
them sees "Staking from Base → Ethereum hub" instead of a wrong-network
warning, and each lobby offers **Stake from BASE**: the first click asks
`quoteJoin` for the stake plus LayerZero's fee, the second pays it. The row
then reads *In transit…* until the server reports how the join landed:
seated, refunded on the hub (with the reason), or parked. Winnings and
refunds are on the hub, so the payout panel asks the player to switch there
to collect.

On a spoke whose gas token is not ETH (Polygon, BNB Chain, Avalanche), the
join is paid in that token: the executor prices the hub ETH it delivers in it
and folds its fee in. The button then reads "Stake 0.01 ETH from POL", and the
quote shows the single figure the wallet will charge, "Pay ≤ 12.3457 POL",
rather than a stake and fee in mismatched units. `ChainInfo.native` names the
token; a chain without it is taken to pay in ETH.

LayerZero's executor caps the native value one message may deliver
(`nativeCap`, per destination). A stake above it fails `quoteJoin` on the
spoke, before anything is sent; the client says so in words.

### Why

- **All value lives on one chain.** Purpose: the prize pool is never split
  across chains, so settlement is a single transaction against a single balance
  and there is no cross-chain consistency problem at payout time.
- **The transport is abstracted.** `ICrossChainMessenger` is modelled on
  LayerZero v2's send/receive shape but names nothing LayerZero-specific.
  Purpose: the adapter can be swapped for Hyperlane, CCIP or a test double
  without touching game logic.
- **Both ends are authenticated.** `receiveMessage` checks that the caller is
  the configured messenger for that source chain **and** that the origin peer is
  the configured peer. Purpose: a trusted transport still relays messages from
  untrusted senders — checking only the messenger would let anyone on a spoke
  forge a seat.

### Two id spaces

A detail worth knowing because it caused a real bug. LayerZero speaks
**endpoint ids** (`40245`), not **EVM chain ids** (`84532`); passing one off as
the other would label a Base Sepolia player "chain 40245". `LayerZeroMessenger`
translates at its boundary, so `seatOrigin` holds a chain id, or zero for a
stake placed on the hub, which `originChainId` in `protocol/chains.ts` maps to
the hub.

### Showing the origin

`packages/client/src/arena/` · **Live**

The origin rides through `Seat.chainId` into the match snapshot and is drawn as
a coloured pill above each seat, with per-chain chips in the lobby list and a
warning when the connected wallet is on a different chain than the hub.
Purpose: in a cross-chain game the origins are the point — a lobby that pulled
stakes from four chains should look like it. The warning exists because
otherwise every stake from the wrong network reverts with an error the wallet
renders unreadably.

> **Status.** `LayerZeroMessenger`'s local interface has been checked against
> `@layerzerolabs/lz-evm-protocol-v2` 3.0.168, each message carries exactly its
> lobby's stake, and a refused delivery parks rather than strands. Hub and
> spoke run together in `npm run dev:fork` over mock endpoints and a local
> relayer, and `DeploySpoke.s.sol` deploys a real spoke. Not yet run between
> two public testnets; see `TODO.md` §2.1 and `docs/TESTNET.md`.

---

## Paying in any token

`contracts/src/periphery/ZapJoin.sol` · `contracts/src/interfaces/IPoolManager.sol` ·
`GameEscrow.joinFor` · `protocol/chain/zap.ts` · `server/chain/zap.ts` ·
`client/screens/lobby.ts` · **Live** against a mainnet fork

### What it does

Lets a player join a lobby holding USDC, DAI or any other ERC-20 with a
Uniswap v4 route to ETH. The escrow still only ever sees ETH:

```
player approves ZapJoin for the token
ZapJoin.joinWithToken(matchId, path, maxAmountIn, deadline)
  → PoolManager.unlock
      → swap exact output: precisely `stake` ETH, route walked backwards
      → pull the input token from the player straight into the PoolManager
      → take the ETH
  → GameEscrow.joinFor{value: stake}(matchId, player)   seats the player, not ZapJoin
```

The route uses v4-periphery's exact-output `PathKey` convention, so the same
array can be priced off-chain with `V4Quoter.quoteExactOutput` to choose
`maxAmountIn`.

In the client, the server advertises the zap, the quoter and its token list in
`hello` (`ZAP_JOIN`, `V4_QUOTER`, `ZAP_TOKENS`), and the lobby grows a *Pay
with* picker. Joining with a token takes two clicks:

1. **Quote.** The client prices the route with the quoter and reads the
   player's balance. The button turns into `Pay ≤ 26.7866 USDC`: the quote plus
   0.5%, capped at the balance, rounded *up* for display. A balance short of the
   quote is refused here, before any wallet prompt. The quote lapses after 30 s.
2. **Pay.** If the allowance is short, an `approve` for exactly that ceiling —
   never an unlimited one — then `joinWithToken` with a ten-minute deadline.

### Why

- **Outside the escrow.** A swap brings price risk, slippage and arbitrary hook
  code. None of that belongs in the contract holding every stake, and none of it
  can reach it: all the escrow receives is a `joinFor` call carrying exactly the
  stake.
- **Exact output.** The stake is fixed, so the player buys precisely that much
  ETH and pays what it costs, bounded by `maxAmountIn`. There is no change to
  refund, and the zap holds no balance between transactions.
- **v4 rather than v3.** v4 pools can hold native ETH as `address(0)`, so the
  route ends in the currency the escrow takes, with no WETH unwrap step, and the
  flash accounting nets intermediate hops of a multi-hop route to zero inside
  one session.
- **`joinFor` needs no consent.** Paying someone into a lobby can only ever
  credit them: the seat, a refund and a payout all belong to `player`, never to
  the payer. It still passes every seating rule `join` does, and the invariant
  campaign drives it alongside `join`.
- **Partial fills are rejected.** v4 ends an exact-output swap early, without
  reverting, when a pool runs out of liquidity, and hooks can move either side
  of a delta, so every hop checks that it received exactly what it asked for.
- **Two clicks, not one.** The wallet's prompt for `joinWithToken` shows a
  contract call, not a price, so the player sees and accepts the ceiling in the
  game's own UI first.
- **Never through the session key.** Its scope is the escrow and the avatar
  collection. A token approval is exactly the kind of call a prompt-free key
  should not be able to make.
- **USDT-safe approvals.** USDT returns nothing from `approve` and refuses to
  move one non-zero allowance to another, while every join leaves its unused
  slippage allowance behind. The client approves through a return-less ABI and,
  when the direct approval will not simulate, zeroes the allowance first.
- **Routes are server configuration.** A route whose first hop is not the
  token itself is dropped at boot, since the contract charges `path[0]` and
  would take a different token than the one the player picked.

> **Status.** `IPoolManager` is a local mirror of v4-core's ABI. The unit suite
> runs against `MockPoolManager`; `test/fork/ZapJoinFork.t.sol` runs the real
> mainnet `PoolManager` when `MAINNET_RPC_URL` is set. Fee-on-transfer and
> rebasing tokens are unsupported: the session ends unsettled and the call
> reverts. Approval is a plain ERC-20 `approve`, so a first join costs two
> transactions; Permit2 is in `TODO.md`. Verified end to end on an anvil mainnet
> fork: the quoted 26.653262 USDC was exactly what left the wallet for a
> 0.01 ETH seat.

---

## Governance

`contracts/src/ProtocolConfig.sol` · `contracts/src/governance/` · **Unit-tested**

### What it does

One contract holding every governable parameter, owned by a
`TimelockController` whose only proposer is the token governor. A multisig (a
Safe) keeps a veto:

```
sLMS votes --> LmsGovernor --proposes, cancels--> TimelockController --owns--> ProtocolConfig
                                                   ^ (anyone executes once     StakedLms
Safe --cancels (veto)------------------------------+  the delay has passed)    FeeRouter
 +- guardian: may pause GameEscrow at once, never unpause;
 |            may veto a proposed result, refunding every stake
 +- treasury: receives the non-staker share of fees
 +- owns PlayerAvatars directly
```

How voting power is earned is described in
[Token governance and staking](#token-governance-and-staking).

| Parameter group | Contents |
| --- | --- |
| Economics | `feeBps`, `minStake`, `maxStake`, `treasury` |
| Lobby shape | `minSeats`, `maxSeats`, `joinWindow`, `settleWindow` |
| Payouts | Per-position schedule in basis points |
| Rules | `rulesHash` — digest of the off-chain rule set |
| Randomness | `randomnessOracle` address |
| Attestation | Attestor allowlist, `attestorCount`, `attestorThreshold` |
| Cross-chain | Trusted `messengerFor` and `peerFor`, per remote chain |
| Emergency | `guardian` — may pause the escrow, or veto a proposed result, without the delay |
| Settlement | `challengeWindow` — how long a proposed result waits, open to a veto, before it pays |

`GameEscrow` reads this contract and never writes to it.

### Why

- **Token vote behind a timelock, with a multisig veto.** Purpose: no single
  key can change the protocol. That matters more than it looks: whoever owns the config can swap the
  randomness oracle (and so choose seeds) or add an attestor and lower the
  threshold (and so sign results). Stakers propose and vote; the timelock makes the
  change public before it lands, so players can see a fee increase or a new
  oracle coming and leave. The deploy script refuses a delay shorter than
  `joinWindow + settleWindow`, because the oracle and attestor set are read live
  rather than snapshotted.
- **A guardian that can only stop money moving.** Purpose: an emergency stop cannot wait a
  day. `GameEscrow.pause()` is open to the guardian (and the owner) and skips
  the timelock; `unpause()` is owner-only, so resuming waits out the
  delay. A compromised guardian can therefore halt new play — refunds survive
  a pause — but can never lift a pause that was put in place to stop an exploit.
  Two consequences for whoever holds the guardian keys: a pause also blocks
  `settle`, so every match in play ends by cancellation and refund rather than
  by result; and to recover from a rogue guardian, governance queues
  `setGuardian(newSafe)` and `unpause()` as one timelock batch, so the pause is
  lifted with the guardian already replaced. The guardian's other power, `veto`,
  is bounded the same way: it refunds a proposed result's stakes and can never
  pay them anywhere else.
- **`Ownable2Step`.** Purpose: ownership transfer requires the new owner to
  accept, so governance cannot be accidentally handed to an address nobody
  controls.
- **Every setter validates.** The fee is capped at `MAX_FEE_BPS` = 1000 (10%) —
  governance *cannot* exceed it, timelock or not. Seats are bounded by
  `ABSOLUTE_MAX_SEATS` = 256, which is not arbitrary: the seat index is a
  `uint8` in the commit preimage. Stake and window ranges must be coherent.
- **The attestor threshold is re-validated on every membership change.**
  Purpose: the set can never be shrunk below its own quorum, which would
  otherwise brick settlement for every live match at once.
- **The payout schedule must sum to exactly 10,000 bps** — 100% of the pool
  *after* the fee — **and can never be longer than `minSeats`.** Purpose: a
  schedule summing to less would silently divert the shortfall to the treasury
  on every settlement, and one longer than the smallest legal lobby would index
  past the ranking and brick settlement.
- **Snapshotting at the escrow boundary.** Governance moves parameters; matches
  already in flight keep the terms they started with.

### What is missing

The Safe's veto is meant to be temporary, and nothing removes it yet: a
proposal calling `timelock.revokeRole(CANCELLER_ROLE, safe)` would. The hub `LayerZeroMessenger` is deployed by `Deploy.s.sol` when
`LZ_ENDPOINT` is set and handed to the timelock with the config;
`SpokeEscrow` and its messenger by `DeploySpoke.s.sol`, which proposes the
spoke's own timelock as their owner. `ChainlinkVrfAdapter` is still not
deployed by a script; it must be constructed with the hub timelock as its
owner. One Safe and timelock per chain. The config
can also be deployed with a zero `rulesHash` and zero oracle — a valid-looking
but unusable state that only the deploy script currently prevents.

---

## Token governance and staking

`contracts/src/governance/` · `packages/server/src/chain/feeKeeper.ts` · **Unit-tested**

### What it does

Staking LMS does three things at once: it gives you **votes**, it **earns** a
share of protocol fees in ETH, and it **commits** you to the outcome of your vote.
Playing earns LMS: half the supply is paid out to players, by the fees they
paid, already staked.

```
GameEscrow --fees--> FeeRouter --harvest (anyone)--> treasury (Safe)        [100% - stakerBps]
    |                    |
    |                    +--ETH--> StakedLms vault --streamed over 7 days--> each staker, pro rata
    |                                   ^
    +--fees per player per week         | LMS --deposit--> sLMS (1:1, ERC20Votes) --votes--> LmsGovernor
         |                              |
         +--> RewardsDistributor --claim, as sLMS--> each player
```

| Contract | Role |
| --- | --- |
| `LmsToken` | Plain fixed-supply ERC-20 with permit. No owner, no mint. Holding it gives **no** votes. |
| `StakedLms` | Staking vault whose shares (sLMS) are the voting token, always one per LMS. Collects the stakers' share of fees as ETH and pays it out evenly over `rewardDuration`, pro rata; each staker claims with `claimRewards`. Unstaking is a two-step `requestUnstake` → `claim` with a cooldown. |
| `LmsGovernor` | OpenZeppelin Governor reading sLMS votes, queuing through the existing timelock, with a minimum quorum. |
| `FeeRouter` | The escrow's `treasury`. `harvest`, open to anyone, pulls fees and splits them between the vault and the treasury. |
| `RewardsDistributor` | Play-mining. Reads the escrow's per-week fee totals and pays each player their share of that week's LMS budget, deposited into `StakedLms` for them. |
| `FeeKeeper` (server) | Calls `harvest` on a timer. Holds no role; anyone else can harvest too. |

Defaults, all overridable through the deploy environment:

| Setting | Default | Env |
| --- | --- | --- |
| LMS supply | 100,000,000, split as below | `LMS_SUPPLY` |
| Unstake cooldown | 10 days | `STAKE_COOLDOWN` |
| Staker reward payout | over 7 days | `REWARD_DURATION` |
| Voting delay / period | 1 day / 5 days | `VOTING_DELAY`, `VOTING_PERIOD` |
| Proposal threshold | 100,000 sLMS (0.1%) | `PROPOSAL_THRESHOLD` |
| Quorum | 4% of staked supply, but never under 1,000,000 sLMS | `QUORUM_PERCENT`, `QUORUM_FLOOR` |
| Stakers' share of fees | 0% on Ethereum mainnet, 50% elsewhere | `STAKER_FEE_BPS` |
| Play-mining cap | 100,000 LMS per ETH of fees | `MAX_REWARD_PER_ETH` |
| First play-mining week | the first full week after the deploy | `REWARDS_FIRST_EPOCH` |
| Team vesting beneficiary | required off a local node | `TEAM_BENEFICIARY` |

### Why

- **Only staked tokens vote.** Purpose: tie governance to people who are
  committed, not to whoever holds LMS on an exchange. sLMS self-delegates on
  receipt, so staking alone is enough to vote. Votes are read at the proposal's
  snapshot, so stake bought after a proposal appears cannot vote on it.
- **A cooldown instead of slashing.** Purpose: commitment without a fraud
  proof. `requestUnstake` burns the shares immediately (so they stop voting and
  stop earning) and the LMS is released only after the cooldown. The deploy
  script refuses a cooldown that does not outlast `votingPeriod + timelock
  delay`, so whoever voted for a proposal is still staked when it executes.
- **Fees are paid out in ETH, not used to buy LMS.** Purpose: nothing to
  sandwich, nothing to price, nothing to trust. An earlier design swapped the
  stakers' share for LMS on Uniswap; that needed a pool, a keeper trusted with
  the timing and a price floor, and still left a sandwich window open. Paying
  the ETH itself needs none of it. The cost is that stakers claim, and there is
  no buy pressure on LMS.
- **Rewards are streamed, not paid at once.** Purpose: pay for time staked,
  not for being staked at the right moment. Paid out the instant it arrived, a
  harvest would go to whoever was staked *then*: anyone could stake, call the
  permissionless `harvest` and claim a full share of every fee since the last
  one in a single transaction, then leave — earning as much for a second as a
  week-long staker did. Each deposit, plus whatever of the last one is still
  unpaid, is spread over a fresh `rewardDuration` instead (Synthetix-style).
  While nothing is staked the stream pauses, so nothing is lost.
- **A reward-per-share accumulator.** Purpose: pay every staker exactly their
  share without looping over stakers. `rewardPerShare` only grows; it is
  brought up to date, and each account settled, in `_update` before any
  balance moves, so a deposit, transfer or unstake can never carry rewards
  earned by someone else.
- **A minimum quorum.** Purpose: no vote passes on a sliver of the supply.
  OpenZeppelin's quorum is a fraction of the *staked* supply, so with little
  staked it is tiny — with 2M sLMS staked, 4% is 80k, under the proposal
  threshold, and one proposer could pass anything alone. The governor takes
  the larger of the fraction and `quorumFloor`. The floor is checkpointed like
  the fraction, so changing it never affects a vote in progress, and capped at
  10% of the LMS supply, so it cannot be raised out of everyone's reach.
- **One sLMS is always one LMS.** Purpose: rule out the ERC-4626 donation
  ("inflation") attack without a locked seed deposit. `totalAssets` is the LMS
  actually staked, tracked by the vault, not its token balance, so LMS sent to
  it directly cannot move the rate; governance can sweep it with `sweepStray`.
- **Harvesting is open to anyone.** Purpose: no keeper to trust or replace. It
  only moves fees to where the router already sends them, so the worst a caller
  can do is pay the gas for everyone else.
### The fee keeper

`FeeKeeper` runs in the game server when `FEE_ROUTER` and `KEEPER_PK` are set,
and calls `harvest` whenever at least `HARVEST_MIN_WEI` (0.05 ETH) is waiting in
the escrow. Any funded key works: harvesting needs no role.

### Distributing the supply

The deploy script splits the whole supply; the deployer keeps none.

| Share | Bucket | Held by |
| --- | --- | --- |
| 50% | Play-mining | `RewardsDistributor`, paid to players over four years |
| 25% | Treasury | The timelock: only a passed proposal can spend it |
| 15% | Team | An OpenZeppelin `VestingWallet`: nothing for a year, then linear over three |
| 5% | Liquidity | The Safe, to seed a pool |
| 5% | Reserve | The timelock, with the treasury |

None of the timelock's, the distributor's or the vesting wallet's tokens is
staked, so none of them votes. Governance starts with the players, as
play-mining pays them, rather than with the Safe. There is no token sale.

### Play-mining

`contracts/src/governance/RewardsDistributor.sol` · the fee totals in `GameEscrow`

Players earn LMS in proportion to the **fees they paid**, entirely on-chain: no
server computes anything and no Merkle root is posted.

- **The escrow keeps two totals per week** (`FEE_EPOCH`, Unix weeks): what each
  player paid in fees, `feesPaid[player][week]`, and what everyone paid,
  `epochFees[week]`. They are written when a match **settles**, in the week it
  settles in, because that is when the fee is actually paid. An expired lobby,
  an aborted or vetoed match never pays one, so never counts. Counting at join
  instead — the first version of this — let a player sit in a lobby that could
  never fill, claim rewards on its fee once the week ended, then cancel for a
  full refund.
- **Who pays the gas.** Joins cost what they always did. `finalize` writes one
  counter per seat, so it costs more: for a four-seat match, about 113k gas
  more when it is those players' first settlement of the week, about 28k after.
  The server's keeper is what calls `finalize`, so this is an operator cost.
- **Each week has a budget**, falling by a quarter every year for four years,
  and the budgets add up to the 50M funded. A player who paid 1% of a week's
  fees gets 1% of its budget.
- **Why fees, not wins.** Wins are zero-sum: one person running every wallet in
  a lobby can decide who wins for nothing. Fees are a real cost, and they go to
  stakers and the treasury. With a fixed budget split by fees, farming defeats
  itself — every extra fee a farmer pays lowers what each fee earns.
- **A cap per ETH of fees** (`maxRewardPerEth`). In a quiet week the split alone
  would hand the whole budget to whoever paid the little there was. What the
  cap leaves unpaid stays in the distributor; governance may sweep it only
  after claims close, a year after the program ends.
- **When.** A week can be claimed the moment it ends. A total only grows while
  its week is the current one, so an ended week's totals — and every player's
  share of it — never change again; a match still in play when the week ends
  counts in the week it settles. The rate is fixed by the first claim, so a
  later change to the cap cannot treat two claimants of one week differently,
  and the claims of a week add up to at most its budget.
- **Paid as sLMS.** The distributor deposits into `StakedLms` for the player, so
  rewards vote at once and selling them takes the unstake cooldown first.
  `claim(player, weeks[])` takes any number of weeks, so a player can claim
  rarely, and anyone may claim for anyone — it can only pay the player.

### The staking panel

The lobby screen shows a **Stake LMS** panel whenever the server has
`STAKED_LMS` set:

- **Rewards.** ETH earned from fees, in the header, and a **Claim ETH** button
  once there is any.
- **Play-mining**, when the server has `REWARDS_DISTRIBUTOR` set: the LMS
  earned by playing and not yet claimed, and a **Claim LMS** button that claims
  every week at once, as sLMS. With nothing waiting it says how play earns it.
- **Position.** Staked LMS, votes and wallet balance.
- **Stake** in one transaction: an EIP-2612 permit signature plus
  `depositWithPermit`, instead of an approval and a deposit. The permit is
  attempted rather than required, so a copied signature submitted first cannot
  make the deposit fail.
- **Unstake** an amount of LMS (converted to sLMS, rounded up so it covers the
  amount), then a countdown and a **Withdraw** button once the cooldown ends.
- **Delegate** the stake's votes to another address, and **Back to me** to take
  them back. On L1 every vote costs gas, so most small holders are better off
  handing their votes to someone who votes anyway; the sLMS stays in the wallet
  and keeps earning. sLMS received later — a play-mining claim, say — follows
  the delegate already chosen. The zero address is refused, since delegating to
  it would switch the votes off.

### The governance screen

A **Governance** button in the top bar opens every proposal made to
`LmsGovernor`, newest first, when the server has `GOVERNOR_ADDRESS` set:

- **Where proposals come from.** The governor cannot list its own proposals, so
  the server indexes `ProposalCreated` from `GOVERNOR_FROM_BLOCK` in 10k-block
  chunks and serves them at `/proposals`. That list holds only what the event
  says, which never changes; state, tallies, quorum and the voter's power are
  read live from the chain by the client.
- **What a proposal does.** Each action is decoded against every function the
  timelock is expected to call, with the known contracts named and timelock
  roles spelled out, so revoking the Safe's veto reads as
  `revokeRole(CANCELLER_ROLE, 0x…)`. A call that matches nothing is shown raw and
  flagged, never hidden; so is any action that sends ETH. Proposal text is
  untrusted, and is only ever written into the page as text.
- **Voting.** For, Against or Abstain, with an optional on-chain reason. Power is
  the sLMS held when voting opened; before then the card shows the power held
  now, which is what it will be if nothing changes. Quorum counts For and
  Abstain, as `GovernorCountingSimple` does.
- **Queue and Execute.** Anyone can move a passed proposal into the timelock and
  execute it once the delay is over; the card offers each step when it is
  possible and says how long is left otherwise.

- **Making a proposal.** **New proposal** opens a form: a title, a reason, and
  one or more actions picked from templates — the stakers' share of fees, the
  protocol fee, the treasury, the guardian, the unstake cooldown, the voting
  period, resuming play, and removing the multisig's veto. Each template takes
  plain values (a percentage, a number of days, an address), checks them
  against the limits the contracts enforce — a fee above 10% or a cooldown
  outside 1–30 days is refused before a vote is wasted on it — and encodes the
  one call that does it. Every action is previewed with the decoder voters
  see. A custom call is the escape hatch, and is flagged like any other
  unrecognised call. The form shows the proposer's power against the
  threshold up front, read one second in the past as the governor reads it.
  The protocol-fee template resends every other parameter as it is now, and
  says so: it would undo another parameter change that executes first.

`npm run dev:fork` shortens voting to open in a minute and last thirty, lowers
the proposal threshold and the minimum quorum to 1,000 sLMS, streams staker
rewards over an hour instead of a week, stakes 1,000 LMS for each dev player
(enough to propose), harvests after every match, and makes a demo proposal to
raise the stakers' fee share to 60%. The operator's stake comes from the Safe's
liquidity share, since on a local node the operator is the Safe. A play-mining
claim needs a match settled in a week that has ended, so it takes moving the
fork's clock (`evm_increaseTime`) past the end of the week.

### The Safe's veto: when it goes

The veto is training wheels. The intended rule, to be carried out by a
proposal calling `timelock.revokeRole(CANCELLER_ROLE, safe)`: once players hold
more sLMS than the team's 15% allocation, or twelve months after launch,
whichever comes first. Nothing enforces it on-chain; the governance form has a
template for the proposal.

### What is missing

- **A quiet start.** Nothing votes at launch: the treasury, reserve, team and
  play-mining tokens are unstaked by design. No proposal can pass until players
  hold enough sLMS to meet the 1M quorum floor. The cap is what usually
  decides how long that takes: at 100,000 LMS per ETH, 1M LMS needs 10 ETH of
  fees paid in settled matches — 200 ETH of stakes at the 5% fee. Only once a
  week's fees pass about 3.5 ETH does the weekly budget bind instead, and even
  then it takes three weeks. Until then the guardian can still pause the
  escrow and veto results, but no parameter can change.
- **Hub chain only.** Spokes take no fees today; if they ever do, each needs
  its own route back to the hub's router. Play-mining already counts spoke
  players, since their seats are taken on the hub.
- **Regulatory.** A token that pays holders a share of a gambling protocol's
  revenue may be a security, or a licensing issue, depending on jurisdiction,
  and paying LMS for play may be read as an inducement to gamble. The stakers'
  share defaults to 0% on mainnet until there is advice; play-mining has no
  such switch short of a cap of zero (`setMaxRewardPerEth(0)`).

---

## Account abstraction

`contracts/src/SessionKeyDelegate.sol` · `packages/client/src/wallet/session.ts` · **Unit-tested**

### The problem

Playing should not mean approving a transaction every few minutes. The dominant
cost is not the stake — it is the **login**. The gateway authenticates with a
signed nonce and issues a fresh one per connection, so every reconnect (a
dropped socket, a refresh, a laptop waking up) prompts the wallet, often in the
middle of a round with a commit clock running.

### Why EIP-7702 and not ERC-4337

In this protocol **the address is the identity**. `GameEscrow` keys seats,
rankings and payouts by the address that staked, and `seatOrigin` records where
it staked from. Migrating players onto freshly deployed ERC-4337 smart accounts
would change every one of those addresses and strand existing seats.

An EIP-7702 authorization keeps the exact same address and merely gives it code:

```
0xef0100 || delegateAddress      ← the account's code after delegation
```

### How it works

1. The player signs one authorization pointing their EOA at `SessionKeyDelegate`
   and, in the same transaction, calls `grantSession` **on themselves** — a call
   that only resolves because the authorization in that same transaction put the
   code there.
2. The browser generates and stores a session key locally.
3. That key signs login nonces with no wallet prompt.

That is all the client uses it for. Joins, mints and every other transaction
are the player's own, through their wallet: see
[Logins only, on L1](#logins-only-on-l1).

Storage lives in the *delegating account*, not in the delegate: under 7702 the
delegate's code runs with the EOA as `address(this)`. One deployment per chain
serves every player and holds nothing itself.

### Scope — three axes, all enforced on-chain

A session key that can do anything is just the account key with extra steps.

| Axis | Enforcement | Purpose |
| --- | --- | --- |
| **Time** | `validUntil`, with no "never expires" option | A forgotten key stops working on its own |
| **Value** | Cumulative `spendCap` in native token | A leaked key cannot drain the account |
| **Calls** | Explicit `(target, selector)` allowlist | A key scoped to joining matches cannot move the player's avatar NFT |

The client grants an empty allowlist and a spend cap of zero
(`SESSION_GRANT` in `wallet/wallet.ts`): the key can call nothing and move
nothing, so a leaked one can log in as the player until it expires, and do
nothing else.

### ERC-1271: how the server accepts a session login

A session-key signature does not recover to the account address, so `ecrecover`
alone cannot verify it. `SessionKeyDelegate.isValidSignature` answers for the
account: valid for the root key (the account never stops being an EOA under
7702) and for any live session key.

The gateway's verifier is therefore injected — offline `ecrecover` in
practice-only mode, an RPC-backed ERC-1271 check when an RPC exists. The server
will not advertise a delegate it cannot verify against, because a session login
the gateway would reject is worse than not offering one.

### Logins only, on L1

The delegate can do more than the client asks of it: `executeWithSession` lets
anyone submit a call a session key signed, so a server could pay the gas for
prompt-free joins. It is not used. The hub is Ethereum L1, and a sponsored call
there is the operator paying L1 gas for it — a relayed join costs roughly
120–150k gas, about what the fee on a minimum-stake match earns, and mints and
withdrawals earn nothing at all. Most L1 protocols leave gas to the user; the
ones that hide it (UniswapX, CoW Swap) take it back out of the transaction
itself. So the server accepts no relayed calls, and players send their own.

Payouts are pull-only: the server never sends one. A player withdraws with
their own wallet. A gasless withdrawal comes back as `withdrawFor` through a
session (FIX_PLAN 5.3) or an EIP-712 signed withdrawal (6.4).

If prompt-free joins come back, the shape that fits L1 is the one those
protocols use: the player signs a join intent against their escrow balance, the
keeper batches a match's intents into one transaction, and the gas comes out of
the pot alongside the fee.

### Digest parity

`sessionCallDigest` in `protocol/session.ts` mirrors the delegate's EIP-712
hashing and is pinned to it by frozen vectors on **both** sides, exactly as the
commit hashes are. Nothing in the client signs calls today, but the delegate
still accepts them, so the vectors stay: a drift would silently break any
relayer added later.

The verifying contract in the domain is the **account**, never the delegate:
under 7702 the delegate's code runs as the account, so a digest naming the
shared implementation would be equally valid against every player who delegated
to it.

> **Status.** 22 Foundry tests cover real `vm.signAndAttachDelegation`
> delegations. The browser half — viem's `signAuthorization` against a real
> wallet — needs Anvil on `--hardfork prague` or a Pectra testnet.

---

## Identity and avatars

### Wallet-as-identity login

`packages/server/src/gateway/gateway.ts` · **Live**

The server issues a random nonce on connect; the wallet signs
`Last Man Standing login\nnonce:<nonce>`; the server recovers the address.

Purpose: the wallet *is* the account — no passwords, no session store, no
registration — and it is the same address that staked on-chain, so the server
never has to reconcile two notions of "who this is". The login signature proves
address ownership and nothing else; it cannot authorise a transfer.

### NFT avatars

`contracts/src/PlayerAvatars.sol` · `packages/server/src/chain/avatars.ts` ·
**Unit-tested**

An ERC-721 collection deployed **independently per chain**. Free mint, one per
wallet, capped supply, with an `equipped` slot choosing which owned avatar a
wallet wears.

- **Per chain, not bridged.** Purpose: a player mints on the chain they already
  play from and never has to bridge to look like themselves. The collection that
  applies to a seat is the one on the chain that seat staked from — the same
  origin the chain badge shows.
- **Outside consensus, deliberately.** Nothing about an avatar reaches the
  commit hash, round hashes, history root or rules hash. The engine cannot see
  one and a replay is identical with or without. Purpose: a cosmetic that could
  change a result would be pay-to-win; one that entered the hash chain would
  break replay for anyone without the metadata. This is why avatars travel in
  their own wire message instead of inside `PublicMatchState`.
- **Transfers clear the sender's equipped slot.** Purpose: `avatarOf` can never
  name a token the wallet has sold.
- **Every failure is soft.** Resolving an avatar means a chain read *and* an
  IPFS fetch, either of which can hang. `AvatarRegistry` resolves in the
  background after the room is already playable, caches per wallet including the
  misses, and degrades to "no avatar" on any error. The seat falls back to a
  plain circle and the match is unaffected.
- **The metadata hop happens server-side.** Purpose: one gateway policy, one
  cache and one timeout, instead of every connected browser independently
  fetching the same eight files from a public IPFS gateway.

---

## Gas engineering in Yul

`contracts/src/libraries/` · **Live**

Four libraries drop into hand-written Yul where the ABI encoder is measurably
wasteful. Every one has a plain-Solidity reference implementation beside it and
a differential fuzz test proving they agree — including with dirty high bits in
calldata addresses.

| Library | Technique | Why it is worth it |
| --- | --- | --- |
| `SettlementLib` | Hashes the ranking straight out of calldata into scratch memory | Settlement is the only path that moves value *and* hashes a variable-length array on every call; the encoder version copies the ranking twice |
| `SignatureLib` | One reusable `ecrecover` frame for the whole batch | Runs `threshold` times per settlement |
| `SeatSetLib` | EIP-1153 transient storage as a scratch set | Turns the permutation check from quadratic to linear, which is what matters at the 256-seat ceiling |
| `HashLib` | Hand-rolled `chainHistory` and `drawBps` | Two- and three-word hashes with no encoder overhead |

`SeatSetLib` deserves a note on why transient storage fits: transient slots are
discarded at end of transaction and rolled back on revert, so the failure path
needs no cleanup at all — while the happy path still clears every mark it sets,
so a second call in the same transaction starts clean.

Measured: **451 gas cheaper per settlement at eight seats**, growing with lobby
size. `contracts/.gas-snapshot` is committed and `npm run sol:snapshot:check`
fails on drift.

---

## The off-chain engine

`packages/engine/src/` · **Live**

### What it does

The deterministic kernel that decides what happens in a round, with no I/O
whatsoever.

- **`kernel/resolve.ts`** — `resolveRound(rules, seed, round, states, moves, quietRounds)`
  is pure and total. It does not read the clock, does not use floating point, and
  does not depend on the order moves arrive in. A move its player's cooldown rules
  out is resolved as no move, the same way `Match` rejects it at reveal.
- **`match/match.ts`** — the per-match state machine: commit → reveal → resolve, phase
  guards, commitment verification, the cooldowns and the stall streak, ranking, and
  the public snapshot (which shows every seat's loaded Charge and last action).
- **`match/replay.ts`** — recomputes an entire match from the seed and published move
  log, and checks a claimed result against it.
- **`bots/strategy.ts`** — seeded bots: `always`, `randomStrategy`, `readerStrategy`,
  and the house bot `smartStrategy`. Every one of them only ever picks a move its
  cooldowns allow. The house bot reads each opponent's revealed moves and
  cooldowns, samples plausible rounds, plays each of its legal moves against the
  same samples, and keeps the one that comes out best on HP kept, HP dealt and
  kills. Easy and normal play a random move 6 and 3 rounds in 10; hard never does.
  `npm run sim` puts hard at about 2x its share of wins, ahead of every mindless
  strategy, and fails the build if any mindless strategy wins its share or turns
  a profit under the payout schedule.

### Why purity matters here

This is the most valuable property in the codebase: it is what makes an
independent check *possible*. Because resolution is deterministic and
integer-only, any third party holding the seed and the move log can reproduce
the exact same ranking and show a signed result was fabricated. Everything in the trust model
rests on it.

Two supporting decisions:

- **The public snapshot never carries a pending action.** Purpose: the broadcast
  cannot leak a hidden move even by accident.
- **A guaranteed single winner.** If a round would wipe the lobby, the player
  with the least overkill survives on 1 HP. Purpose: settlement needs a total
  order; a full wipe would strand the prize pool.

---

## The game server

`packages/server/src/` · **Live** (practice) · **Unit-tested** (staked)

| File | Responsibility |
| --- | --- |
| `main.ts` | Composition root: reads the config, wires every component, listens |
| `index.ts` | The package's public exports. Importing it boots nothing |
| `config.ts` | Environment configuration |
| **`match/`** | **One live match** |
| `match/room.ts` | Phases, the round clock, client fan-out, held moves (a move a player hands over with its commit, checked against the commitment *and* the rules there and then, which the server reveals for them if they drop) |
| **`bots/`** | **The house players** |
| `bots/bots.ts` | `BotDriver`: plays the house seats, with seed-derived salts |
| **`lobby/`** | **Which matches exist, and what happens when one ends** |
| `lobby/lobby.ts` | Room registry; creates practice lobbies, adopts on-chain matches, finalises results; ticks every room's clock, isolating a room that throws so it cannot stall the others or take the process down |
| `lobby/store.ts` | Match archive: in-memory by default, Postgres when `DATABASE_URL` is set |
| **`gateway/`** | **The socket boundary** |
| `gateway/gateway.ts` | Session registry, wallet login, message dispatch |
| `gateway/frames.ts` | Frame decoding and the error frame that goes back when it fails |
| **`chain/`** | **Everything that talks to a chain** |
| `chain/bridge.ts` | `ChainBridge`: discovers lobbies, serves the directory, locks ready lobbies, opens a room once a match is seeded — only if the match's on-chain `rulesHash` is the rule set this server plays; otherwise it never locks the lobby, and calls off and refunds a live one rather than playing it under other rules |
| `chain/escrowReader.ts` | The hub as an interface, plus the viem implementation of it |
| `chain/attestor.ts` | Signs the EIP-712 result, packs signatures, submits `settle` |
| `chain/avatars.ts` | `AvatarRegistry`: reads each seat's NFT on its own chain and resolves the image |
| `chain/viem.ts` | Client construction for a chain known only by id and RPC URL |

### Design decisions worth knowing

- **The room owns the clock but never reads it.** `tick(now)` is driven from
  outside — a 250 ms interval in production, a loop in tests. Purpose: a whole
  match runs deterministically in a test without timers.
- **Clients are opaque sinks.** `Room` talks to a `Client` interface with a
  single `send`. Purpose: the state machine has no idea WebSockets exist.
- **`ChainBridge` converges through one polling loop** rather than a web of
  event subscriptions — it discovers lobbies from `MatchCreated`, re-reads each
  tracked match, and acts on what it finds. Purpose: a missed block, a restart
  or a flaky RPC costs a few seconds rather than a desynchronised server.
- **A room only opens for a match that is already `Live`.** Purpose: the server
  cannot start play before the seed exists, so it can never choose moves against
  rolls it already knows.
- **Seat origins come from `PlayerJoined`**, which already carries them, cached
  per seat. Purpose: the escrow is only read for a seat that joined before the
  backfill window, instead of once per seat per poll.
- **The archive is best-effort.** Everything needed to audit a match is in the
  signed result plus the move log, so losing the archive costs history browsing,
  not correctness.

> **Known issues.** No rate limiting, message size cap or connection cap; any
> authenticated wallet can create unlimited practice rooms; round state is held
> only in memory, so a restart mid-match loses the round and the match can then
> only end by cancellation.

---

## The browser client

`packages/client/src/` · **Live**

| File | Responsibility |
| --- | --- |
| `main.ts` | Entry point, three lines: calls `start()` |
| `app.ts` | `start()`, and the switch that routes each server message to the screen that owns it |
| `context.ts` | `AppState`, plus the shared `dom` and `net`, assigned once at boot |
| `motion.ts` | GSAP, with its plugins registered and lag smoothing off. Import `gsap` from here |
| **`assets/`** | **Everything loaded at boot** |
| `assets/manifest.ts` | The Pixi asset manifest: the replay's effect textures |
| `assets/loader.ts` | Loads the manifest once, skipping any file that fails rather than failing the lot |
| **`screens/`** | **What the player sees, and the controls on it** |
| `screens/loading.ts` | The boot screen: a progress bar while assets load |
| `screens/lobby.ts` | Practice, the staked-lobby directory, create and join |
| `screens/match.ts` | Commit/reveal handshake, panels, replay hold, history feed, timer |
| **`wallet/`** | **The player's account** |
| `wallet/flows.ts` | Connect, login, session keys, avatar and hub-chain panels |
| `wallet/wallet.ts` | Injected EIP-1193 session, login signature, escrow / avatar / session calls |
| `wallet/session.ts` | The browser's login-only session key: load, grant, sign logins |
| **`game/`** | **Match logic that runs in the browser** |
| `game/phase.ts` | *Pure.* `phasePlan` — what the controls should be, and whether a reveal is due |
| `game/reads.ts` | *Pure.* Derives per-opponent tendencies and tells from the public history |
| `game/salts.ts` | Persists the sealed move so a refresh cannot cost the player the round |
| **`arena/`** | **The Pixi canvas** |
| `arena/arena.ts` | Pixi scene: seats on a circle, HP arcs, chain badges, avatars, ⚡ on charged seats, the stall wall |
| `arena/choreography.ts` | *Pure.* Turns a `RoundRecord` into a schedule of timed beats |
| `arena/replay.ts` | Builds the round's GSAP timeline: HP drains and heals, shatters, the stall flare |
| `arena/effects.ts` | Adds the visual effects to that timeline: projectiles, shields, particles, shake, winner |
| `arena/theme.ts` | The arena's palette and text styles, including the replay's effect tints |
| `arena/layout.ts` | *Pure.* Seat-ring and arena-wall geometry |
| **`ui/`** | **The DOM around the canvas** |
| `ui/dom.ts` | `queryDom(document)` — the element registry, as a factory |
| `ui/views.ts` | *Pure.* Target options, chain chips, reads table, hub label, avatar panel |
| `ui/format.ts` | *Pure.* `short`, `describeDraft`, `formatCountdown` |
| `ui/chrome.ts` | `toast` and `showMatchScreen`, the helpers more than one screen uses |
| **`io/`** | **Browser I/O** |
| `io/net.ts` | Typed socket with backoff reconnect, re-auth, and an outbox |
| `io/storage.ts` | `localStorage` that cannot throw, shared by `game/salts.ts` and `wallet/session.ts` |

### Why these choices

- **The arena renders only published state.** During commit, a seat shows *that*
  it has committed, never what. Purpose: the view cannot leak a hidden move.
- **The reveal is automatic.** The player already chose during the commit
  window. Purpose: a second click would only manufacture no-shows.
- **The reads panel is bookkeeping, not privileged data.** It is computed from
  the same history every spectator receives — it just does the counting a player
  would otherwise do on paper. Purpose: this is the actual game. After five
  rounds you are playing the table, not the dice.
- **Reconnect re-auths and re-attaches.** Purpose: a dropped socket does not
  drop the seat.
- **A dev burner wallet behind `VITE_DEV_KEY`.** Purpose: the practice loop needs
  nothing but a login signature, and requiring a wallet extension to click
  through the game locally is pure friction. Dev builds only.

---

## Testing and verification

### Cross-implementation parity

The same hashes are computed in TypeScript and in Solidity, and both sides are
pinned to **frozen vectors**:

| Hash | TypeScript | Solidity |
| --- | --- | --- |
| Commit, round, history, `drawBps` | `protocol/test/parity.test.ts` | `test/unit/HashLib.t.sol` |
| Session call digest | `protocol/test/session.test.ts` | `test/unit/SessionKeyDelegate.t.sol` |

Purpose: if an encoding ever drifts, exactly one suite fails instead of the two
implementations diverging silently. For the commit hash that failure mode is
severe — players could not open their commitments on-chain at all.

### Differential fuzzing

Every Yul routine is fuzzed against its plain-Solidity reference, including with
dirty high bits in calldata addresses. Purpose: hand-written assembly is only
acceptable if something independent proves it agrees with readable code.

### Invariant campaign

A stateful Foundry campaign drives `GameEscrow` through random call sequences
while asserting solvency. A deeper run is available with `FOUNDRY_PROFILE=deep`.

### Property tests

The engine is checked for termination, unique ranking, HP bounds, determinism,
replay equivalence and tamper detection over randomly generated strategy pools.

### Gas

`contracts/.gas-snapshot` is committed; `npm run sol:snapshot:check` fails on
drift. `SettlementLibGas.t.sol` additionally asserts the Yul hasher is never
worse than the encoder reference, warming the harness first so the measurement
is not dominated by cold-account access.

### Commands

```bash
npm test               # TypeScript: protocol, engine, server
npm run typecheck      # whole monorepo, strict — including every test file
npm run sol:test       # Foundry: unit, fuzz, invariant
npm run sol:fuzz       # fuzz suites only
npm run sol:invariant  # invariant suites only
npm run sol:snapshot   # refresh the gas snapshot
npm run dev:fork       # whole staked stack on a mainnet fork, token payment included

# Uniswap v4 fork test, against the real PoolManager. Skipped without the RPC.
MAINNET_RPC_URL=https://… forge test --root contracts --match-path 'test/fork/*'
```

---

## Configuration reference

| Variable | Default | Feature it controls |
| --- | --- | --- |
| `WS_PORT` | `8787` | Gateway port |
| `CHAIN_ID` | `84532` | Hub chain (Base Sepolia) |
| `COMMIT_MS` / `REVEAL_MS` | `20000` / `12000` | Round windows |
| `RPC_URL` | — | Chain bridge, ERC-1271 logins |
| `ESCROW_ADDRESS` | zero | The escrow to watch and settle against |
| `ATTESTOR_PK` | — | Result signing and settlement relay |
| `KEEPER_PK` | `ATTESTOR_PK` | Permissionless `lockMatch`, `finalize` and `cancelMatch` |
| `SESSION_DELEGATE` | zero | EIP-7702 session keys (needs `RPC_URL`) |
| `ZAP_JOIN` / `V4_QUOTER` / `ZAP_TOKENS` | zero / zero / — | Paying in tokens; all three or none |
| `AVATAR_COLLECTIONS` | — | Per-chain avatar collections, as JSON |
| `IPFS_GATEWAY` | `https://ipfs.io/ipfs/` | Avatar metadata resolution |
| `DATABASE_URL` | — | Postgres (e.g. Neon): match archive, analysis cache, play styles |
| `VITE_WS_URL` | host `:8787` | Server the browser connects to |
| `VITE_DEV_KEY` | — | Dev-only burner wallet |

Annotated template in [`.env.example`](../.env.example).

---

*Reflects the working tree at 22 Sep 2026 · 104 TypeScript and 95 Foundry tests
passing. Unfinished work is tracked in [`TODO.md`](TODO.md).*
