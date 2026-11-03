# X-Ray Report

> Last Man Standing (LMS) | 2,527 nSLOC in scope (2,959 incl. mocks, interfaces, vendor) | 90efcbe (`master`) | Foundry | 03/11/26

---

## 1. Protocol Overview

**What it does:** An ETH escrow for a last-man-standing elimination game. The game is played off-chain, stakes are held on-chain, and payouts follow results signed by an attestor quorum that can be challenged before they pay.

- **Users**: Players stake ETH into lobbies on the Base hub. They can join directly, pay with any token via `ZapJoin`, bridge from spokes via Across, or join one-click through an EIP-7702 session key.
- **Core flow**: `createMatch` → `join` → `lockMatch` (VRF seed) → server plays → `settle` (quorum-signed result) → challenge window, with `dispute`/`veto` → `finalize` credits payouts → pull `withdraw`.
- **Key mechanism**: The result is "verifiable, not enforced". The signed digest commits to a history root and the hash of the archived transcript. The guardian vetoes or dismisses disputes after an off-chain replay (per spec).
- **Token model**: Native ETH stakes. LMS is a fixed-supply governance token. sLMS (`StakedLms`) is a 1:1 wrapper that carries votes and an ETH fee stream. Up to half of a seat's fee can be paid in LMS, which is burned on settle. Play-mining pays LMS for fees paid in matchmade lobbies, vesting over 26 weeks.
- **Admin model**:
  - A `TimelockController` owns every config. Its proposers are `LmsGovernor` (sLMS votes) and, until a fixed `phaseEnd`, the Safe through `MultisigPhase`.
  - A guardian EOA can pause instantly (7 d, with cooldown) and veto results.

For a visual overview of the protocol's architecture, see the [architecture diagram](architecture.svg).

### Contracts in Scope

| Subsystem | Key Contracts | nSLOC | Role |
|-----------|--------------|------:|------|
| Escrow core | GameEscrow, PullPayable, ExpiringPause, Constants, Errors | 700 | Lobby, match state machine, settlement, refunds, pull payments, expiring pause |
| Config & libraries | ProtocolConfig, SignatureLib, SettlementLib, HashLib | 341 | Governed parameters, attestor sets, quorum check, EIP-712 result hash, consensus hash mirror |
| Randomness | ChainlinkVrfAdapter | 106 | VRF v2.5 behind `IRandomnessOracle`, store-then-deliver |
| Periphery | BridgeJoinReceiver, SpokeRouter, ZapJoin, SessionKeyDelegate | 541 | Across in/out, Uniswap v4 token joins, 7702 session keys |
| Governance & tokenomics | StakedLms, LmsGovernor, MultisigPhase, FeeRouter, RewardsDistributor, RewardVesting, LiquidityReserve, LmsToken | 769 | Staking/votes, fee split, play-mining, multisig phase, liquidity lock |
| Cosmetic | PlayerAvatars | 70 | Free one-per-wallet ERC-721, outside consensus |

### How It Fits Together

The core trick: the chain never sees a move. It holds stakes, fixes a seed after the seat list is final, and pays out a permutation of the seats that a quorum signed, after a window in which the result can be disputed and vetoed.

### Join and lock

```
Player ─ GameEscrow.join{stake}() / joinWithLms() / joinFor()   (ZapJoin, SessionKeyDelegate)
   └─ _seat()                    *totalEscrowed += paid; seat bitmask index = seatNumber-1*
Anyone ─ GameEscrow.lockMatch()  *lobby full, or join window over with ≥ minSeats*
   ├─ snapshot oracle + attestorSetVersion   *set before the external call*
   └─ ChainlinkVrfAdapter.requestRandomness() → VRFCoordinator.requestRandomWords()
VRFCoordinator ─ ChainlinkVrfAdapter.rawFulfillRandomWords()   *stores the word, never reverts*
   └─ GameEscrow.fulfillRandomness()  *seed = keccak(word, matchId); status Live*
```

### Settle, challenge, finalize

