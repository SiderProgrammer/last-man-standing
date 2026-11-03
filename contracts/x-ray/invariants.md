# Invariant Map

> Last Man Standing | 46 guards | 54 inferred (37 single-contract, 13 cross-contract, 4 economic) | 14 not enforced on-chain

---

## 1. Enforced Guards (Reference)

Per-call preconditions. Heading IDs below (`G-N`) are anchor targets from x-ray.md attack surfaces.

#### G-1
`if (!config.isComplete()) revert ConfigIncomplete();` · `GameEscrow.sol:335` · No lobby can open against a config that has no rules hash, oracle, challenge window or attestor set, so every match can be seeded and settled.

#### G-2
`if (stake < params.minStake || stake > params.maxStake) revert StakeOutOfRange(stake);` · `GameEscrow.sol:338` · Keeps stakes inside the governed range that the `uint128` packing and the `MIN_WITHDRAW_FOR` dust floor are sized for.

#### G-3
`if (maxSeats < params.minSeats || maxSeats > params.maxSeats) revert SeatsOutOfRange(maxSeats);` · `GameEscrow.sol:339` · Bounds the seat count by `ABSOLUTE_MAX_SEATS` (256), which the one-word seat bitmasks depend on.

#### G-4
`if (msg.sender != config.matchmaker()) revert NotMatchmaker(msg.sender);` · `GameEscrow.sol:318` · Only the matchmaker opens lobbies whose fees count for play-mining. This is the anti-farming boundary.

#### G-5
`if (msg.value != info.stake) revert IncorrectStake(msg.value, info.stake);` · `GameEscrow.sol:472` · Exact-stake entry keeps `totalEscrowed` in step with the ETH actually received (solvency).

#### G-6
`if (msg.value != due) revert IncorrectStake(msg.value, due);` · `GameEscrow.sol:441` · A discounted seat pays exactly the stake less the LMS discount, so the escrow accounts for the net ETH and not the full stake.

#### G-7
`if (token == address(0) || config.lmsPerEthDiscount() == 0) revert DiscountOff();` / `if (discount == 0) revert NoDiscount(lmsIn);` · `GameEscrow.sol:434-436` · The discount path runs only with a token and a rate configured, so a seat cannot be recorded as discounted for zero LMS.

#### G-8
`if (msg.sender != config.bridgeReceiver()) revert NotBridgeReceiver(msg.sender);` · `GameEscrow.sol:490` · Only the governance-named receiver can seat bridged players, because it alone decides who a bridged stake seats.

#### G-9
`if (msg.sender != config.bridgeReceiver()) revert NotBridgeReceiver(msg.sender);` · `GameEscrow.sol:510` · Gates the only escrow path that pays a balance to an address other than its owner.

#### G-10
`if (!full && !expired) revert LobbyNotReady(matchId);` · `GameEscrow.sol:524` · The seat list is final before randomness is requested, so no one can join after seeing the seed.

#### G-11
`if (info.seatCount < minSeats) revert NotEnoughPlayers(info.seatCount, minSeats);` · `GameEscrow.sol:526` · Guarantees `seatCount >= payoutBps.length`, so `_distribute` never indexes past the ranking.

#### G-12
`if (msg.sender != info.oracle || msg.sender == address(0)) revert NotOracle(msg.sender);` · `GameEscrow.sol:547` · Only the oracle snapshotted at lock can seed the match. An oracle swap cannot hijack a pending seed.

#### G-13
`if (rounds == 0 || rounds > type(uint16).max) revert RoundsOutOfRange(rounds);` · `GameEscrow.sol:580` · Makes the later `uint16(rounds)` downcast lossless.

#### G-14
`if (threshold == 0 || signers.length < threshold) revert QuorumNotMet(...)` / `if (!attestorIn[version][signers[i]]) revert NotAnAttestor(...)` · `ProtocolConfig.sol:194-196` · A result or abort needs a threshold of distinct members of the attestor version the match locked under. A version that was never set accepts nothing.

#### G-15
`if (signer <= previous) revert UnsortedSigners();` · `SignatureLib.sol:40` · Strictly ascending signers stop one attestor's signature from counting twice toward the threshold.

#### G-16
`if (ranking.length != seatCount) revert NotAPermutation();` / `if (number == 0) ...` / `if (seen & bit != 0) ...` · `GameEscrow.sol:609-615` · The ranking must be exactly the seat set, so even a compromised quorum can only reorder seated players, never pay outsiders.

#### G-17
`if (block.timestamp < info.deadline) revert ChallengeWindowOpen(info.deadline);` · `GameEscrow.sol:630` · A result pays only after its challenge window and any dispute extension have closed.

#### G-18
`if (keccak256(abi.encode(ranking)) != info.rankingHash) revert RankingMismatch();` · `GameEscrow.sol:631` · `finalize` pays the exact ranking the quorum signed, because whoever finalises supplies the ranking again.

#### G-19
`if (answer != 0) revert SequencerDown();` / `if (block.timestamp < until) revert SequencerGracePeriod(until);` · `GameEscrow.sol:654-656` · An L2 outage, when no veto can land, must not quietly shorten the challenge window.

#### G-20
`if (!_isGuardian(msg.sender) && !_isGovernance(msg.sender)) revert NotGuardian();` · `GameEscrow.sol:891` · Restricts `veto` and `dismissDispute` to the guardian or the config owner.

#### G-21
`if (block.timestamp >= info.deadline) revert ChallengeWindowClosed(info.deadline);` · `GameEscrow.sol:952` · Veto, dispute and dismissal can only happen while the result is still open to objection.

