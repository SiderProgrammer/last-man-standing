# Last Man Standing — feature reference

Every mechanism and standard in the project: what it does, why it is there, and
where to find it, one entry at a time. How the pieces fit together is
[`ARCHITECTURE.md`](ARCHITECTURE.md), including each package's file table; why
the big decisions went the way they did is [`adr/`](adr/README.md); what is
unfinished is [`TODO.md`](TODO.md); the environment is
[`.env.example`](../.env.example).

**Status labels:** **Live** — exercised end to end. **Unit-tested** — covered
by tests, never run against a deployed contract or a public RPC. **Mocked** —
the third-party integration behind it is a local stub.

---

## Standards and protocols used

| Standard | Where | Why it is used |
| --- | --- | --- |
| **EIP-712** typed structured data | `SettlementLib`, `SessionKeyDelegate`, `BridgeJoinReceiver`, `packages/consensus/src/eip712/` | Attestors sign results, wallets sign session grants and withdrawals, and session keys sign every move as a readable structure; the domain binds a signature to one contract or chain |
| **EIP-1153** transient storage | `SeatSetLib` | A scratch set that self-clears at end of transaction, turning the settlement permutation check from quadratic to linear |
| **EIP-1193** provider interface | `client/wallet/wallet.ts` | The browser talks to any injected wallet without knowing which one |
| **EIP-7702** EOA code delegation | `SessionKeyDelegate` | One-click joins and withdrawals without changing the player's address — see [Account abstraction](#account-abstraction) |
| **ERC-721** | `PlayerAvatars` | Cosmetic avatars, one collection per chain |
| **ERC-20 wrapper** | `StakedLms` | Stake LMS for sLMS one for one |
| **ERC-5805 / ERC-6372** votes and clock | `StakedLms`, `LmsGovernor` | Checkpointed voting power read at a past timestamp, so votes cannot be flash-borrowed |
| **ERC-2612** permit | `LmsToken` | Approve and stake, or pay a fee discount, in one transaction |
| **ERC-1271** | `SessionKeyDelegate.isValidSignature` (root key only), the gateway's grant check | Lets the server accept a session grant signed by a contract wallet |
| **ERC-4337** | *considered, not used* | It would change every player's address; see [Account abstraction](#account-abstraction) |
| **Across** V3 SpokePool | `SpokeRouter`, `BridgeJoinReceiver` | Bridges a spoke stake to the hub with a join message, and a hub balance back out |
| **Chainlink VRF v2.5** | `ChainlinkVrfAdapter` | The concrete source behind the chain-agnostic randomness interface, paid in native ETH |
| **Uniswap v4** | `ZapJoin` | Swaps any token for exactly the stake in native ETH |

---

## Escrow and match lifecycle

`contracts/src/GameEscrow.sol` · **Unit-tested**

Holds every stake and decides who gets paid. A match moves through a fixed
status machine:

```
createMatch        →  Open       terms snapshotted from ProtocolConfig
join               →  Open       a stake arrives, locally or bridged from a spoke
lockMatch          →  Pending    seat list final, randomness requested
fulfillRandomness  →  Live       seed delivered, the server may start play
settle             →  Proposed   quorum-signed result stored, challenge window opens
finalize           →  Settled    window closed unvetoed, payouts credited
cancelMatch / veto / abortMatch → Cancelled   every stake refundable
```

The match id is `keccak256(abi.encode(block.chainid, address(this), matchNonce++))`,
so ids from two deployments or two chains never collide.

- **Terms are snapshotted at creation** — stake, fee, seat range, deadlines,
  payout schedule, rules hash. A governance change cannot alter the deal a
  player already staked into.
- **Locking and cancelling are permissionless.** Players never depend on the
  operator to recover a stake; the keeper key is a convenience, not a role.
- **The seed is requested only after the seat list is final**, so nobody can
  decide whether to join based on it.
- **Payments are pull-based.** Settlement credits a balance; nothing moves
  until the recipient calls `withdraw` (or a relayer calls `withdrawFor`, which
  pays only the account). One reverting recipient cannot block a payout loop.
- **Pausing leaves `cancelMatch` and `withdraw` open**, so a pause never traps
  funds, and a guardian pause expires after 7 days unless governance extends it.