```
Keeper ─ GameEscrow.settle(rounds, root, transcriptHash, ranking, sigs)   [whenNotPaused]
   ├─ ProtocolConfig.checkQuorum(snapshotVersion, EIP712 digest)  *ascending signers, threshold*
   ├─ _assertSeatSet()                *ranking is exactly the seat set*
   └─ status Proposed; deadline = now + challengeWindow
Seated ─ dispute()  → deadline += 48h          Guardian ─ veto() → _refundAll()  |  dismissDispute() → deadline -= 48h
Anyone ─ GameEscrow.finalize(ranking)          *after deadline; sequencer feed up ≥ 1h; not paused*
   ├─ _distribute()  → _credit(rank_i)…, _credit(treasury, remainder − discountEth)
   ├─ _recordFees()  *matchmade only: feesPaid / epochFees for the current week*
   └─ LmsToken.burn(discount LMS)
```

### Cross-chain join and exit

```
Spoke: Player ─ SpokeRouter.join{value}() → AcrossSpokePool.depositV3(recipient = BridgeJoinReceiver, msg)
Hub:   AcrossSpokePool ─ BridgeJoinReceiver.handleV3AcrossMessage()   *never reverts once caller is the pool*
          ├─ WETH.withdraw() → GameEscrow.bridgeJoin{value}()  *seat, or credit the player in full*
          └─ else: emit Unroutable; held for timelock recover()
Relayer ─ BridgeJoinReceiver.withdrawToChainFor(w signed, q unsigned, sig)
          └─ GameEscrow.withdrawToBridge(player) → AcrossSpokePool.depositV3{whole balance}
```

### Fees and play-mining

```
Anyone ─ FeeRouter.harvest() → GameEscrow.withdraw(FeeRouter)
          ├─ StakedLms.depositRewards{stakerBps}()   *streamed over rewardDuration*
          └─ treasury.call{rest}
Anyone ─ RewardsDistributor.claim(player, epochs) → GameEscrow.feesPaid/epochFees
          └─ _fixRate() (first claim fixes rate + cap) → LMS → RewardVesting.grant()  *26-week vest*
```

---

## 2. Threat & Trust Model

### Protocol Threat Profile

> Protocol classified as: **Escrow / wagering settlement** (closest profile: **Bridge**, because a quorum attests to an off-chain result) with **Governance** and **reward-streaming (vault-like)** characteristics

Signals:
- Quorum-signed results with an ascending-signer check and snapshotted signer sets are the bridge-validator shape.
- Across in/out adds real bridge flows.
- `LmsGovernor` and `TimelockController`, plus `MultisigPhase` and ERC20Votes, are governance.
- `StakedLms` uses a Synthetix-style reward stream.

There is no price oracle and no lending.

### Actors & Adversary Model

| Actor | Trust Level | Capabilities |
|-------|-------------|-------------|
| Timelock (owner) | Trusted | Every `ProtocolConfig` setter, `extendPause`, `veto`, VRF coordinator, bridge receiver, cooldown, caps, sweeps. Each waits out the timelock delay (3 d per spec), then applies at once. |
| Safe via `MultisigPhase` | Bounded (until `phaseEnd`, ≤ 2 y) | Schedules and cancels timelock ops, including governor proposals. It cannot target the timelock or call `transferOwnership`/`renounceOwnership`. All other setters remain schedulable. |
| Guardian | Bounded (refund-only, rate-limited) | Instant `pause` for 7 d with a 7 d cooldown, `veto` (refund all), `dismissDispute`. It can also `unpause` a governance-extended pause (`ExpiringPause.sol:76`). |
| Attestor quorum | Bounded (seat permutation only) | Signs `settle` (any ordering of the seats) and `abortMatch` (instant refund of a Live match). The default is 1 of 1, held by the operator (per spec). |
| Matchmaker | Bounded (roster only) | Opens matchmade lobbies with any roster. Only these earn play-mining. |
| Bridge receiver (config-named) | Trusted | Calls `withdrawToBridge(any account)` and is not paused. It decides who a bridged stake seats. |
| Seated player | Bounded | `dispute` once per seat, adding 48 h when no dispute is open. |
| Session key | Bounded (`valueCap`/`spendCap`, ≤ 7 d) | `join(any matchId)` and `withdrawFor(self)` from the account's balance. |
| Across SpokePool / VRF coordinator / Uniswap PoolManager | Trusted externals | Reported token and amount, the random word, swap deltas (checked). |