#### G-22
`if (number == 0) revert NotSeated(...)` / `if (seen & bit != 0) revert AlreadyDisputed(...)` · `GameEscrow.sol:719-722` · Only seated players can dispute, once each, which bounds how many times the deadline can be extended.

#### G-23
`if (!info.disputed) revert NotDisputed(matchId);` · `GameEscrow.sol:740` · The deadline is only rolled back by `DISPUTE_EXTENSION` when it was actually extended (avoids a double subtraction).

#### G-24
`if (block.timestamp < cancellableAt) revert CannotCancelYet(matchId);` / `if (block.timestamp < info.deadline) revert CannotCancelYet(matchId);` · `GameEscrow.sol:829,832` · Refunds open only after the relevant deadline, plus `LOCK_GRACE` for a quorate lobby, so a seated player cannot race a lock with a cancel.

#### G-25
`if (block.timestamp >= info.joinDeadline) ...` / `if (info.seatCount >= info.maxSeats) ...` / `if (hasSeat(...)) ...` / `if (info.matchmade && !rostered[...]) ...` · `GameEscrow.sol:986-989` · These are the seating rules every join route ends in: within the window, a free seat, one seat per player, and roster-only for matchmade lobbies.

#### G-26
`if (owed != 0 && owed < MIN_WITHDRAW_FOR) revert BelowMinimumWithdrawal(...)` · `PullPayable.sol:61` · Stops third parties draining a relayer's gas with dust withdrawals.

#### G-27
`if (amount == 0) revert NothingToWithdraw();` · `PullPayable.sol:67` · A zero payout is never sent.

#### G-28
`if (!_isGuardian(msg.sender)) revert NotGuardian();` / `if (block.timestamp < availableAt) revert GuardianCooldown(availableAt);` · `ExpiringPause.sol:55-57` · The guardian's emergency stop is rate-limited, so a compromised guardian cannot stop play indefinitely.

#### G-29
`if (!_isGovernance(msg.sender)) revert NotGovernance();` / `if (until <= block.timestamp || until <= pausedUntil) revert PauseNotExtended(...)` · `ExpiringPause.sol:67-68` · Only governance can lengthen a pause, and only forwards.

#### G-30
`if (!_isGuardian(msg.sender) && !_isGovernance(msg.sender)) revert NotGovernance();` · `ExpiringPause.sol:76` · Both the guardian and governance can end a pause early (see I-14).

#### G-31
`if (newParams.feeBps > MAX_FEE_BPS) revert FeeTooHigh(newParams.feeBps);` · `ProtocolConfig.sol:322` · A hard 10% ceiling on the protocol cut, regardless of governance.

#### G-32
`if (newParams.minSeats < 2 || newParams.maxSeats < newParams.minSeats || newParams.maxSeats > ABSOLUTE_MAX_SEATS)` · `ProtocolConfig.sol:324-325` · Keeps the seat range compatible with the bitmasks and the `uint8` seat index in the commit preimage.

#### G-33
`if (payoutBps.length > newParams.minSeats)` / `if (params.minSeats != 0 && length > params.minSeats)` · `ProtocolConfig.sol:340,376` · There are never more paid positions than the smallest lobby that may start.

#### G-34
`if (total != BPS_DENOMINATOR) revert PayoutScheduleNotExact(total);` · `ProtocolConfig.sol:386` · A schedule summing to under 100% would quietly divert the shortfall to the treasury.

#### G-35
`if (threshold == 0 || threshold > attestors.length)` / `if (attestorIn[version][attestor]) revert DuplicateAttestor(attestor);` · `ProtocolConfig.sol:245,252` · Every attestor set has a reachable, non-zero threshold of distinct members.

#### G-36
`if (window == 0 || window > MAX_CHALLENGE_WINDOW) revert InvalidChallengeWindow(window);` · `ProtocolConfig.sol:271` · A zero window would pay out before anyone could object.

#### G-37
`if (lmsToken != address(0)) revert LmsTokenAlreadySet(lmsToken);` · `ProtocolConfig.sol:286` · The escrow must burn or refund the same token it took against seats.

#### G-38
`if (delay <= lifetime) revert DelayTooShort(delay, lifetime);` · `ProtocolConfig.sol:367` · A queued config change must not reach a match that was already open (see I-8).

#### G-39
`if (msg.sender != address(escrow)) revert UnexpectedSender(msg.sender);` / `if (stakerBps_ > BPS_DENOMINATOR) revert InvalidBps(stakerBps_);` · `FeeRouter.sol:92,85` · FeeRouter receives ETH only from the escrow, and the staker share cannot exceed the harvest.

#### G-40
`if (recipient == address(0) || recipient == vault || recipient == safe || recipient == address(this))` / `if (!isApproved[to]) revert RecipientNotApproved(to);` · `LiquidityReserve.sol:53,61` · The liquidity share cannot be routed into staking through the obvious paths, so it cannot vote.

#### G-41
`if (cooldown_ < MIN_COOLDOWN || cooldown_ > MAX_COOLDOWN)` / `if (block.timestamp < pending.unlockAt) revert StillCoolingDown(...)` · `StakedLms.sol:324,296` · Voters stay exposed for the cooldown after unstaking, which is the stand-in for slashing.

#### G-42
`if (block.timestamp >= claimsCloseAt()) ...` / `if (block.timestamp < claimableFrom(epoch)) ...` / `if (isClaimed(player, epoch)) ...` · `RewardsDistributor.sol:199-205` · Only ended epochs, whose fee totals are final, can be claimed, and each only once per player.