- **Matchmade lobbies** take a seat only with a server-signed `JoinTicket`, and
  only they earn play-mining; private lobbies keep join-by-id.

**The solvency invariant:** `address(this).balance == totalOwed + totalEscrowed`,
asserted by a Foundry invariant campaign over random call sequences — joins,
cancels, settlements, vetoes and withdrawals in any order.

---

## Hidden information: commit–reveal

`packages/consensus/src/game/hash.ts` · `contracts/src/libraries/HashLib.sol` · **Live**

During the commit window a player publishes only
`keccak256(abi.encode(matchId, round, seat, action, target, salt))`; in the
reveal window, the preimage. Until then the server holds hashes, not moves, so
it cannot leak or trade on a pending action.

- **`matchId`, `round` and `seat` are inside the hash**, so a commitment cannot
  be replayed into another round or claimed by another seat.
- **`target` is zero for every action but Strike**, or the number of plausible
  preimages would leak whether the player meant to strike.
- **The salt is persisted before it is sent**, so a refresh between commit and
  reveal cannot cost the player the round.
- **Every commit and reveal is signed** by the key the wallet granted, and the
  server answers each commit with a signed `CommitReceipt`: the server can drop
  a move but not invent or alter one, and a dropped move with a receipt is
  provable.
- **The round's rolls come from the commitment set**, fixed when the commit
  window closes, so withholding a reveal cannot re-roll the round.

**The history root.** Each resolved round — moves, salts, commitments, HP and
eliminations — is hashed and chained into a running root seeded with the rules
hash. A result is verifiable only against the rule set it was played under, and
the signed result commits to the whole match, not just the ranking.

---

## Settlement and the attestor quorum

`GameEscrow.settle` · `SignatureLib` · `packages/server/src/attestor/` · **Unit-tested**

The server plays the match and archives its transcript; the attestor, in a
process of its own that replays the transcript first, signs an EIP-712
`MatchResult` (`matchId`, `rounds`, `historyRoot`, `transcriptHash`, `ranking`).
`settle` checks the quorum and *proposes* the result; `finalize` pays it once
the challenge window closes. Until then a seated player may `dispute` (48 h
more) and the guardian may `veto` (every stake refunded) or dismiss.

- **EIP-712, not a raw digest**, so a hardware wallet shows a structured result
  and the domain binds it to one escrow on one chain.
- **Signatures in strictly ascending signer order** reject duplicates and
  canonicalise the set at one comparison each.
- **Low-`s`, `v` ∈ {27, 28}**, so no signature replays in its malleable form.
- **The ranking must be an exact permutation of the seats**, which caps a
  compromised quorum at reordering the finish: it cannot drop a player, repeat
  one, or pay an address that never staked.

**Verifiable, not enforced.** Anyone can fetch the transcript by its hash,
check every signature, replay the match and *show* a result was fabricated;
every player's browser does this once a result is proposed and offers Dispute.
Acting on it is the guardian's job, and a guardian that neither vetoes nor
dismisses lets the result finalise — the liveness assumption. There is no
on-chain replay and no slashing; see [ADR 0002](adr/0002-verifiable-not-enforced.md)
and the README's trust model.

---

## Randomness oracle

`IRandomnessOracle` · `ChainlinkVrfAdapter` · **Unit-tested; fork-tested on Base Sepolia**

The escrow requests randomness when a lobby locks and binds the answer to the
match: `seed = keccak256(abi.encode(randomness, matchId))`.

- **A narrow interface** — `requestRandomness` and a `fulfillRandomness`
  callback — so VRF, a drand relay or a test double fit behind it and the
  escrow imports no vendor SDK.
- **Drawn after the lobby closes**, so nobody picks moves or seats against
  rolls they know.
- **VRF v2.5, paid in native ETH**, on a subscription the Safe owns; only
  registered consumers may request, or anyone could drain it.
- **The callback never reverts.** VRF does not retry, so the word is stored
  first and `deliver` retries delivery; a dead request is refunded by
  `cancelMatch` past the deadline.