**Adversary Ranking**:

1. **Compromised or colluding attestor quorum and operator**: the result is trusted up to a seat permutation, and today the quorum is one operator key (per spec).
2. **Compromised guardian**: it acts instantly, outside the timelock, and its powers include lifting pauses and dismissing disputes.
3. **Malicious config change through the timelock**: the bridge receiver, oracle, attestor set and sequencer feed each give broad power, and several are read live by running matches.
4. **Session-key or relayer abuser**: one-click keys live in the browser and their scope is fixed, but the lobby they join is not.
5. **Play-mining farmer**: rewards follow fees paid in matchmade lobbies, so the matchmaker and the per-ETH cap are the only farming bounds.

See [entry-points.md](entry-points.md) for the full permissionless entry point map.

### Trust Boundaries

- **Timelock → ProtocolConfig**:
  - `_checkDelay` requires the owner's delay to exceed `matchLifetime()`, but only when params, the window or the owner change (`ProtocolConfig.sol:346,274,353`).
  - The timelock's own `updateDelay` is never re-checked.
  - `setBridgeReceiver:306` alone is enough to reach every balance.
- **Guardian → GameEscrow**:
  - It can pause, veto and dismiss with no delay. The veto can only refund (`_refundAll:847`).
  - `unpause` is open to the guardian whoever set the pause (`ExpiringPause.sol:76-78`), against the config NatSpec at `ProtocolConfig.sol:73-74`.
- **Attestor quorum → settlement**:
  - It binds via the version snapshotted at lock (`GameEscrow.sol:533`), and the ranking is a permutation check (`:608-618`).
  - Correctness of the off-chain outcome rests on replay, dispute and guardian liveness (per spec).
  - *Git signal: GameEscrow has 30 modifications, the top hotspot.*
- **Bridge receiver → escrow**: The escrow trusts the receiver's signature check completely (`GameEscrow.sol:509-511`). The `Withdrawal` digest has no domain chainId, replaced by the `hubChainId` field (`BridgeJoinReceiver.sol:80-84,190`).
- **Session key → account**: Scope is fixed in code (`SessionKeyDelegate.sol:257-273`). The caps bound the ETH that can be moved, not where a stake ends up.
- **Safe → timelock**: The deny-list in `MultisigPhase._checkCall:114-120` covers the timelock and ownership transfers only. Its end is a fixed timestamp (`:67,106`).

### Key Attack Surfaces

- **Guardian pause / unpause asymmetry** &nbsp;&#91;[I-14](invariants.md#i-14), [I-15](invariants.md#i-15), [G-30](invariants.md#g-30)&#93; — `ExpiringPause.unpause:75-79` lets the guardian end a pause set by `extendPause:66-71`. Worth confirming which docs and tests assume the guardian cannot lift a governance stop, and what a guardian pause does to Live matches near their settle deadline, since `settle` is paused and `cancelMatch` is not.

- **Dispute / dismiss deadline arithmetic** &nbsp;&#91;[I-13](invariants.md#i-13), [G-22](invariants.md#g-22), [G-23](invariants.md#g-23)&#93; — `dispute:725-728` extends only when `!disputed`, and `dismissDispute:743-746` restores `max(deadline − 48h, now)`. Worth tracing repeated dispute→dismiss cycles across seats against `matchLifetime()` and the timelock-delay assumption.