#### G-43
`if (block.timestamp < closesAt) revert ClaimsStillOpen(closesAt);` · `RewardsDistributor.sol:290` · Governance cannot sweep play-mining LMS while claims are still open.

#### G-44
`if (msg.sender != distributor) revert NotDistributor(...)` / `if (tranche.amount != 0) revert AlreadyGranted(...)` · `RewardVesting.sol:69,75` · Only the distributor can create a tranche, and it can create each (player, epoch) tranche only once.

#### G-45
`if (msg.sender != safe) ...` / `if (block.timestamp >= phaseEnd) ...` / `target == address(timelock) || selector == transferOwnership || selector == renounceOwnership` · `MultisigPhase.sol:66-67,116-119` · The Safe's proposer and canceller powers end at a fixed date, and it cannot schedule its way past that date.

#### G-46
`if (msg.sender != spokePool) ...` / `if (block.timestamp > w.deadline) ...` / `if (w.hubChainId != block.chainid) ...` / `if (w.nonce != nonce) ...` / `if (!SignatureChecker.isValidSignatureNow(...))` / `if (amount - q.outputAmount > w.maxFee)` · `BridgeJoinReceiver.sol:129,189-193,202` · Fills are accepted only from the SpokePool, and a bridge-out happens only on the player's own fresh, unexpired signature, with the Across fee capped by the player.

---

## 2. Inferred Invariants (Single-Contract)

Inferred invariants are derived from structural analysis of the source code. Each block below cites one of five extraction methods in its `Derivation` field:

- **Δ-pair (delta-pair) analysis**: two or more storage variables in the same function body change by equal-and-opposite amounts, implying a conservation law.
- **Guard lift**: a `require` / `if-revert` on a storage variable is promoted to a global property by checking that every write site enforces an equivalent guard. If any write site lacks it, the invariant is On-chain=**No**.
- **State-machine edge**: a storage variable moves through discrete values via `require(state == A); state = B`, with no reverse path.
- **Temporal predicate**: a check tied to `block.timestamp` or a stored deadline.
- **NatSpec-stated global property**: a developer-asserted invariant, then confirmed or contradicted by the structural scan.

Categories: `Conservation` · `Bound` · `Ratio` · `StateMachine` · `Temporal` (definitions at the end of §2).

---

#### I-1

`Conservation` · On-chain: **Yes**

> `address(this).balance == totalOwed + totalEscrowed` for `GameEscrow` (`>=` once ETH is forced in by `selfdestruct` or a coinbase payment).

**Derivation**: NatSpec: `GameEscrow.sol:217-220`: "the solvency invariant is `address(this).balance == totalOwed + totalEscrowed`". Δ-pairs:
- `_seat:997`: +paid against msg.value.
- `bridgeJoin:496/502`: credit equals msg.value minus stake.
- `_payOut:69-72`: `totalOwed -= amount` and the same amount leaves.
- `finalize:636`: `-(pool - discount.eth)` ↔ `_distribute:770,783`, which credits `paid + remainder = pool - discountEth`.
- `_refundAll:853` ↔ `856/865`: credits `stake - seat.eth` per seat.

These are all the write sites of `totalEscrowed` (`GameEscrow.sol:636,853,997`) and of `totalOwed` (`PullPayable.sol:70,81`).

**If violated**: Late withdrawers find the escrow short, and every outstanding balance is at risk.

---

#### I-2

`Conservation` · On-chain: **Yes**

> `totalOwed == Σ withdrawable[account]`

**Derivation**: Δ-pair: `PullPayable.sol:69 ↔ 70` (`withdrawable[account] = 0`, `totalOwed -= amount`) and `PullPayable.sol:80 ↔ 81` (`+= amount` on both). These are the only write sites.

**If violated**: `totalOwed` no longer audits what is owed, and I-1 stops meaning anything.

---

#### I-3

`Conservation` · On-chain: **Yes**

> `totalLmsEscrowed == Σ matchDiscount[m].lms` over matches not yet Settled or Cancelled, and `LMS.balanceOf(escrow) >= totalLmsEscrowed` (per spec).

**Derivation**: Δ-pairs:
- `_joinWithLms:451 ↔ 452`: `total.lms += seat.lms`, `totalLmsEscrowed += lmsUsed`.
- `finalize:642`: `-= discount.lms`, followed by a burn of the same amount.
- `_refundAll:861`: `-= total.lms`, followed by the per-seat refunds at `869`.

`matchDiscount` is never zeroed, but status leaves Open/…/Proposed exactly once (I-11).

**If violated**: Burns or refunds revert, or LMS belonging to one match is burned on another's behalf.

---

#### I-4

`Conservation` · On-chain: **Yes**

> `matchDiscount[m].eth == Σ_seat seatDiscount[m][seat].eth` (and likewise for `.lms`)

**Derivation**: Δ-pair: `GameEscrow.sol:448 ↔ 450-451`. This is the only writer of either mapping.

**If violated**: The refund at `_refundAll:865` and the fee record at `_recordFees:676` disagree with the totals subtracted from `totalEscrowed` at `636/853`.

---

#### I-5

`Conservation` · On-chain: **Yes**

> `epochFees[e] == Σ_p feesPaid[p][e]`

**Derivation**: Δ-pair: `GameEscrow.sol:677 ↔ 680`. `net` is added to `feesPaid` and to the local `total`, and `total` is then added to `epochFees` in the same body. These are the only write sites.

**If violated**: The play-mining shares of an epoch could sum to more than its budget (E-1).

---

#### I-6

`Bound` · On-chain: **Yes**

> `params.feeBps ∈ [0, MAX_FEE_BPS]` (≤ 10%)