- **Round entropy.** The match seed is public from `MatchStarted`, so it never
  drives a roll alone: each round's rolls come from `roundSeed(seed, round,
  commitments)`.

---

## Cross-chain

`SpokeRouter` · `BridgeJoinReceiver` · `packages/contracts/src/spokes.ts` ·
[ACROSS.md](ACROSS.md) · **Live on the local fork and on mainnet forks; not yet
on Across's testnet**

Players on different chains share one lobby and one prize pool. The hub holds
all value and all match state; a spoke holds nothing:

```
player on spoke → SpokeRouter.join(matchId, 0, quote)  with stake + Across's fee
                → Across SpokePool deposit to the hub's BridgeJoinReceiver,
                  message (matchId, player, spoke chain id)
relayer on hub  → fills exactly the stake in WETH, then handleV3AcrossMessage
                → receiver unwraps, GameEscrow.bridgeJoin() seats the player
```

- **All value lives on one chain**, so settlement is one transaction against
  one balance, with no cross-chain consistency problem at payout.
- **A value bridge, not a message bus.** The stake has to move anyway; Across
  moves it and the join together, paid by the depositor. Nothing of ours to
  configure per chain.
- **Nothing to forge.** `bridgeJoin` takes only the configured receiver, and
  the receiver only the hub SpokePool, which pays before it calls. Anyone may
  deposit any message; it only ever buys someone a seat with real ETH.
- **A fill never reverts.** A seat that is gone is credited to the player on
  the hub; an unroutable fill stays in the receiver for the timelock to
  `recover`. A revert would leave the deposit waiting, and on testnet maybe
  never refunded.
- **The way back out.** A player signs a `Withdrawal` (no chain id in its
  domain, so a spoke wallet can sign it) and the server's relayer submits
  `withdrawToChainFor`, bridging the whole balance to the chain and address
  named, Across's fee capped by the signature.
- **Contract wallets name their hub account**, since their address on a spoke
  may be someone else's on the hub; an EOA delegated under 7702 is still an EOA.

Each seat shows its origin chain as a badge, and every write first switches the
wallet to the chain it is for, or refuses with both chains named.

---

## Paying in any token

`ZapJoin` · `GameEscrow.joinFor` · `packages/contracts/src/zap.ts` ·
**Live against a mainnet fork**

A player holding USDC, DAI or any ERC-20 with a Uniswap v4 route to ETH joins
through `ZapJoin`, which swaps for exactly the stake and calls
`GameEscrow.joinFor{value: stake}(matchId, player)`. The client prices the
route with `V4Quoter` first and shows the ceiling (quote + 0.5%) before any
wallet prompt.

- **Outside the escrow.** Price risk, slippage and hook code never reach the
  contract holding every stake; it only ever sees a `joinFor` with the stake.
- **Exact output**, so there is no change to refund and the zap holds nothing
  between transactions.
- **v4**, because pools hold native ETH and flash accounting nets
  intermediate hops to zero.
- **`joinFor` needs no consent**: paying someone in can only credit them.
- **Partial fills are rejected**: every hop checks it received exactly what it
  asked for.
- **Never through the session key**, whose scope is `join` and `withdrawFor`;
  a token approval is exactly what a prompt-free key must not make.
- **Exact, USDT-safe approvals**: never unlimited, zeroed first when the token
  refuses to move one non-zero allowance to another.

Fee-on-transfer and rebasing tokens are unsupported.

---

## Governance

`ProtocolConfig` · `contracts/src/governance/` · **Unit-tested**

One contract holds every governable parameter, owned by a `TimelockController`
whose proposer is the token governor. During the multisig phase a Safe also
proposes and cancels, through `MultisigPhase`:

```
sLMS votes --> LmsGovernor --proposes, cancels--> TimelockController --owns--> ProtocolConfig
                                                   ^ (anyone executes once     StakedLms, FeeRouter,
Safe --> MultisigPhase --proposes, cancels---------+  the delay has passed)    BridgeJoinReceiver, …
 guardian: pause GameEscrow at once (7 days), veto a proposed result
 treasury: the timelock