- **Bridge receiver as universal withdrawer** &nbsp;&#91;[X-1](invariants.md#x-1), [E-3](invariants.md#e-3), [G-9](invariants.md#g-9)&#93; — `GameEscrow.withdrawToBridge:509` pays any account's whole balance to `config.bridgeReceiver()` and is not paused. Worth checking the replacement path (`setBridgeReceiver:306`) and the receiver's signature path (`SignatureChecker` on 7702-delegated or contract wallets).

- **Unsigned Across quote on bridge-out** &nbsp;&#91;[G-46](invariants.md#g-46), [I-31](invariants.md#i-31)&#93; — In `withdrawToChainFor:184-206` the submitter picks `outputAmount`, `exclusiveRelayer`, `fillDeadline` and `quoteTimestamp`, and only `maxFee` bounds them. Worth checking what a hostile submitter can do with exclusivity and fill deadlines, given that refunds land on the hub as WETH to `w.player`.

- **Receiver ETH pooling in `_unwrap`** &nbsp;&#91;[I-32](invariants.md#i-32), [X-13](invariants.md#x-13)&#93; — `BridgeJoinReceiver._unwrap:167-175` falls back to `address(this).balance` when WETH is short, so ETH held from an earlier `Unroutable` fill can back a new `bridgeJoin`. Worth tracing against the "held for `recover`" guarantee.

- **Proposed-match liveness** &nbsp;&#91;[I-12](invariants.md#i-12), [X-4](invariants.md#x-4), [G-19](invariants.md#g-19)&#93; — After the challenge window, `finalize:628-648` is the only exit from Proposed. It reads `sequencerUptimeFeed` live (`:651`) and calls `burn` on `config.lmsToken()`. Worth confirming every revert source there has a recovery path besides a timelock proposal.

- **Session key scope vs lobby choice** &nbsp;&#91;[X-9](invariants.md#x-9), [I-30](invariants.md#i-30)&#93; — `_checkCall:265-266` allows `join(any matchId)` within the caps. Worth checking what a leaked key achieves by joining private lobbies whose other seats it controls, and that the re-grant spend reset (`grantSession:148`) matches the client's assumptions.

- **LMS fee-discount accounting** &nbsp;&#91;[I-3](invariants.md#i-3), [I-9](invariants.md#i-9), [I-10](invariants.md#i-10), [X-11](invariants.md#x-11)&#93; — The discount is clamped per seat in `quoteLmsDiscount:415-429` but taken out of a pool-level fee in `_distribute:780`. LMS is pushed in the refund loop (`_refundAll:863-871`), and `lmsPerEthDiscount` is a fixed governance price read at join. Worth tracing the rounding at max discount with `feeBps` near 0, and push-refund reverts.

- **Attestor quorum power** &nbsp;&#91;[G-14](invariants.md#g-14), [G-16](invariants.md#g-16), [X-2](invariants.md#x-2)&#93; — `settle` accepts any seat permutation and `abortMatch:803` refunds any Live match instantly. The digest omits the seed and rules hash (`SettlementLib.sol:9-11`). Worth confirming what binds a result to the seeded match beyond `historyRoot`, and how attestor rotation (`setAttestorSet:244`) interacts with matches still locked under old versions.

- **Play-mining terms fixed by anyone** &nbsp;&#91;[I-25](invariants.md#i-25), [I-26](invariants.md#i-26), [E-1](invariants.md#e-1), [X-6](invariants.md#x-6)&#93; — `RewardsDistributor.claim:198` takes any `player`, fixes the epoch's rate and cap on first call (`_fixRate:258`), and sets the claimed bit before computing the reward (`:211-213`). Worth checking timing games around queued cap changes and epochs consumed with zero grants.

- **Matchmaker key** &nbsp;&#91;[G-4](invariants.md#g-4)&#93; — `createMatchmade:313-326` takes an arbitrary-length roster, and only matchmade fees reach `_recordFees` (`finalize:639`). Worth checking how farming economics hold under a compromised matchmaker, given that `maxRewardPerEth` is the only on-chain bound.