**Derivation**: guard-lift: `if (newParams.feeBps > MAX_FEE_BPS) revert` at `ProtocolConfig.sol:322`. The single write site is `params = newParams` at `:344`, inside `_setParams`, which the constructor (`:144`) and `setParams` (`:219`) both use.

**If violated**: The protocol takes more than the advertised cap of the pool.

---

#### I-7

`Bound` · On-chain: **Yes**

> `payoutBps.length ≤ params.minSeats` and `Σ payoutBps == 10_000` at all times. Each `Terms` snapshot inherits both properties (`GameEscrow.sol:361-370`).

**Derivation**: guard-lift over both write sites:
- `payoutBps = newSchedule` at `ProtocolConfig.sol:388` is guarded by `:376` (length) and `:386` (sum).
- `params = newParams` at `:344` is guarded by `:340`, so `minSeats` cannot drop below the current schedule length.

**If violated**: `_distribute:770` reads `ranking[i]` out of bounds, or the shortfall is diverted to the treasury.

---

#### I-8

`Bound` · On-chain: **No**

> The config owner's `getMinDelay()` is greater than `matchLifetime()`, so no queued change can reach a match that was already open.

**Derivation**: guard-lift: `if (delay <= lifetime) revert DelayTooShort` at `ProtocolConfig.sol:367`. `_checkDelay` runs at `_setParams:346`, `setChallengeWindow:274` and `_transferOwnership:353`. The constrained value, however, is the timelock's own delay, and it is written outside this contract (`TimelockController.updateDelay`). `_checkDelay` also returns silently for an owner that does not answer `getMinDelay` (`:364`).

**If violated**: A change the timelock executes can reach a lobby opened before it was queued, for every config value not snapshotted into `Terms` (oracle and attestor set before lock, `sequencerUptimeFeed`, `lmsPerEthDiscount`, `bridgeReceiver`, `guardian`).

---

#### I-9

`Bound` · On-chain: **Yes**