```

| Parameter group | Contents |
| --- | --- |
| Economics | `feeBps`, `minStake`, `maxStake`, `treasury`, `lmsPerEthDiscount` |
| Lobby shape | `minSeats`, `maxSeats`, `joinWindow`, `settleWindow` |
| Payouts | Per-position schedule in basis points |
| Rules | `rulesHash` — digest of the off-chain rule set |
| Randomness | `randomnessOracle` |
| Attestation | Attestor allowlist and threshold |
| Cross-chain | `bridgeReceiver` |
| Emergency and settlement | `guardian`, `challengeWindow` |

- **Token vote behind a timelock.** Whoever owns the config can swap the
  oracle (and choose seeds) or the attestors (and sign results), so no single
  key can; the delay makes every change public before it lands. The deploy
  script refuses a delay shorter than `joinWindow + settleWindow`.
- **The Safe's powers end on a date written into `MultisigPhase`** (a year by
  default, two at most). After `phaseEnd` anyone calls `retire()`; the Safe
  cannot cancel its own removal or schedule anything that outlasts the phase.
- **A guardian that can only stop money moving.** It pauses for 7 days
  without the delay and vetoes a proposed result, refunding it. It cannot pay
  anyone, shorten a pause governance extended, or pause again until 7 days
  after the last pause ended, so it can never hold play stopped on its own.
- **Every setter validates.** The fee is capped at 10%; seats at 256 (the seat
  index is a `uint8` in the commit preimage); the attestor threshold is
  re-checked on every membership change; the payout schedule sums to exactly
  10,000 bps and is never longer than `minSeats`.
- **`Ownable2Step`**, so ownership is never handed to an address nobody
  controls.

---

## Token, staking and play-mining

`contracts/src/governance/` · `packages/server/src/chain/feeKeeper.ts` · **Unit-tested**

```
GameEscrow --fees--> FeeRouter --harvest (anyone)--> treasury (timelock)    [100% - stakerBps]
    |                    +--ETH--> StakedLms --streamed over 7 days--> each staker, pro rata
    +--fees per player per week --> RewardsDistributor --claim--> RewardVesting --6 months--> player