- **Timelock delay vs match lifetime** &nbsp;&#91;[I-8](invariants.md#i-8), [E-4](invariants.md#e-4), [G-38](invariants.md#g-38)&#93; — `_checkDelay:362-368` reads `getMinDelay` only when the config writes. It skips owners that do not answer, and ignores values read live, such as feed, guardian and discount rate. Worth checking which config values are snapshotted versus read live.

- **Governance exposure after unstake** &nbsp;&#91;[I-21](invariants.md#i-21), [I-37](invariants.md#i-37)&#93; — The rule that `cooldown > votingPeriod + delay` exists only in `Deploy.s.sol:477`. `setCooldown:309` and governor setting changes do not re-check it, and the quorum floor cap is measured against a burnable supply.

- **Multisig phase deny-list completeness** &nbsp;&#91;[X-12](invariants.md#x-12), [I-33](invariants.md#i-33)&#93; — `MultisigPhase._checkCall:114-120` leaves `setBridgeReceiver`, `setGuardian`, `setAttestorSet` and `setCoordinator` schedulable. Worth checking which of these outlive `phaseEnd` and can't be undone.

### Protocol-Type Concerns

**As an escrow / attested settlement:**
- Seat bitmasks use `1 << (number − 1)` with `number ≤ 256` (`GameEscrow.sol:614,720`). `maxSeats` is capped at `ABSOLUTE_MAX_SEATS` by `ProtocolConfig.sol:325`, so this is worth a boundary test at exactly 256 seats.
- `rankingHash = keccak256(abi.encode(ranking))` (`:598`) is compared with a calldata re-encode at `finalize:631`. The encoding is identical, but worth confirming that no off-chain encoder packs the ranking differently.

**As governance:**
- `StakedLms` uses a timestamp clock (`:331-338`) with auto-self-delegation on receipt (`:348`). Worth checking how `depositFor` delegates voting power to arbitrary accounts that never chose a delegate.
- The Synthetix stream pauses with zero supply by extending `periodFinish` (`StakedLms.sol:248-251`). Worth checking the first-staker-after-idle case against `depositRewards:197` `unpaid`.

### Temporal Risk Profile

**Deployment & Initialization:**
- `ProtocolConfig` deploys incomplete, and `_checkDelay` is a no-op while the owner is an EOA (`ProtocolConfig.sol:363-364`). The ordering of `setChallengeWindow`/`setParams` before the timelock handoff is enforced only at `_transferOwnership:353`.
- `RewardsDistributor` must be funded with `totalBudget_` in the same run (`:114-115`). Nothing on-chain checks the balance against `totalBudget()`.
- `MultisigPhase.retire()` renounces only this contract's roles (`:107-108`). Any role granted to the Safe directly at deploy would survive it.

**Deprecation:**
- Escrow replacement redeploys everything that holds the escrow as `immutable`, and `SessionKeyDelegate.escrow` is immutable (`:103`), so players must re-delegate (per spec). Old escrow balances stay withdrawable through unpaused `withdraw` (`PullPayable.sol:49`).

### Composability & Dependency Risks

**Dependency Risk Map:**

> **Chainlink VRF v2.5**, via `ChainlinkVrfAdapter.requestRandomness` / `rawFulfillRandomWords`
> - Assumes: one honest word per request, from the configured coordinator
> - Validates: caller == coordinator (`:108`); unknown or repeated ids ignored (`:111`)
> - Mutability: coordinator, keyHash and subId set by the owner (`setCoordinator:68`)
> - On failure: delivery try/catch keeps the word for `deliver()`. An unanswered match is refunded via `cancelMatch` after 1 h.

> **Chainlink L2 sequencer feed**, via `GameEscrow._checkSequencer`
> - Assumes: `answer == 0` means up, and `startedAt` is the moment it last came up
> - Validates: answer and grace period only. No round-completeness or `updatedAt` check.
> - Mutability: governance can repoint or disable it (`setSequencerUptimeFeed:277`)
> - On failure: `finalize` reverts. Proposed matches have no other exit after the window (I-12).