> For every seat, `seatDiscount.eth ≤ fee(stake, terms.feeBps) * MAX_DISCOUNT_BPS / 10_000` (half the seat's fee).

**Derivation**: guard-lift: `quoteLmsDiscount` clamps to `maxDiscount` at `GameEscrow.sol:424-428`. The single write site, `seatDiscount[matchId][msg.sender] = seat` at `:448`, takes its value from that quote (`:435,447`).

**If violated**: `remainder = pool - paid - discountEth` at `:780` can underflow and brick `finalize`.

---

#### I-10

`Ratio` · On-chain: **Yes**

> At finalize: `credits = Σ payouts + (pool - paid - discountEth) = pool - discountEth`. Here `pool = stake * seatCount` and `distributable = pool - pool * feeBps / 1e4` (`GameEscrow.sol:760-761, 780`).

**Derivation**: guard-lift: `remainder ≥ 0` because `paid ≤ distributable` (I-7: the schedule sums to 1e4) and `pool*f/1e4 ≥ Σ floor(stake*f/1e4) ≥ 2·Σ seat.eth` (I-9). The snapshot is taken after `status = Settled` (`:634`) and before the LMS burn (`:643`).

**If violated**: The treasury credit underflows, or rounding dust is stranded outside `totalOwed`.

---

#### I-11

`StateMachine` · On-chain: **Yes**

> `MatchStatus` follows `None → Open → Pending → Live → Proposed → Settled`, with `{Open, Pending, Live, Proposed} → Cancelled`. Settled and Cancelled are terminal, and no edge leads backwards.

**Derivation**: edges:
- `None@935 → Open@348`
- `Open@936 → Pending@531`
- `Pending@548 → Live@557`
- `Live@579 → Proposed@592`
- `Proposed@629 → Settled@634`
- `Open|Pending|Live@826-831` (cancelMatch), `Live@804` (abortMatch) or `Proposed@695` (veto) → `Cancelled@848`

**If violated**: A match pays twice, refunds after paying, or is seeded twice.

---

#### I-12

`StateMachine` · On-chain: **No**

> Every Proposed match can always reach a terminal state.

**Derivation**: edge: `Proposed@592` leads only to `Settled@634` (`finalize`) or to `Cancelled@848` (`veto`, but only while `block.timestamp < deadline`, `:952`). `cancelMatch` rejects Proposed (`:837-838`). After the window closes, `finalize` is the sole exit. It reverts whenever `_checkSequencer` reverts (a feed that reverts or reports down, `:653-656`) or the LMS burn at `:643` reverts.

**If violated**: Stakes stay locked in `totalEscrowed` until governance changes `sequencerUptimeFeed`, through the timelock delay.

---

#### I-13

`Temporal` · On-chain: **No**

> A match finishes within `matchLifetime()`, which counts one `DISPUTE_EXTENSION` (NatSpec `ProtocolConfig.sol:200-206`).

**Derivation**: temporal: `dispute` sets `info.deadline += DISPUTE_EXTENSION` whenever `!info.disputed` (`GameEscrow.sol:725-728`). `dismissDispute` clears `disputed` (`:743`). A different seat can then dispute again, because the bitmask allows each seat once (`:722`), so the payout can move out by up to `seatCount` extensions if the guardian dismisses each one.

**If violated**: The timelock-delay argument behind I-8 (delay > lifetime) no longer covers that match.

---

#### I-14

`Bound` · On-chain: **No**

> The guardian can never lift a pause that governance put in place. NatSpec: `ProtocolConfig.sol:73-74`: "never take a stake or lift a pause put in place to stop an exploit". `ExpiringPause.sol:13-14`: governance "ends one with `unpause`". The same claim appears in the README (per spec).

**Derivation**: guard-lift: `unpause` accepts `_isGuardian(msg.sender) || _isGovernance(msg.sender)` (`ExpiringPause.sol:76`) and sets `pausedUntil = block.timestamp` (`:78`), with no check on who set the current `pausedUntil` (`:60` guardian, `:69` governance). MIGRATION.md §7 lists this as known and unfixed (per spec).

**If violated**: A compromised guardian can resume `settle`, `createMatch`, joins and `lockMatch` during a governance-imposed stop.

---

#### I-15

`Temporal` · On-chain: **Yes**

> Each guardian pause lasts at most `GUARDIAN_PAUSE` (7 d). After any pause ends, the guardian cannot pause again for `GUARDIAN_COOLDOWN` (7 d).

**Derivation**: temporal: `availableAt = pausedUntil == 0 ? 0 : pausedUntil + GUARDIAN_COOLDOWN; if (block.timestamp < availableAt) revert` (`ExpiringPause.sol:56-57`). `pausedUntil = now + GUARDIAN_PAUSE` (`:59-60`). Every write site (`:60,69,78`) leaves `pausedUntil` at or after the end of the last pause.

**If violated**: The guardian could hold play stopped without governance.

---

#### I-16

`Temporal` · On-chain: **Yes**

> `feesPaid[p][e]` and `epochFees[e]` are only written while `block.timestamp / FEE_EPOCH == e`. Once epoch `e` ends, its totals are final.

**Derivation**: temporal: `uint256 epoch = block.timestamp / FEE_EPOCH;` at `GameEscrow.sol:672` is the only index used by the writers `:677,680`.

**If violated**: Claims of an epoch made at different times would see different totals, and E-1 breaks.

---

#### I-17

`StateMachine` · On-chain: **Yes**

> `lmsToken` is a one-shot latch (`0 → token`), and `rulesHash` never returns to zero once set.

**Derivation**: edge: `require(lmsToken == 0)@ProtocolConfig.sol:286 → lmsToken = token@287`, with no other writer. `setRulesHash` rejects zero (`:225`) and is the sole writer (`:227`).

**If violated**: The escrow could try to burn or refund a different token from the one it holds (`GameEscrow.sol:643,862`).

---

#### I-18

`StateMachine` · On-chain: **Yes**

> `attestorSetVersion` strictly increases, and a version's members and threshold are never changed once written.

**Derivation**: edge: `version = attestorSetVersion + 1@ProtocolConfig.sol:248 → attestorSetVersion = version@257`. `attestorIn[version]`, `attestorsOf[version]` and `thresholdOf[version]` are written only for the fresh version (`:253-256`).

**If violated**: A match's snapshotted attestor set (`GameEscrow.sol:533`) could change under it.

---

#### I-19

`Conservation` · On-chain: **Yes**

> `LMS.balanceOf(StakedLms) ≥ totalSupply() + totalUnstaking` (1 sLMS = 1 LMS).

**Derivation**: Δ-pairs: `_deposit:182 ↔ 183` (+amount in, +amount minted), `requestUnstake:280 ↔ 281` (−supply, +unstaking) and `claim:300 ↔ 301` (−unstaking, −amount out). `sweepStray:317` removes only the excess.

**If violated**: Unstakers cannot claim, and `sweepStray` underflows.

---

#### I-20

`Bound` · On-chain: **Yes**

> `cooldown ∈ [1 days, 30 days]`

**Derivation**: guard-lift: `StakedLms.sol:324`. The single write site, `:326`, runs inside `_setCooldown`, which the constructor (`:145`) and `setCooldown` (`:310`) both use.

**If violated**: Exits are instant, or locked for unbounded time.

---

#### I-21

`Bound` · On-chain: **No**

> `cooldown > votingPeriod + timelockDelay`, so a voter is still exposed when their proposal executes. NatSpec: `StakedLms.sol:42-43`: "`Deploy` checks that `cooldown` outlasts the voting period plus the timelock delay."

**Derivation**: guard-lift: enforced only in `script/Deploy.s.sol:477` (`if (cooldown <= exposure) revert CooldownTooShort`). `setCooldown` (`StakedLms.sol:309`) checks only `[1d, 30d]`. Neither the governor's `votingPeriod` nor the timelock delay is re-checked when either changes.

**If violated**: A voter can unstake and exit before the proposal they passed executes, which removes the slashing substitute.

---

#### I-22

`StateMachine` · On-chain: **Yes**

> `rewardPerShareStored` never decreases. NatSpec: `StakedLms.sol:53`: "`rewardPerShare` only ever grows".

**Derivation**: guard-lift: the single write site is `rewardPerShareStored += ...` at `StakedLms.sol:254`.

**If violated**: `_settle:264` underflows, which locks transfers and claims.

---

#### I-23

`Ratio` · On-chain: **Yes**

> `rewardRate = (msg.value + unpaid) * 1e27 / rewardDuration`, with `unpaid = (periodFinish - now) * rewardRate_old / 1e27`, both rounded down.

**Derivation**: guard-lift: `StakedLms.sol:197-201`. The snapshot is taken after `_accrue()` (`:194`) has advanced `rewardPerShareStored`, and while `supply == 0` `_accrue` instead pushes `periodFinish` out (`:248-251`).

**If violated**: The stream pays out more ETH than was deposited, and the last claimers' `call` fails.

---

#### I-24

`Bound` · On-chain: **Yes**

> `stakerBps ≤ 10_000`, and every harvest splits exactly `toStakers + toTreasury == amount`.

**Derivation**: guard-lift: `FeeRouter.sol:85`, with the single write site `:87`. Ratio at `:57-58`.

**If violated**: The harvest reverts, or ETH is stranded in FeeRouter.

---

#### I-25

`StateMachine` · On-chain: **Yes**

> An epoch's `Rate` (value and walletCap) is fixed by the first successful claim, and never changes after that.

**Derivation**: edge: `if (stored.fixed_) return stored;@RewardsDistributor.sol:260 → rates[epoch] = {fixed_: true,...}@268`. There is no other writer.

**If violated**: Two claimants of one epoch are paid at different rates, and E-1 breaks.

---

#### I-26

`StateMachine` · On-chain: **Yes**

> A player's claimed bit for an epoch is set at most once and is never cleared. It is set whenever `feesPaid > 0`, even when the computed reward is 0.

**Derivation**: edge: `isClaimed(player, epoch) == false@RewardsDistributor.sol:205 → claimedBits |= bit@211`. The reward is computed after the bit is set (`:213`), so an epoch with `paid > 0` and `reward == 0` is consumed. It is reachable by anyone, since `claim` takes any `player` (`:198`).

**If violated**: The epoch is double-claimed. Conversely, an epoch can be consumed with a zero grant.

---

#### I-27

`Conservation` · On-chain: **Yes**

> `RewardVesting.totalGranted == Σ trancheOf[*][*].amount` and `totalReleased == Σ trancheOf[*][*].released`

**Derivation**: Δ-pairs: `RewardVesting.sol:76 ↔ 80` (accumulated in `total`) and `RewardVesting.sol:133 ↔ 137`.

**If violated**: The vesting contract's LMS balance cannot be reconciled with what it owes.

---

#### I-28

`Bound` · On-chain: **Yes**

> `trancheOf[p][e].released ≤ trancheOf[p][e].amount`

**Derivation**: guard-lift: `releasable = vested - released` (`:100`), with `vested ≤ amount` (`:94-95`). The single write site, `:133`, adds exactly `releasable`.

**If violated**: Vesting LMS is paid out twice.

---

#### I-29

`StateMachine` · On-chain: **Yes**

> Each `(player, epoch)` tranche is created once (`amount: 0 → x`) and its amount never changes.

**Derivation**: edge: `if (tranche.amount != 0) revert@RewardVesting.sol:75 → tranche.amount = amount@76`. `amount` has no other writer.

**If violated**: A tranche could be overwritten with a larger grant.

---

#### I-30

`Bound` · On-chain: **Yes**

> For each session: `spent ≤ spendCap`, every call's `value ≤ valueCap`, and `validUntil ≤ grantTime + 7 days`.

**Derivation**: guard-lift: `_spend:246-251`, the single writer of `spent` apart from the reset at grant (`:148`). `grantSession:143` is the single writer of `validUntil` (`revokeSession:155` deletes). The cap applies per grant: a re-grant resets `spent` to 0 (`:148-149`).

**If violated**: A leaked session key moves more ETH than the player authorised.

---

#### I-31

`StateMachine` · On-chain: **Yes**

> Per-account session nonce and per-player withdrawal nonce are strictly increasing.

**Derivation**: edges: `nonce != $.nonce → revert@SessionKeyDelegate.sol:193 → ++$.nonce@205` (before the external call at `:209`). `w.nonce != nonces[w.player] → revert@BridgeJoinReceiver.sol:192 → nonces = nonce + 1@196`.

**If violated**: A relayed call or a signed withdrawal is replayed.

---

#### I-32

`Bound` · On-chain: **No**

> `BridgeJoinReceiver` "Holds nothing between transactions except what it could not route", and unroutable value leaves only through `recover` (NatSpec `BridgeJoinReceiver.sol:29-35,47`).

**Derivation**: guard-lift: `_unwrap` returns `address(this).balance >= amount` (`:174`) when WETH is short (`:168`), and `_routeJoin` then forwards `amount` ETH (`:144`). ETH held from an earlier `Unroutable` event (`:134`) can therefore fund a later fill, a second exit besides `recover` (`:245`).

**If violated**: Held value meant for the timelock's review leaves through the join path.

---

#### I-33

`Temporal` · On-chain: **Yes**

> The Safe's `schedule`, `scheduleBatch` and `cancel` work only while `block.timestamp < phaseEnd`. `retire` works only at or after it, and `phaseEnd ≤ deploy + 2 years`.

**Derivation**: temporal: `MultisigPhase.sol:67`, `:106` and `:50`. `phaseEnd` is immutable (`:38`).

**If violated**: The multisig veto outlives its advertised end date.

---

#### I-34

`StateMachine` · On-chain: **Yes**

> A VRF request is answered at most once, and its word cannot change after that.

**Derivation**: edge: `request.answered == false@ChainlinkVrfAdapter.sol:111 → answered = true@112`. The request is deleted only after a successful delivery (`:129`).

**If violated**: The seed could be replaced after the match saw it. `fulfillRandomness`'s status check (`GameEscrow.sol:548`) is the second line of defence.

---

#### I-35

`Bound` · On-chain: **Yes**

> `PlayerAvatars.totalMinted ≤ maxSupply`, and each wallet mints at most once.

**Derivation**: guard-lift: `PlayerAvatars.sol:77-78`. The only writers are `:80-81`, both inside `mint`.

**If violated**: The supply cap is exceeded. This is cosmetic only and has no funds impact.

---

#### I-36

`Bound` · On-chain: **Yes**

> Quorum floor ≤ 10% of the LMS `totalSupply()` at the moment it is written.

**Derivation**: guard-lift: `if (newQuorumFloor > max) revert QuorumFloorTooHigh` at `LmsGovernor.sol:115`. The single writer is `_updateQuorumFloor` (`:117`), used by the constructor (`:87`) and `setQuorumFloor` (`:110`).

**If violated**: Governance could set a floor no achievable stake can reach.

---

#### I-37

`Bound` · On-chain: **No**

> Quorum floor ≤ 10% of the *current* LMS supply. NatSpec: `LmsGovernor.sol:44-47`: "capped at 10% of the LMS supply, so a proposal cannot raise it out of reach".

**Derivation**: guard-lift gap: the bound is checked only at write time (`:115`), and LMS supply shrinks without any governor write. `LmsToken` is `ERC20Burnable` (`LmsToken.sol:24`), and `GameEscrow.finalize` burns discount LMS (`GameEscrow.sol:643`).

**If violated**: After enough burns the floor exceeds 10% of supply. The effect is small unless burns are large.

---

**Categories:**
- **Conservation**: Two or more storage variables change by equal-and-opposite amounts in the same function body.
- **Bound**: A guard on a storage variable, lifted to a global property and enforced at every write site. On-chain=**No** if any write site lacks it.
- **Ratio**: A storage variable defined as a formula of other storage variables.
- **StateMachine**: A storage variable that moves through discrete values with no reverse path.
- **Temporal**: A condition that depends on `block.timestamp` or a stored deadline.

---

## 3. Inferred Invariants (Cross-Contract)

Trust assumptions that span contract boundaries. Each block cites both caller-side and callee-side code.

---

#### X-1

On-chain: **No**

> `GameEscrow` assumes the `bridgeReceiver` withdraws an account's balance only on that account's signature.

**Caller side**: `GameEscrow.sol:509-511`: `withdrawToBridge(account)` checks only `msg.sender == config.bridgeReceiver()` and then pays `account`'s whole balance to the caller. It is not paused.

**Callee side**: `ProtocolConfig.sol:306-308`: `setBridgeReceiver` writes any address with no validation. Today's receiver checks the signature at `BridgeJoinReceiver.sol:193`.

**If violated**: Every player's withdrawable balance can be moved by whoever is set as the receiver once the timelock executes it.

---

#### X-2

On-chain: **Yes**

> `settle` and `abortMatch` assume the attestor version snapshotted at lock is immutable.

**Caller side**: `GameEscrow.sol:533,582-588,805-809`: `checkQuorum(info.attestorSetVersion, …)`.

**Callee side**: `ProtocolConfig.sol:244-258`: `setAttestorSet` only creates `attestorSetVersion + 1`. Old versions are never written again (I-18).

**If violated**: A newly installed set could settle matches that locked under the old one.

---

#### X-3

On-chain: **Yes**

> The `Terms` stored at lobby creation (fee, seats, windows, payout schedule, treasury, rulesHash) cannot be changed by later config writes.

**Caller side**: `GameEscrow.sol:356-379`: `_currentTerms` copies the values into `terms[termsId]`, which is written only when `termsId` is fresh (`:375-377`).

**Callee side**: `ProtocolConfig.sol:218-232,270-275`: setters change only the config's own storage.

**If violated**: A governance change would alter the deal of a player who already staked.

---

#### X-4

On-chain: **No**

> `finalize` assumes the sequencer feed it reads live is reachable and well-formed for every Proposed match.

**Caller side**: `GameEscrow.sol:650-657`: `config.sequencerUptimeFeed()` is read at finalize, not snapshotted, and a revert or `answer != 0` blocks payout.

**Callee side**: `ProtocolConfig.sol:277-280`: `setSequencerUptimeFeed` writes any address with no validation.

**If violated**: Every Proposed match past its challenge window is stuck (I-12) until the timelock repoints the feed.

---

#### X-5

On-chain: **Yes**

> `FeeRouter.harvest` assumes `escrow.withdraw(this)` sent exactly the returned `amount` to FeeRouter.

**Caller side**: `FeeRouter.sol:55-64`: it splits `amount` and pushes ETH.

**Callee side**: `PullPayable.sol:65-73`: `_payOut` zeroes the balance and `call`s `to` with exactly `amount`.

**If violated**: The harvest over-sends and reverts, or strands ETH.

---

#### X-6

On-chain: **Yes**

> `RewardsDistributor` assumes `escrow.feesPaid` and `escrow.epochFees` for an ended epoch never change.

**Caller side**: `RewardsDistributor.sol:204,207,252,269`: claims are allowed only after `claimableFrom(epoch)`, and the rate is fixed from `epochFees` at first claim.

**Callee side**: `GameEscrow.sol:672-680`: the only writers index by the current `block.timestamp / FEE_EPOCH` (I-16). `epochLength` is read from `escrow.FEE_EPOCH()` (`RewardsDistributor.sol:131`).

**If violated**: Early claimants of an epoch are paid at a rate based on a smaller `epochFees` value than late claimants.

---

#### X-7

On-chain: **Yes**

> `RewardsDistributor.claim` assumes `vesting.grant` records exactly the LMS it just transferred.

**Caller side**: `RewardsDistributor.sol:213-219`: `reward = Σ amounts[i]`, followed by `safeTransfer(vesting, reward)` and `grant(player, epochs, amounts)`.

**Callee side**: `RewardVesting.sol:68-81`: zero amounts are skipped, every non-zero amount becomes a tranche, and a duplicate epoch reverts. Duplicates are already rejected upstream by `AlreadyClaimed` (`RewardsDistributor.sol:205`).

**If violated**: The vesting contract's balance and `totalGranted` diverge.

---

#### X-8

On-chain: **Yes**

> `ZapJoin` assumes the stake read from `getMatch` is the exact value `joinFor` requires.

**Caller side**: `ZapJoin.sol:114-120`.

**Callee side**: `GameEscrow.sol:345,472`: `stake` is written once at creation, and `joinFor` requires `msg.value == info.stake`.

**If violated**: The swap output and the join value disagree, and the transaction reverts. No value is lost.

---

#### X-9

On-chain: **No**

> `SessionKeyDelegate` assumes `join(matchId)` "can stake the player's ETH into lobbies but never send it anywhere" (NatSpec `SessionKeyDelegate.sol:36-39`).

**Caller side**: `SessionKeyDelegate.sol:265-266`: any `matchId` is allowed. There is no check on the lobby's creator, on whether it is matchmade, or on its stake beyond `valueCap`.

**Callee side**: `GameEscrow.sol:304-306,382-384`: anyone can open a private lobby and fill the other seats, and the result redistributes the stakes according to the off-chain outcome (`_distribute:766-775`).

**If violated**: A leaked key can move up to `spendCap` of the account's ETH, as stakes, into lobbies whose other seats the key holder controls.

---

#### X-10

On-chain: **Yes**

> `GameEscrow` assumes only the oracle snapshotted at lock can seed a match, even if the adapter's coordinator changes.

**Caller side**: `GameEscrow.sol:530-535,547`.

**Callee side**: `ChainlinkVrfAdapter.sol:68-76,108`: `setCoordinator` swaps the coordinator, and fulfilments from the old one are rejected. The match then exits via `cancelMatch` after `RANDOMNESS_TIMEOUT` (`GameEscrow.sol:831-836`).

**If violated**: The seed source is undefined. The refund path remains.

---

#### X-11

On-chain: **No**

> `_refundAll` assumes the LMS token has no transfer hooks, so a push refund cannot revert (comment `GameEscrow.sol:866-867`).

**Caller side**: `GameEscrow.sol:862-870`: `lms.safeTransfer(seats[i], seat.lms)` runs inside the refund loop.

**Callee side**: `ProtocolConfig.sol:284-289`: `setLmsToken` accepts any token address. Nothing checks that it is the hook-less `LmsToken`.

**If violated**: One seat's revert blocks cancel, veto and abort for the whole match.

---

#### X-12

On-chain: **No**

> `MultisigPhase` assumes blocking timelock-targeted calls and `transferOwnership`/`renounceOwnership` is enough that "Everything else it schedules can be undone by governance afterwards" (NatSpec `MultisigPhase.sol:30`).

**Caller side**: `MultisigPhase.sol:114-120`: a selector deny-list of two entries plus the timelock target.

**Callee side**: The following setters remain schedulable by the Safe, and each has effects that execution makes permanent:
- `ProtocolConfig.setBridgeReceiver:306` (X-1)
- `setGuardian:262`
- `setMatchmaker:314`
- `setAttestorSet:244`
- `ChainlinkVrfAdapter.setCoordinator:68`
- `LiquidityReserve.setRecipient:52`

**If violated**: A balance drained through the new receiver, or a seed chosen by a swapped coordinator, cannot be undone by a later proposal.

---

#### X-13

On-chain: **Yes**

> `BridgeJoinReceiver._routeJoin` assumes `bridgeJoin` never reverts for a non-zero player when called by the configured receiver.

**Caller side**: `BridgeJoinReceiver.sol:141-152`: the call is wrapped in try/catch, and a revert leaves the value as `Unroutable`.

**Callee side**: `GameEscrow.sol:489-503`: every seating failure becomes a credit (`_joinFailure:962-976` mirrors `_seat:986-989`). The only reverts are a non-receiver caller and a zero player.

**If violated**: A fill reverts, which is caught, and the value is held for `recover`.

---

## 4. Economic Invariants

Higher-order properties derived from combinations of §2 and §3 invariants.

---

#### E-1

On-chain: **Yes**

> The play-mining rewards of an epoch sum to at most `epochBudget(epoch)`.

**Follows from**: `I-5` + `I-16` + `X-6` + `I-25`. Fees are final, Σ feesPaid equals epochFees, and the fixed rate is ≤ `budget*1e18/epochFees` (`RewardsDistributor.sol:254`), with each reward rounded down.

**If violated**: The program runs out of LMS before its last epochs.

---

#### E-2

On-chain: **Yes**

> Every payout of a match goes to a seated address or to the treasury the match was opened with, and the total credited equals what the seats paid in ETH.

**Follows from**: `I-1` + `I-10` + `I-11` + `X-3`, together with guards `G-16` and `G-18`.

**If violated**: A quorum or a finaliser redirects a pool to outsiders.

---

#### E-3

On-chain: **No**

> No role short of governance can move a player's balance to an address the player did not choose.

**Follows from**: `X-1` (the receiver can withdraw any balance) + `X-9` (a leaked session key can move stakes into controlled lobbies) + `X-12`. The guardian and attestor paths alone hold (`E-2`, the veto-only refund at `I-11`).

**If violated**: Funds held by the protocol depend on the integrity of the bridge receiver and of session keys, beyond the escrow's own checks.

---

#### E-4

On-chain: **No**

> A player who sees a config change queued can always exit before it reaches their match.

**Follows from**: `I-8` (the delay versus lifetime check is not tied to the timelock's own delay) + `I-13` (serial disputes extend the lifetime) + `X-4` (the feed is read live).

**If violated**: A queued change, such as a feed or receiver swap, executes against a match the player could not leave.