```

| Contract | Role |
| --- | --- |
| `LmsToken` | Fixed-supply ERC-20 with permit. No owner, no mint. Holding it gives **no** votes. |
| `StakedLms` | LMS → sLMS one for one; sLMS votes and earns the stakers' share of fees in ETH. Unstaking waits out a cooldown. |
| `LmsGovernor` | OpenZeppelin Governor over sLMS votes, through the timelock, with a quorum floor. |
| `FeeRouter` | The escrow's treasury; `harvest`, open to anyone, splits fees between the vault and the treasury. |
| `RewardsDistributor` | Play-mining: each week's LMS budget, split by the fees each player paid. |
| `RewardVesting` | Holds each (player, week) tranche, vesting linearly over six months. Cannot stake, so vesting LMS never votes. |
| `MultisigPhase` | The Safe's timelock roles, until `phaseEnd`. |
| `LiquidityReserve` | The 5% liquidity share. Cannot stake or delegate; pays only a recipient the timelock approves. |

| Setting | Default | Env |
| --- | --- | --- |
| LMS supply | 100,000,000 | `LMS_SUPPLY` |
| Unstake cooldown | 10 days | `STAKE_COOLDOWN` |
| Staker reward stream | 7 days | `REWARD_DURATION` |
| Voting delay / period | 1 day / 5 days | `VOTING_DELAY`, `VOTING_PERIOD` |
| Proposal threshold | 100,000 sLMS | `PROPOSAL_THRESHOLD` |
| Quorum | 4% of staked supply, never under 1,000,000 sLMS | `QUORUM_PERCENT`, `QUORUM_FLOOR` |
| Stakers' share of fees | 0% on Base mainnet, 50% elsewhere | `STAKER_FEE_BPS` |
| Play-mining caps | 10,000 LMS per ETH of fees; 20,000 LMS per wallet per week | `MAX_REWARD_PER_ETH`, `MAX_REWARD_PER_WALLET` |
| Multisig phase | ends a year after the deploy | `MULTISIG_PHASE_END` |

**Supply.** 50% play-mining over four years, 25% treasury (the timelock), 15%
team (a year's cliff, then three years linear), 5% liquidity
(`LiquidityReserve`), 5% reserve (the timelock). None of it is staked, so none
of it votes; governance starts with the players. There is no sale.

- **Only staked tokens vote**, read at the proposal's snapshot, so stake bought
  after a proposal appears cannot vote on it.
- **A cooldown instead of slashing.** `requestUnstake` burns the sLMS at once;
  the LMS follows after a cooldown that must outlast `votingPeriod + delay`,
  so whoever voted is still staked when the proposal executes.
- **Fees are paid in ETH, not used to buy LMS**: nothing to sandwich, price or
  trust.
- **Rewards stream over a week**, Synthetix-style, so staking just before a
  harvest earns a second's share, not a week's.
- **A quorum floor**, since 4% of a small staked supply would let one proposer
  pass anything; the floor is checkpointed and capped at 10% of supply.
- **A wrapper, not ERC-4626**: one sLMS is always one LMS, so there is no
  exchange rate to manipulate.

**Play-mining** is computed on-chain from the fees each player paid, counted
when a match **settles** (an expired, aborted or vetoed match pays no fee, so
earns nothing). Each week has a budget, falling by a quarter a year; a player
who paid 1% of a week's fees gets 1% of it, capped per ETH of fees and per
wallet. Fees, not wins, because wins are zero-sum and one person can arrange
them; fees are a real cost. A week is claimable once it ends, into
`RewardVesting`; released LMS is staked to vote. The README's
[wash-trading economics](../README.md#wash-trading-economics) works through
what the caps buy.

**Paying part of the fee in LMS.** A seat can pay up to half its fee in LMS at
the governance rate `lmsPerEthDiscount`, with a permit, in the player's own
transaction. The LMS is held against the seat, burned when the match settles
and returned when it is cancelled, vetoed or aborted. Prizes do not change —
discounts come out of the treasury's cut — and play-mining counts only the ETH
paid. The rate is a setting, not an oracle; the 50% cap bounds a bad one.

---

## Session grants

`packages/consensus/src/eip712/moves.ts` · `packages/client/src/wallet/grant.ts` · **Unit-tested**

The wallet signs one EIP-712 `SessionGrant` naming a key the browser keeps for
a day. The key signs the login nonce on every connect and every commit and
reveal, so a reconnect costs no prompt and every move in a transcript is
provably its player's. The grant is shaped like a SIWE message and has no chain
id in its domain, so a wallet on a spoke can sign it; a contract wallet's grant
is checked with ERC-1271. The key can stake or spend nothing.

The key is secp256k1, which WebCrypto cannot hold, so it is sealed in IndexedDB
under a non-extractable AES-GCM key. The production build's
Content-Security-Policy allows no script but the bundle's own, and the client
never builds markup from data.

---

## Account abstraction

`SessionKeyDelegate` · `server/chain/sessionRelay.ts` · `client/wallet/oneClick.ts` ·
**Unit-tested, end to end on anvil**

One-click play turns joins and collecting winnings into a click, with the
server paying the gas. **EIP-7702, not ERC-4337**, because the address is the
identity: seats, rankings and payouts are keyed by the address that staked,
and 7702 gives that same address code (`0xef0100 || delegate`) instead of
moving the player to a new one.

1. Turning it on is one wallet transaction: the 7702 authorisation for
   `SessionKeyDelegate`, plus `grantSession` on the player's own address.
2. The session key signs `SessionCall{target, value, data, nonce}` for
   `join(matchId)` or `withdrawFor(account)`; the server's `SessionRelay`
   submits `executeWithSession` and pays the gas. The stake is the account's.

| Limit | Enforcement |
| --- | --- |
| Calls | `join` and `withdrawFor` on the escrow only, one word of arguments; `withdrawFor` pays only the account |
| Per call / in total | `valueCap` 0.05 ETH, `spendCap` 0.25 ETH |
| Time | `validUntil`, at most seven days out |
| Who pays the stake | `executeWithSession` is not payable: always the account |

- **ERC-1271 answers for the root key only.** A session key is never a valid
  signer for the account, so it cannot sign a permit, an order or a login as
  the wallet.
- **The relayer guards its own gas.** It submits only a call the delegate
  would accept, from an account delegated to *our* delegate, that simulates
  cleanly and fits the wallet's daily quota; withdrawals to a spoke share the
  quota and the key.
- **Digest parity.** `sessionCallDigest` is pinned to the delegate by a frozen
  vector on both sides. The verifying contract is the *account*, never the
  shared delegate, or a digest would be valid for every player who delegated.

Only a wallet that can sign an authorisation for our delegate gets it — the
dev burner and an embedded wallet; injected wallets and spoke joins keep the
normal flow. The README's wallet matrix has the detail.

---

## Identity and avatars

**Wallet-as-identity login** (`server/gateway/gateway.ts`, **Live**). The
server issues a nonce; the granted key signs it; the server checks the grant's
wallet signature and the key's. No passwords and no registration, and the
login is the same address that staked. It proves ownership and authorises
nothing.

**NFT avatars** (`PlayerAvatars`, `server/chain/avatars.ts`, **Unit-tested**).
An ERC-721 per chain, free mint, one per wallet, with an `equipped` slot.

- **Per chain, not bridged**: a seat wears the collection on the chain it
  staked from.
- **Outside consensus**: nothing about an avatar reaches a hash, and the
  engine never sees one, so a cosmetic can neither change a result nor break a
  replay. Avatars travel in their own message.
- **A transfer clears the sender's equipped slot**, so `avatarOf` never names a
  token the wallet sold.
- **Every failure is soft**: resolved in the background, cached with misses,
  and a seat without one is a plain circle.

---

## Gas engineering in Yul

`contracts/src/libraries/` · **Live**

| Library | Technique | Why it is worth it |
| --- | --- | --- |
| `SettlementLib` | Hashes the ranking straight out of calldata | Settlement hashes a variable-length array on every call; the encoder copies it twice |
| `SignatureLib` | One reusable `ecrecover` frame per batch | Runs `threshold` times per settlement |
| `SeatSetLib` | EIP-1153 transient storage as a scratch set | Linear permutation check at the 256-seat ceiling; a revert needs no cleanup |
| `HashLib` | Hand-rolled `chainHistory` and `drawBps` | Two- and three-word hashes with no encoder overhead |

Every routine has a plain-Solidity reference beside it and a differential fuzz
test, dirty high bits in calldata addresses included. `contracts/.gas-snapshot`
is committed and CI fails on drift.

---

## The engine, the server and the client

`packages/engine` · `packages/server` · `packages/client` — file by file in
[ARCHITECTURE.md](ARCHITECTURE.md).

- **The kernel is pure and total.** `resolveRound` reads no clock, uses no
  floating point and ignores arrival order, so anyone with the seed and the
  move log reproduces the ranking. Everything in the trust model rests on it.
- **A guaranteed single winner.** If a round would wipe the table, the least
  overkill survives on 1 HP: settlement needs a total order.
- **The public snapshot never carries a pending action**, and the arena draws
  only published state, so neither can leak a hidden move.
- **The room owns the clock but never reads it**: `tick(now)` is driven from
  outside, so a whole match runs deterministically in a test.
- **The chain bridge converges through one polling loop**, and opens a room
  only for a `Live` match under the rules hash it plays.
- **Archive first.** A staked match is settled only once its transcript is
  archived; each room journals its rounds, so a restart resumes instead of
  refunding.
- **One instance.** Rooms, the queue and the rate limits live in the process;
  a second server against the same Postgres is refused.
- **The reveal is automatic**, and the reads panel is bookkeeping over the
  published history: after five rounds you are playing the table.

---

## Testing and verification

| Pinned across languages | TypeScript | Solidity |
| --- | --- | --- |
| Commit, round, history, `drawBps`, rules hash | `consensus/test/parity.test.ts` | `test/unit/HashLib.t.sol` |
| Session call digest | `consensus/test/session.test.ts` | `test/unit/SessionKeyDelegate.t.sol` |
| Withdrawal digest | `consensus/test/withdrawal.test.ts` | `test/unit/BridgeJoinReceiver.t.sol` |
| Golden transcripts | `engine/test/golden.test.ts` | `test/unit/GoldenTranscript.t.sol` |

If an encoding drifts, exactly one suite fails instead of the two sides
diverging silently. Beyond those: differential fuzzing of every Yul routine,
the escrow's solvency invariant campaign, engine property tests (termination,
unique ranking, HP bounds, determinism, replay equivalence, tamper detection),
fork tests against Across, VRF and Uniswap v4, and a seeded chaos suite
against the server. Commands are in the README.