> **Across SpokePool (hub and spokes)**, via `BridgeJoinReceiver.handleV3AcrossMessage` / `withdrawToChainFor`, `SpokeRouter.join`
> - Assumes: the reported `tokenSent`/`amount` arrived before the call, and refunds go to the depositor after `fillDeadline`
> - Validates: caller == spokePool; token == WETH; the message is not trusted
> - Mutability: Across-governed, upgradeable proxy (external)
> - On failure: the handler never reverts and holds the value. The outbound path reverts the whole withdrawal.

> **Uniswap v4 PoolManager and arbitrary hooks**, via `ZapJoin.unlockCallback`
> - Assumes: exact-output deltas from user-chosen pools
> - Validates: sign and exact amount per hop (`:191-195`), `maxAmountIn`, deadline
> - Mutability: hooks are user-chosen
> - On failure: the whole join reverts, and nothing is held

> **OpenZeppelin TimelockController / Governor**, via `ProtocolConfig._checkDelay`, `MultisigPhase`
> - Assumes: `getMinDelay` stays above `matchLifetime`, and roles granted as deployed
> - Validates: the delay is read only when the config writes
> - Mutability: the timelock can `updateDelay` through its own proposals
> - On failure: a queued change can reach open matches (I-8)

**Token Assumptions** *(unvalidated only)*:
- LMS (`config.lmsToken`): assumed to have no transfer hooks, for the push refund at `GameEscrow.sol:869` (comment only). If violated, one seat can block a match's refund.
- ZapJoin input tokens: fee-on-transfer and rebasing tokens are unsupported and revert by design (`ZapJoin.sol:39-41`). Nothing else is assumed.

---

## 3. Invariants

> ### 📋 Full invariant map: **[invariants.md](invariants.md)**
>
> A dedicated reference file contains the complete invariant analysis. Do not look here for the catalog.
>
> - **46 Enforced Guards** (`G-1` … `G-46`): per-call preconditions with `Check` / `Location` / `Purpose`
> - **37 Single-Contract Invariants** (`I-1` … `I-37`): Conservation, Bound, Ratio, StateMachine, Temporal
> - **13 Cross-Contract Invariants** (`X-1` … `X-13`): caller/callee pairs that cross scope boundaries
> - **4 Economic Invariants** (`E-1` … `E-4`): higher-order properties derived from `I-N` + `X-N`
>
> Every inferred block cites a concrete Δ-pair, guard-lift + write-sites, state edge, temporal predicate, or NatSpec quote. The **On-chain=No** blocks (14) are the high-signal ones: each is simultaneously an invariant and a potential bug. Attack-surface bullets above cross-link directly into the relevant blocks (e.g. `[I-14]`, `[X-1]`).

---

## 4. Documentation Quality

| Aspect | Status | Notes |
|--------|--------|-------|
| README | Present | `README.md` (476 lines): roles table, trust model, economics |
| NatSpec | Thorough (39 by enumeration) | Every in-scope contract has an `@title`/`@notice`/`@dev` design rationale |
| Spec/Whitepaper | Present | `docs/ARCHITECTURE.md` (794 lines), `docs/adr/` (ADRs 0001–0011), `docs/ACROSS.md`, `docs/MIGRATION.md` (known-gaps list) |
| Inline Comments | Thorough | Downcasts, ordering and trust assumptions are commented in place |

The docs contradict each other on one point: README and FEATURES say only governance can lift a pause, while MIGRATION §7 notes that `unpause` lets the guardian end any pause (per spec). The code matches MIGRATION. FEATURES still describes a Yul gas section that the code no longer has.

---

## 5. Test Analysis

| Metric | Value | Source |
|--------|-------|--------|
| Test files | 39 | File scan (always reliable) |
| Test functions | 401 | File scan (always reliable) |
| Line coverage | Unavailable: the coverage run executed 415 tests (407 passed, 1 failed, 7 skipped), and the failing `Deploy.t.sol::test_registryNamesEveryContract` stopped the report | Coverage tool (requires compilation) |
| Branch coverage | Unavailable: same reason | Coverage tool (requires compilation) |

### Test Depth

| Category | Count | Contracts Covered |
|----------|-------|-------------------|
| Unit | 28 files | Broad: every in-scope contract, plus golden transcripts and deploy |
| Fork | 4 files (2 by function-name scan) | Across, sequencer feed, VRF (Base Sepolia), ZapJoin |
| Stateless Fuzz | 5 | SignatureLib and others (`testFuzz*`) |
| Stateful Fuzz (Foundry) | 18 | `EscrowInvariant` (solvency, handler with 19 selectors), `RewardsInvariant`, `StakedLmsInvariant` |
| Stateful Fuzz (Echidna / Medusa) | 0 | none |
| Formal Verification (Certora / Halmos / HEVM) | 0 | none |

### Gaps

- No formal verification of the money-moving arithmetic: `_distribute` remainder and discount, the `StakedLms` accumulator, and the play-mining rate.
- One unit test currently fails (`Deploy.t.sol::test_registryNamesEveryContract`), which blocks coverage output.
- There is no Echidna or Medusa campaign. Foundry invariants run 256×64 by default, and 2000×256 under the `deep` profile.
- None of the 18 invariant functions covers `BridgeJoinReceiver`, `SessionKeyDelegate` or `MultisigPhase` (by file names). Those three are the newest periphery.

---

## 6. Developer & Git History

> Repo shape: normal_dev. 56 of 218 commits touch `contracts/src` over 56 days. Analyzed branch: `master` at `90efcbe`.

### Contributors

| Author | Commits | Source Lines (+/-) | % of Source Changes |
|--------|--------:|--------------------|--------------------:|
| Patryk Murawski | 196 | +7,905 / -3,505 | 89.8% |
| Claude (AI-assisted commits) | 22 | +901 / -231 | 10.2% |

### Review & Process Signals

| Signal | Value | Assessment |
|--------|-------|------------|
| Unique contributors | 2 | Single human developer |
| Merge commits | 33 of 218 (15%) | PR-based flow, self-merged |
| Repo age | 2026-09-08 → 2026-11-03 | 8 weeks |
| Recent source activity (30d) | ≥ 7 source commits, incl. 3 on 2026-10-31 | Late burst: the cross-chain path was rewritten 3 days before HEAD |
| Test co-change rate | 91.1% | Share of source-changing commits that also touch test files (co-modification, not coverage) |

### File Hotspots

| File | Modifications | Note |
|------|-------------:|------|
| `src/GameEscrow.sol` | 30 | Core and highest churn: prioritise review |
| `src/ProtocolConfig.sol` | 17 | Every governed parameter |
| `src/libraries/HashLib.sol` | 11 | Consensus mirror of the TypeScript hashing |
| `src/libraries/SettlementLib.sol` | 7 | EIP-712 result type |
| `src/oracles/ChainlinkVrfAdapter.sol` | 6 | |
| `src/PullPayable.sol` | 6 | Solvency accounting |
| `src/SessionKeyDelegate.sol` | 5 | Rewritten to v2 storage (ADR 0008, per spec) |
| `src/governance/StakedLms.sol`, `RewardsDistributor.sol`, `LmsGovernor.sol` | 5 each | |

### Security-Relevant Commits

**Score** is a weighted sum of fix-like signals in a commit:
- Message keywords.
- Diff patterns: `require`/`assert` changes, access control, accounting.
- Change shape.

**10+ warrants a manual diff.**

| SHA | Date | Subject | Score | Key Signal |
|-----|------|---------|------:|------------|
| 4edb0f9 | 2026-10-11 | remove match market | 14 | loosens access control, removes code (`MatchMarket.sol`) |
| 3ebdb8e | 2026-10-31 | BridgeJoinReceiver: Across fills seat players on the hub… | 11 | signature/auth + accounting across GameEscrow, ProtocolConfig, PullPayable |
| 4bbf7a4 | 2026-10-30 | LiquidityReserve holds the Safe's 5M LMS… | 11 | runtime guards rewritten |
| a65c42d | 2026-10-30 | MultisigPhase holds the Safe's timelock powers until a fixed date | 11 | access control, governor change |
| 1fcda0b | 2026-09-28 | support joining with any token | 11 | token transfer + auth (ZapJoin) |
| 948f8fd | 2026-10-11 | add transistent reentrancy guard | 10 | explicit security language, no test change |
| 72d09f2 | 2026-09-22 | Stage 7: PullPayable | 10 | accounting, loosens access control, no test change |
| 1d95aaa | 2026-10-13 | feat: gov tokens, staking, proposals [2/2] | 10 | large (>500 lines), loosens access control |
| 6dfcbcf | 2026-09-10 | first version | 10 | initial import (1,880 lines) |
| 3f4f2f0 | 2026-10-31 | Matchmaking: a queue per tier… | 9 | access control + accounting (GameEscrow, ProtocolConfig) |

### Dangerous Area Evolution

Not computed: the git analysis script hit a Windows code-page decoding error before this section. The other sections completed.

### Forked Dependencies

OpenZeppelin (`lib/openzeppelin-contracts`) is a standard submodule and is not internalized. The Across and Chainlink interfaces are vendored as interface-only copies in `src/vendor/` (pinned to Across v5.0.27, per spec).

### Security Observations

- **Single human developer**: one author wrote 89.8% of the source lines. The rest are AI-assisted commits.
- **Late cross-chain rewrite**: `SpokeEscrow` and the LayerZero messenger were deleted, and `BridgeJoinReceiver`/`SpokeRouter` added, all on 2026-10-31 (`9f74fbb`, `a033a48`, `3ebdb8e`).
- **Refactor at HEAD~1**: `899c991` "code refactor" (2026-11-03) touches GameEscrow, SessionKeyDelegate, MultisigPhase, RewardsDistributor and BridgeJoinReceiver.
- **Removed mechanisms in history**: `MatchMarket` (`4edb0f9`) and the fraud-proof/slashing port (`17b7e7a`; per spec it was kept in `fadf583`). Neither is left as dead code in `src/`.
- **Reentrancy-guard commit without tests**: `948f8fd` switched to transient guards in PullPayable and ZapJoin with no test file changes (co-modification signal only).
- **No TODO/FIXME markers** in `src/`. Known gaps are tracked in `docs/MIGRATION.md` §7 instead (per spec).

### Cross-Reference Synthesis

- **GameEscrow is #1 in churn and in attack surfaces**: 9 of 14 surfaces route through it. The highest-leverage review targets are `finalize`, `_distribute`, `dispute`/`dismissDispute`, `withdrawToBridge` and `_refundAll`.
- **The newest code is the least invariant-tested**: `BridgeJoinReceiver` (added 3 days before HEAD) and `SessionKeyDelegate` have no invariant suite, and between them carry I-32, X-1, X-9 and the unsigned-quote surface.
- **The `ExpiringPause` doc contradiction lines up with I-14**: the code, the MIGRATION known-gaps list and the README disagree. This is a documented, unfixed trust-boundary gap.

---

## X-Ray Verdict

**HARDENED**: Unit, fuzz and invariant tests exist, the docs and NatSpec are thorough, and access control is timelocked with an emergency pause. The tier is capped by the absence of formal verification.

**Structural facts:**
1. 2,527 nSLOC in scope across 6 subsystems. Nothing is upgradeable: there are no proxies, and inter-contract links are `immutable`.
2. 401 test functions in 39 files, including 18 Foundry invariant functions and 4 fork suites. There is no formal verification, and 1 unit test currently fails.
3. One timelock owns every config. A Safe holds proposer and canceller roles until a fixed `phaseEnd`, and a guardian EOA has instant pause and veto.
4. One human developer accounts for 89.8% of source lines over 8 weeks. The cross-chain subsystem was rewritten 3 days before the analyzed commit.
