# Round-Trip & Rounding Analyst: proposed properties

Scope: `GameEscrow`, `PullPayable`, `StakedLms`, `FeeRouter`, `RewardsDistributor`, `RewardVesting`, `BridgeJoinReceiver`, `ZapJoin`, `LmsGovernor` (quorum only). The code was read; the stale x-ray was not relied on.
Harness handles assumed (from `Base.sol`): `escrow`, `lms`, `stakedLms`, `feeRouter`, `rewards`, `vesting`, `bridgeReceiver`, `zap`, `acrossPool`, `poolManager`, `zapToken`, `zapTokenB`, `governor`, `actors`, `actor`, `matchIds`, `feeEpochs`, `proposedRanking`.

Code facts that shape the properties:
- There is no ERC-4626 vault. `StakedLms` is a 1:1 wrapper, so there is no share rounding. The rounding surfaces are:
  - `_distribute` (floor payouts, remainder to the treasury);
  - `_fee`;
  - the LMS discount (`quoteLmsDiscount`: floor in the uncapped branch, ceil in the capped branch);
  - `FeeRouter.harvest` (floor to stakers);
  - the StakedLms reward stream (1e27 fixed point, floor at 4 places);
  - `epochBudget` and the distributor rate (floor);
  - `vested` (floor).
- Pattern E2 (same conversion function in both directions) does not apply. No function pair shares one conversion.
- ETH rule: no property below asserts on an actor's ETH around a payable call. ETH an actor or receiver gets from a withdrawal, and protocol-side balances and aggregates, are used instead.
- `ProtocolConfig` guarantees the payout schedule sums to exactly 10000 bps (`PayoutScheduleNotExact`), and `payoutBps.length <= minSeats`. `MAX_FEE_BPS` is 1000. These make the `_distribute` arithmetic safe, and RD-04 relies on them.

---

## Round-trip properties

```
PROPERTY_ID: RT-01
TYPE: SPECIFIC
ENGLISH: Join then cancel, abort or veto is a net-zero round trip for ETH. Each seat is credited exactly the stake it paid (stake, no discount). The sum credited equals stake*seatCount, and totalEscrowed falls by exactly that amount. Nothing is created and nothing is kept.
SOLIDITY_SKETCH:
  // in escrow_cancelMatch / escrow_abortMatch / veto handlers, discount-free matches (matchDiscount.eth == 0)
  // before: seats = escrow.getSeats(id); for each seat s: wBefore[s] = escrow.withdrawable(s); owedBefore = escrow.totalOwed(); escBefore = escrow.totalEscrowed();
  // call; after the call (status == Cancelled):
  //   for each seat s (unique): eq(escrow.withdrawable(s) - wBefore[s], info.stake)   // only if s is not also the treasury of a prior credit: use delta, not absolute
  //   eq(escrow.totalOwed() - owedBefore, uint256(info.stake) * seats.length);
  //   eq(escBefore - escrow.totalEscrowed(), uint256(info.stake) * seats.length);
GHOST_NEEDS: none
SNAPSHOT_NEEDS: totalOwed, totalEscrowed, per-seat withdrawable (a scratch array scoped to the handler; also OK as a small mapping)
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: GameEscrow NatSpec on `_refundAll`: "credits every seat what it paid back: its stake, less any discount"; contract header: "every stake is refundable"; PullPayable solvency identity.
RATIONALE: This is the join/refund pair. Seats are credited from `info.stake` while `totalEscrowed` is debited from `stake*seats.length - total.eth`, so any divergence (for example a discounted seat whose `seat.eth` was not recorded) shows up as value created or lost at refund time.
```

```
PROPERTY_ID: RT-02
TYPE: SPECIFIC
ENGLISH: Join-with-LMS then cancel, abort or veto returns exactly what was paid. The seat gets `stake - seatDiscount.eth` credited in ETH and `seatDiscount.lms` in LMS. The LMS held by the escrow falls by the same amount, and `totalLmsEscrowed` stays equal to the sum over open matches of `matchDiscount.lms`. After the refund the player's LMS is back to its pre-join balance (the pre-join balance is a ghost).
SOLIDITY_SKETCH:
  // joinWithLms handler: ghost lmsBeforeJoin[matchId][actor] = lms.balanceOf(actor); ghost paidEth = msg.value
  // refund handler, for each seat s with d = escrow.getSeatDiscount(id,s):
  //   eq(escrow.withdrawable(s) - wBefore[s], info.stake - d.eth);
  //   eq(lms.balanceOf(s) - lmsBefore[s], d.lms);
  //   eq(totalLmsBefore - escrow.totalLmsEscrowed(), matchDiscount.lms)   // sum of d.lms over seats
  //   eq(lms.balanceOf(address(escrow)) delta, -sum d.lms)
  // and tie ETH to what the seat actually paid: ghostPaidEth[matchId][s] == info.stake - d.eth
GHOST_NEEDS: lmsBeforeJoin[matchId][player], ethPaidAtJoin[matchId][player] (or recompute from d), matchLmsPaidSum[matchId]
SNAPSHOT_NEEDS: totalOwed, totalEscrowed, totalLmsEscrowed, lms.balanceOf(escrow), per-seat withdrawable and LMS balance
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: GameEscrow NatSpec: "The LMS is held here, against the seat, until the match ends: burned when it settles, refunded with the stake when it is cancelled, vetoed or aborted."
RATIONALE: The discount path stores the per-seat amounts in `seatDiscount`, and the sum in `matchDiscount`. `_refundAll` reads `matchDiscount` for the total and `seatDiscount` per seat. A seat whose refund is rounded or overwritten differently from the total leaks ETH or LMS. (A bridged or `joinFor` seat has no discount, so the mixed case is worth fuzzing.)
```

```
PROPERTY_ID: RT-03
TYPE: SPECIFIC
ENGLISH: Credit then withdraw is exact. `withdraw`, `withdrawFor` and `withdrawToBridge` pay exactly the pre-call `withdrawable[account]`, leave it at zero, and reduce both `totalOwed` and the contract's ETH balance by exactly that amount. The recipient's ETH delta equals the amount (the recipient is an EOA actor or the receiver).
SOLIDITY_SKETCH:
  // in escrow_withdraw_clamped / escrow_withdrawFor_clamped, receiver rcv = to (not the escrow itself)
  // pre: w = escrow.withdrawable(account); owed = escrow.totalOwed(); bal = address(escrow).balance; rcvBal = rcv.balance
  uint256 amt = escrow.withdraw(to);
  eq(amt, w);
  eq(escrow.withdrawable(account), 0);
  eq(owed - escrow.totalOwed(), amt);
  eq(bal - address(escrow).balance, amt);
  eq(to.balance - rcvBal, amt);   // safe: receiving ETH, but skip if `to` is a contract that forwards or the harness itself
GHOST_NEEDS: none
SNAPSHOT_NEEDS: totalOwed, escrow ETH balance, recipient ETH balance, withdrawable[account]
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: PullPayable NatSpec: `address(this).balance == totalOwed + totalEscrowed` holds "because every credit and every withdrawal goes through the two functions below"; `_payOut` is the closed-form identity.
RATIONALE: This closes the credit/withdraw pair that every payout, refund and fee goes through. It overlaps the existing solvency invariant but pins the per-call delta, which catches a partial pay or a double debit that the aggregate can miss when donations mask it.
```

```
PROPERTY_ID: RT-04
TYPE: SPECIFIC
ENGLISH: bridgeJoin accounts for every wei of `msg.value`. If the seat could not be taken, all of it is credited to the player and nothing is escrowed. If the seat was taken, exactly `stake` is escrowed and `msg.value - stake` is credited to the player. In both cases `Δ totalEscrowed + Δ totalOwed == msg.value`. The player can then withdraw exactly that credit back (RT-03).
SOLIDITY_SKETCH:
  // in bridge handlers that drive handleV3AcrossMessage / escrow.bridgeJoin via acrossPool
  // pre: esc0 = escrow.totalEscrowed(); owed0 = escrow.totalOwed(); w0 = escrow.withdrawable(player); seated0 = escrow.hasSeat(id, player)
  // post: dEsc = escrow.totalEscrowed() - esc0; dOwed = escrow.totalOwed() - owed0;
  eq(dEsc + dOwed, amountDelivered);        // only when the handler was routed (not Unroutable)
  if (!seated0 && escrow.hasSeat(id, player)) { eq(dEsc, info.stake); eq(escrow.withdrawable(player) - w0, amountDelivered - info.stake); }
  else { eq(dEsc, 0); eq(escrow.withdrawable(player) - w0, amountDelivered); }
GHOST_NEEDS: amountDelivered (the handler already knows it)
SNAPSHOT_NEEDS: totalEscrowed, totalOwed, withdrawable[player], hasSeat
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: GameEscrow NatSpec on `bridgeJoin`: "all of it is credited to the player here instead... More than the stake takes the seat and credits the player the rest."
RATIONALE: Bridged value is the one entry that can neither revert nor be retried. A rounding or branch error here either strands bridged money or mints a free seat.
```

```
PROPERTY_ID: RT-05
TYPE: SPECIFIC
ENGLISH: withdrawToChainFor moves the player's whole escrow balance and no more. The amount debited from the escrow equals the `inputAmount` deposited into the SpokePool. The receiver ends with no more ETH than it started with. The fee kept (`amount - outputAmount`) is at most `maxFee`. After the call the player's escrow balance is 0.
SOLIDITY_SKETCH:
  // in bridge_withdrawToChainFor (success branch of the signed, non-clamped-to-fail call)
  // pre: w = escrow.withdrawable(player); rcvEth = address(bridgeReceiver).balance; owed0 = escrow.totalOwed()
  uint256 amount = bridgeReceiver.withdrawToChainFor(wd, q, sig);
  eq(amount, w);
  eq(escrow.withdrawable(player), 0);
  eq(owed0 - escrow.totalOwed(), amount);
  eq(address(bridgeReceiver).balance, rcvEth);      // holds nothing but what it could not route
  lte(amount - q.outputAmount, wd.maxFee);
  // and the mock SpokePool recorded inputAmount == amount, outputAmount == q.outputAmount
GHOST_NEEDS: last deposit recorded by `acrossPool` (inputAmount, outputAmount); or read it from the mock
SNAPSHOT_NEEDS: withdrawable[player], bridgeReceiver ETH balance, totalOwed
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: BridgeJoinReceiver NatSpec: "Holds nothing between transactions except what it could not route"; "`maxFee` still caps what Across takes".
RATIONALE: This is the out leg of the join/bridge pair (RT-04 is the in leg). Together they bound what a bridged round trip can lose to the relayer fee and rule out gain.
```

```
PROPERTY_ID: RT-06
TYPE: GLOBAL (ghost identity) + SPECIFIC (per call)
ENGLISH: The stake/unstake cycle is exactly 1:1 and creates no LMS. `deposit(x)` mints exactly x sLMS and pulls exactly x LMS. `requestUnstake(x)` burns x sLMS and adds x to the actor's pending `assets` and `totalUnstaking`. `claim` pays exactly the pending `assets`. Globally, `totalSupply() + totalUnstaking() == Σ deposited - Σ claimed`. N cycles of deposit then requestUnstake then claim never raise an actor's LMS balance.
SOLIDITY_SKETCH:
  // per call (in stakedLms_deposit / requestUnstake / claim handlers)
  //   deposit: eq(stakedLms.balanceOf(acct) - sBefore, x); eq(lmsBefore - lms.balanceOf(actor), x);
  //   claim:   eq(lms.balanceOf(receiver) - lmsBefore, pendingBefore.assets);
  // global:
  function property_stakedLms_noLmsCreated() public returns (bool) {
      return stakedLms.totalSupply() + stakedLms.totalUnstaking() == ghosts.slmsDeposited - ghosts.slmsClaimed;
  }
  // cycle: ghost actorNetLms[a] = Σ deposits(a) - Σ claims(a); require lms.balanceOf(a) + sLMS(a) + unstakeOf(a).assets doesn't exceed funded+received (transfers handled via a separate ghost)
GHOST_NEEDS: slmsDeposited (every successful deposit and depositFor and depositWithPermit amount), slmsClaimed (every successful claim amount)
SNAPSHOT_NEEDS: actor LMS balance, sLMS balance, unstakeOf(actor).assets
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: StakedLms NatSpec: "Stake LMS, receive sLMS one for one... a plain wrapper... one sLMS is always one LMS, so there is no exchange rate, no share maths".
RATIONALE: This is the C2 dust-extraction pattern for the one deposit/withdraw pair in scope. With a 1:1 wrapper any deviation, even 1 wei, is a bug. `stakedLms_donateLms` adds LMS but neither supply nor unstaking, so this identity is donation-proof. (`>=` against the LMS balance is the existing invariant; this one is an equality on the protocol's own books.)
```

```
PROPERTY_ID: RT-07
TYPE: SPECIFIC
ENGLISH: Staking and unstaking in the same transaction earns nothing (no flash-stake reward). If an actor deposits x and immediately requests unstake of x in one call (same timestamp), the actor's `earned()` is unchanged, and so is every other account's.
SOLIDITY_SKETCH:
  // dedicated handler stakedLms_flashStakeRoundTrip(uint256 amt) public asActor
  amt = clampBetween(amt, 1, lms.balanceOf(actor)); lms.approve(address(stakedLms), amt);   // under asActor
  uint256 eBefore = stakedLms.earned(actor); uint256 rpsBefore = stakedLms.rewardPerShare();
  stakedLms.deposit(amt);
  stakedLms.requestUnstake(amt);
  eq(stakedLms.earned(actor), eBefore);       // exact: no time passes, deposit settles before the balance moves
  lte(stakedLms.earned(actor), eBefore);       // minimum form if exactness is too strict across a supply-0 -> supply>0 pause
  // also: sum over other actors of earned() is unchanged
GHOST_NEEDS: none
SNAPSHOT_NEEDS: earned(actor), rewardPerShare
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: StakedLms NatSpec: "Paying a harvest out the moment it arrived would let anyone stake, call the permissionless `harvest` and take a full share of every fee since the last one, in a single transaction... a late staker earns only for the time they are actually staked."
RATIONALE: This is the attack the streaming design exists to stop. It also detects a first-staker artifact: when supply is 0 the stream pauses (`periodFinish += now - last`), and a depositor who lands on supply==0 must not collect the paused-stream backlog for zero seconds of staking.
```

```
PROPERTY_ID: RT-08
TYPE: SPECIFIC
ENGLISH: Moving sLMS does not move earned rewards. After `transfer(a, b, x)`, `earned(a)` and `earned(b)` are each exactly what they were immediately before (same block). A mint or burn is also reward-neutral for the other accounts.
SOLIDITY_SKETCH:
  // in stakedLms_transfer_clamped, after the transfer
  eq(stakedLms.earned(a), eA);    // eA, eB captured immediately before, same timestamp
  eq(stakedLms.earned(b), eB);
  // a third account c: eq(earned(c), eC)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: earned of sender, receiver and one bystander
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: StakedLms NatSpec: "settling happens in `_update`, before any balance moves, so a mint, burn or transfer can never carry rewards earned by someone else."
RATIONALE: `_update` settles both sides after `_accrue`. The `current == last` early return in `_settle`, and the `earned` view using `rewardPerShare()` rather than the stored value, are the places a mismatch of one rounding unit could appear.
```

```
PROPERTY_ID: RT-09
TYPE: SPECIFIC
ENGLISH: harvest splits exactly and keeps nothing. After `harvest`, `feeRouter.balance == 0`. `toStakers == floor(amount*stakerBps/10000)`. The vault's ETH rises by exactly `toStakers`, the treasury's by exactly `toTreasury = amount - toStakers`, and `amount` equals what was pulled from the escrow plus anything force-fed in. The stakers' side is rounded down, the treasury gets the remainder.
SOLIDITY_SKETCH:
  // in feeRouter_harvest_clamped
  uint256 wd = escrow.withdrawable(address(feeRouter)); uint256 pre = address(feeRouter).balance;
  uint256 vaultEth = address(stakedLms).balance; address t = feeRouter.treasury(); uint256 tEth = t.balance;  // t must not be the vault/escrow/router
  uint256 amt = feeRouter.harvest();
  eq(amt, wd + pre);
  uint256 toStakers = (amt * feeRouter.stakerBps()) / 10000;     // stakerBps as it was before the call
  eq(address(stakedLms).balance - vaultEth, toStakers);
  eq(t.balance - tEth, amt - toStakers);
  eq(address(feeRouter).balance, 0);
  lte(toStakers * 10000, amt * stakerBpsBefore);                 // floor, never favors stakers
GHOST_NEEDS: none
SNAPSHOT_NEEDS: feeRouter ETH balance, withdrawable[feeRouter] in the escrow, vault ETH balance, treasury ETH balance, stakerBps
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: FeeRouter NatSpec: "Holds no ETH between transactions... `harvest` splits whatever balance it finds, so nothing that arrived another way can stay"; `toTreasury = amount - toStakers` is an exact identity.
RATIONALE: `feeRouter_donateETH` forces ETH in, so this checks the "splits the whole balance" claim under forced ETH, and that the floor and remainder never lose or create a wei. Assert on the vault and treasury balance, not an actor's.
```

```
PROPERTY_ID: RT-10
TYPE: SPECIFIC
ENGLISH: A distributor claim moves exactly what it grants. The LMS sent to `vesting` equals the sum of the new tranche amounts equals the rise in `vesting.totalGranted`. The returned `reward` equals the sum of the per-epoch `trancheOf(...).amount`, and no epoch is granted twice.
SOLIDITY_SKETCH:
  // in rewards_claim_clamped, success branch
  // pre: vBal = lms.balanceOf(address(vesting)); tg = vesting.totalGranted(); per-epoch amounts a_e = vesting.trancheOf(player,e).amount (expect 0)
  uint256 reward = rewards.claim(player, epochs);
  eq(lms.balanceOf(address(vesting)) - vBal, reward);
  eq(vesting.totalGranted() - tg, reward);
  uint256 s; for e in epochs: s += vesting.trancheOf(player,e).amount;
  eq(s, reward);
GHOST_NEEDS: none
SNAPSHOT_NEEDS: LMS balance of vesting, totalGranted, tranche amounts for the claimed epochs
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: RewardsDistributor.claim: `reward += amounts[i]` then `safeTransfer(vesting, reward)` then `grant(player, epochs, amounts)`; RewardVesting NatSpec "The distributor has already sent the LMS". It is an identity of the code path.
RATIONALE: `grant` skips zero amounts and the `claim` loop `continue`s on `paid == 0` without setting the claimed bit. If an epoch rounds to a zero reward, its bit is set and the epoch is forfeited; this checks the sums still balance in that case.
```

```
PROPERTY_ID: RT-11
TYPE: SPECIFIC
ENGLISH: Releasing in pieces equals releasing at once, and releasing never exceeds what has vested. After `release(player, epochs)`, for each epoch `released == vested(player, epoch)` (nothing withheld, nothing extra), `releasable == 0`, and an immediate second release of the same epochs reverts with `NothingToRelease`. Listing the same epoch twice in one call pays it once.
SOLIDITY_SKETCH:
  // vesting_release_clamped: epochs may contain duplicates
  // pre: lmsBefore = lms.balanceOf(player); sum of releasable over the DISTINCT epochs = expected
  uint256 paid = vesting.release(player, epochs);
  eq(paid, expected);                                  // duplicates do not double-pay
  eq(lms.balanceOf(player) - lmsBefore, paid);
  for each e: eq(vesting.trancheOf(player,e).released, vesting.vested(player,e)); eq(vesting.releasable(player,e), 0);
  try vesting.release(player, epochs) { t(false, "second release at same timestamp must revert"); } catch {}
GHOST_NEEDS: none
SNAPSHOT_NEEDS: LMS balance of player, tranche.released per epoch
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: RewardVesting NatSpec: a tranche "vests linearly"; `release` pays `vested - released` per epoch, an exact identity.
RATIONALE: The C2 form for vesting: repeated release cycles cannot extract more than `vested`, because each step is `vested - released`. The duplicate-epoch input is the one place the loop could double-pay if `released` were updated after the sum.
```

```
PROPERTY_ID: RT-12
TYPE: SPECIFIC
ENGLISH: ZapJoin pays the escrow exactly the stake and the player pays at least the pool's rounded-up price. After `joinWithToken`, `Δ escrow.totalEscrowed == stake`, ZapJoin holds 0 ETH and 0 tokens, the player's input-token delta equals the returned `amountIn`, and `amountIn <= maxAmountIn`. A budget one wei under the cost never succeeds (the rounding boundary).
SOLIDITY_SKETCH:
  // in zap_joinWithToken_clamped (tightBudget true must revert: the success branch asserts false)
  // route 0 (single hop): cost = ceil(stake * ZAP_TOKEN_PER_ETH / 1e18)
  uint256 spent = zap.joinWithToken(matchId, path, budget, deadline);
  eq(escrow.totalEscrowed() - escBefore, stake);
  eq(address(zap).balance, 0);
  eq(tokBefore - IERC20(path[0].intermediateCurrency).balanceOf(actor), spent);
  lte(spent, budget);
  if (route == 0) eq(spent, cost);        // exact: ceil, never one wei short
  if (tightBudget) t(false, "joined with budget < cost");   // reached only on success
GHOST_NEEDS: none
SNAPSHOT_NEEDS: totalEscrowed, input-token balance of actor, zap ETH balance
PRIORITY: MEDIUM
GUARANTEE: EXPLORATORY
EVIDENCE: none — the ceil rounding is the `MockPoolManager` convention ("Rounded up, in the pool's favour"), not a promise of ZapJoin. The bound `amountIn <= maxAmountIn` and the exact stake are in ZapJoin NatSpec ("bounded by `maxAmountIn`", "exactly the lobby's stake") and would be SHOULD-HOLD on their own.
RATIONALE: Exact-output swaps are where rounding hides (the cost is rounded up per hop). A two-hop route compounds two ceilings. Do not assert equality on route 2 unless both pool rates are read from `Base`; use `spent >= composite lower bound`.
```

```
PROPERTY_ID: RT-13
TYPE: SPECIFIC
ENGLISH: Zero-input safety. Zero-amount entry points either revert or change nothing. They never mint, credit or burn: `stakedLms.deposit(0)`, `requestUnstake(0)`, `joinWithLms(id, 0)`, `claimRewards` with nothing earned, `vesting.release` and `rewards.claim` with nothing due, `harvest` with a zero balance.
SOLIDITY_SKETCH:
  // dedicated handlers with the zero input, each try/catch:
  try stakedLms.deposit(0) { t(false, "deposit(0) must revert"); } catch {}
  try stakedLms.requestUnstake(0) { t(false, "requestUnstake(0) must revert"); } catch {}
  try escrow.joinWithLms{value: stake}(id, 0) { t(false, "joinWithLms with 0 LMS must revert"); } catch {}
  // on success of any: assert sLMS supply, totalUnstaking, totalOwed, totalEscrowed unchanged
GHOST_NEEDS: none
SNAPSHOT_NEEDS: totalSupply, totalUnstaking, totalOwed, totalEscrowed
PRIORITY: LOW
GUARANTEE: EXPLORATORY
EVIDENCE: none — inferred. The source has explicit `ZeroAmount`, `NoDiscount` and `NothingToWithdraw` reverts, but no doc promises them.
RATIONALE: Pattern F. It also covers the `joinWithLms` dust case: a `lmsIn` so small that `floor(lmsIn*1e18/rate) == 0` (large `lmsPerEthDiscount`, up to 1e30) must revert `NoDiscount` instead of taking LMS for no discount. The handler `escrow_joinWithLms_smallLms_clamped` already drives that.
```

---

## Rounding properties

```
PROPERTY_ID: RD-01
TYPE: SPECIFIC
ENGLISH: The LMS discount never exceeds the allowed share of the fee, whatever the rate. After `joinWithLms`, `seatDiscount.eth <= floor(floor(stake*feeBps/10000) * 5000 / 10000)`, the seat's ETH due is `stake - discount`, and the stake is never below `stake - maxDiscount`.
SOLIDITY_SKETCH:
  // in escrow_joinWithLms_clamped, success branch; terms = escrow.getMatchTerms(id)
  uint256 fee = (uint256(info.stake) * terms.feeBps) / 10000;
  Discount memory d = escrow.getSeatDiscount(id, actor);
  lte(d.eth, (fee * 5000) / 10000);
  lte(d.eth, fee / 2);                                   // equivalent form
  eq(escrow.totalEscrowed() - escBefore, info.stake - d.eth);
GHOST_NEEDS: none
SNAPSHOT_NEEDS: totalEscrowed
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: GameEscrow NatSpec on `joinWithLms`: "never more than buys `MAX_DISCOUNT_BPS` of the fee"; Constants: `MAX_DISCOUNT_BPS = 5_000`, "Most of a seat's fee that LMS may pay".
RATIONALE: `_distribute` computes `remainder = pool - paid - discountEth`. If the discount could exceed the treasury's cut this underflows and finalize reverts, trapping the match (a stuck-funds failure). The safe margin rests on `n*floor(fee_stake/2) <= floor(n*fee_stake)`, which is worth fuzzing at stake 1 wei, fee 0 and 10%, and rate 0, 1 and 1e30.
```

```
PROPERTY_ID: RD-02
TYPE: SPECIFIC
ENGLISH: (a) The quote is what happens. The `(discount, lmsUsed)` from `quoteLmsDiscount(id, lmsIn)` immediately before `joinWithLms` equals the stored `seatDiscount` and the LMS actually pulled. (b) The rounding favors the protocol. The discount is worth no more than the LMS paid: `discount * rate <= lmsUsed * 1e18`, and `lmsUsed <= lmsIn`. In the capped branch `lmsUsed` is the smallest amount that pays for the cap, so `(lmsUsed - 1) * 1e18 < discount * rate`.
SOLIDITY_SKETCH:
  // in escrow_joinWithLms_clamped: call the view first, same block, same config
  (uint256 qd, uint256 qUsed) = escrow.quoteLmsDiscount(id, lmsIn); uint256 rate = config.lmsPerEthDiscount();
  uint256 lmsBefore = lms.balanceOf(actor);
  /* join */
  Discount memory d = escrow.getSeatDiscount(id, actor);
  eq(d.eth, qd); eq(d.lms, qUsed);                       // (a) SHOULD-HOLD
  eq(lmsBefore - lms.balanceOf(actor), qUsed);
  lte(qUsed, lmsIn);
  lte(qd * rate, qUsed * 1e18);                          // (b) EXPLORATORY: no free discount
  if (qUsed > 0 && qd == maxDiscountOf(id)) gt(qUsed * 1e18, ... ) // minimality: (qUsed - 1) * 1e18 < qd * rate, capped branch only
GHOST_NEEDS: none
SNAPSHOT_NEEDS: lms.balanceOf(actor)
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD for (a); EXPLORATORY for (b)
EVIDENCE: (a) GameEscrow NatSpec on `quoteLmsDiscount`: "What `lmsIn` LMS takes off a seat's fee in `matchId` now, and how much of it would be used"; `joinWithLms`: "Send the stake less the discount, which `quoteLmsDiscount` gives". (b) none — inferred. The uncapped branch floors the discount and charges all of `lmsIn`, so the user overpays by up to one rate unit. The capped branch ceils `lmsUsed`. The context calls this "floor one way and ceil the other".
RATIONALE: The pairing of floor and ceil is the only directional rounding in the discount. A flip (discount rounded up, or LMS rounded down) would hand out ETH discount for free LMS. The rate-1 and rate-1e30 boundaries are the extremes where `ceil(max*rate/1e18)` collapses toward 1 or the discount floors to 0.
```

```
PROPERTY_ID: RD-03
TYPE: GLOBAL
ENGLISH: The discount quote is monotone and zero-safe. More LMS in never gives a smaller discount or smaller `lmsUsed`, `quote(…, 0)` is `(0, 0)`, and the discount never exceeds the cap whatever `lmsIn` is. It does not revert for any reachable open match.
SOLIDITY_SKETCH:
  function property_quoteLmsDiscount_monotone() public returns (bool) {
      if (matchIds.length == 0) return true;
      bytes32 id = matchIds[matchIds.length - 1];
      try escrow.quoteLmsDiscount(id, 0) returns (uint256 d0, uint256 u0) { if (d0 != 0 || u0 != 0) return false; } catch { return false; }
      uint256[4] memory xs = [uint256(1), 1e12, 1e18, 1e26];
      uint256 pd; uint256 pu;
      for (uint256 i; i < 4; ++i) {
          try escrow.quoteLmsDiscount(id, xs[i]) returns (uint256 d, uint256 u) {
              if (d < pd || u < pu || u > xs[i]) return false; pd = d; pu = u;
          } catch { return false; }
      }
      return true;
  }
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: EXPLORATORY
EVIDENCE: none — inferred (Pattern G).
RATIONALE: Monotonicity fails at the join between the uncapped branch (`discount = floor(lmsIn*1e18/rate)`, `lmsUsed = lmsIn`) and the capped one (`lmsUsed = ceil(max*rate/1e18)`). `lmsUsed` can be lower in the capped branch than the uncapped branch charged just below the cap, which would let a user pay less by asking for more.
```

```
PROPERTY_ID: RD-04
TYPE: SPECIFIC
ENGLISH: A settlement assigns the whole pool, rounding in the protocol's favor. Every ranked payout is exactly `floor(distributable * payoutBps[i] / 10000)` (never above it). The treasury gets `pool - paid - discountEth`, which is at least `floor(pool*feeBps/10000) - discountEth`. The total credited equals `pool - discountEth` and equals the fall in `totalEscrowed`, so no wei is stranded or invented.
SOLIDITY_SKETCH:
  // in escrow_finalize_clamped, success branch; distinct ranked players that are not the treasury
  // pre: owed0 = totalOwed; esc0 = totalEscrowed; w0[p] for ranking and treasury
  uint256 pool = uint256(info.stake) * info.seatCount; Discount memory dsc = matchDiscount(id) /* sum of seat discounts */;
  uint256 dist = pool - (pool * terms.feeBps) / 10000;
  eq(escrow.totalOwed() - owed0, pool - dsc.eth);
  eq(esc0 - escrow.totalEscrowed(), pool - dsc.eth);
  for (uint256 i; i < schedule.length; ++i) eq(escrow.withdrawable(ranking[i]) - w0[i], (dist * schedule[i]) / 10000);   // only if no address repeats and none is the treasury
  gte(escrow.withdrawable(terms.treasury) - wT0, (pool * terms.feeBps) / 10000 - dsc.eth);
GHOST_NEEDS: sum of seat discount ETH per match (`getSeatDiscount` over `getSeats` gives it without a ghost)
SNAPSHOT_NEEDS: totalOwed, totalEscrowed, withdrawable of ranking and treasury
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: GameEscrow NatSpec in `_distribute`: "The treasury takes the fee plus whatever integer division left behind, so the pool is always fully assigned and nothing can be stranded"; "Less the discounts, which never exceed half the fee."
RATIONALE: This is the core conversion (bps of the pool). The fee itself is floored (`_fee`), so the protocol's fee is under-rounded by up to 1 wei, but the dust the payouts floor away flows back to the treasury. Fuzz at stake 1 wei (a rank-3 prize of 0 is skipped), 2 to 8 seats, fee 0 and 10%, and with the treasury and a player being the same address (then only the aggregate equalities apply).
```

```
PROPERTY_ID: RD-05
TYPE: SPECIFIC
ENGLISH: Play-mining never counts more fees than the protocol actually received. For a matchmade match the epoch's `epochFees` rise is at most the treasury's actual cut, `pool - paid - discountEth`. Each seat's recorded fee is `floor(stake*feeBps/10000) - seatDiscount.eth`. For every epoch, the sum of `feesPaid` over the actors is at most `epochFees`.
SOLIDITY_SKETCH:
  // in escrow_finalize_clamped, success branch
  uint256 e = block.timestamp / escrow.FEE_EPOCH();
  uint256 dEpoch = escrow.epochFees(e) - epochBefore;
  if (info.matchmade) {
      lte(dEpoch, treasuryCut);     // treasuryCut = totalOwed delta - Σ ranked payouts, or recomputed as in RD-04
      eq(dEpoch, Σ over seats of (fs - getSeatDiscount(id,s).eth))   // fs = floor(stake*feeBps/10000); 0 if fs == 0
  } else eq(dEpoch, 0);
  // global (property_): for each e in feeEpochs: Σ_{a in actors} escrow.feesPaid(a,e) <= escrow.epochFees(e)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: epochFees(current epoch), per-seat feesPaid
PRIORITY: HIGH
GUARANTEE: EXPLORATORY
EVIDENCE: none — inferred. RewardsDistributor NatSpec ties rewards to "the fees themselves are real ETH that goes to stakers and the treasury", but nothing states that the recorded figure is bounded by the credited cut.
RATIONALE: The two fee figures are computed differently (per seat `floor(stake*bps/1e4)`, versus the treasury's `floor(pool*bps/1e4)` plus payout dust). The seat-wise figure is never larger, which is the safe direction; if it were, play-mining would pay out on fees nobody paid. A discount reduces the recorded fee by `seatDiscount.eth`; check that `fee - seat.eth` cannot underflow for any rate.
```

```
PROPERTY_ID: RD-06
TYPE: GLOBAL
ENGLISH: Reward-stream rounding never over-promises ETH. The vault's ETH balance covers every actor's `earned()` plus the not-yet-streamed remainder: `balance >= Σ_actors earned(a) + floor(rewardRate * (periodFinish - now) / 1e27)`, evaluated while the stream runs and supply is non-zero. (Donated ETH only adds to the left side.)
SOLIDITY_SKETCH:
  function property_stakedLms_rewardsCovered() public returns (bool) {
      uint256 owedSum;
      for (uint256 i; i < actors.length; ++i) { try stakedLms.earned(actors[i]) returns (uint256 e) { owedSum += e; } catch { return false; } }
      uint256 fin = stakedLms.periodFinish();
      uint256 unstreamed = (stakedLms.totalSupply() != 0 && block.timestamp < fin)
          ? ((fin - block.timestamp) * stakedLms.rewardRate()) / 1e27 : 0;
      // supply==0: skip the unstreamed term (the stream is paused and the view does not accrue)
      return address(stakedLms).balance >= owedSum + unstreamed;
  }
GHOST_NEEDS: none (a stricter version uses a ghost of ETH claimed out)
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: Closed-form identity: `rate = floor((v + unpaid)*1e27/duration)`, `unpaid` is floored, `Δrps = floor(Δt*rate/supply)` and `earned = floor(bal*Δrps/1e27)` all round down, so total promised <= total deposited. StakedLms NatSpec: depositing "can never take anything from stakers".
RATIONALE: Four stacked floors, restarts on every deposit, and a pause when supply is 0. Any direction slip makes stakers collectively owed more ETH than the contract holds, so the last claimer's `claimRewards` fails with `TransferFailed`. Subset of holders is fine: a partial sum is still <= the balance. Keep it cheap (8 actors).
```

```
PROPERTY_ID: RD-07
TYPE: SPECIFIC
ENGLISH: A deposit commits at most what funded it, and loses at most 1 wei doing so. After `depositRewards{value: v}`, with `unpaid` the old stream's unpaid ETH (`floor((periodFinish_old - now) * rewardRate_old / 1e27)` or 0), the new stream's total `floor(rewardRate*rewardDuration/1e27)` is in `[v + unpaid - 1, v + unpaid]`. Repeated zero-value restarts (`v = 0`, callable by anyone) lose at most 1 wei each.
SOLIDITY_SKETCH:
  // in stakedLms_depositRewards_clamped / _dust_clamped
  // pre: rate0 = rewardRate; fin0 = periodFinish; now_ = block.timestamp
  uint256 unpaid = now_ < fin0 ? ((fin0 - now_) * rate0) / 1e27 : 0;
  /* depositRewards{value: v}() */
  uint256 committed = (stakedLms.rewardRate() * stakedLms.rewardDuration()) / 1e27;
  lte(committed, v + unpaid);
  gte(committed + 1, v + unpaid);
  eq(stakedLms.periodFinish(), now_ + stakedLms.rewardDuration());
GHOST_NEEDS: none
SNAPSHOT_NEEDS: rewardRate, periodFinish, block.timestamp
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: StakedLms NatSpec: "each deposit, plus whatever of the last one is still unpaid, is spread over a fresh `rewardDuration`"; "someone depositing dust every block ... at their own gas."
RATIONALE: Pattern C2 for the stream. `_accrue()` runs first, so when the old stream had just ended or supply was 0 the `unpaid` term differs; mind the pause case (`periodFinish` was pushed by `now - last` inside `_accrue`), so read `periodFinish` after the accrual or skip the supply-0 case.
```

```
PROPERTY_ID: RD-08
TYPE: GLOBAL
ENGLISH: Accrual dust is bounded. Once the stream has ended and every sLMS holder is one of the actors, the ETH left in the vault after subtracting every actor's `earned()` and the forced-in ETH is at most a small bound. The bound is (number of accrue/settle/deposit events) wei plus the rounding of `rewardPerShare` (at most `totalSupply/1e27` wei per accrual).
SOLIDITY_SKETCH:
  function property_stakedLms_accrualDustBounded() public returns (bool) {
      if (block.timestamp < stakedLms.periodFinish() || stakedLms.lastAccrual() < stakedLms.periodFinish()) return true; // stream still running or not accrued to the end: skip
      if (!allSupplyHeldByActors()) return true;
      uint256 owedSum; for (actors) owedSum += stakedLms.earned(actors[i]);
      uint256 accounted = owedSum + ghosts.ethClaimedOut;
      uint256 expected = ghosts.rewardsDeposited;                        // + ghosts.ethDonated tracked separately
      if (accounted > expected) return false;                             // over-pay (also RD-06)
      return expected - accounted <= ghosts.accrualOps * (1 + stakedLms.totalSupply() / 1e27 + 1);
  }
GHOST_NEEDS: rewardsDeposited (successful `depositRewards` values, including FeeRouter pushes), ethClaimedOut (claimRewards amounts), accrualOps (count of calls that run `_accrue`/`_settle`), ethDonated (so that forced ETH is excluded)
SNAPSHOT_NEEDS: none
PRIORITY: LOW
GUARANTEE: EXPLORATORY
EVIDENCE: none — inferred. NatSpec says the stream pauses "so ETH that arrives with no stakers waits for the first ones rather than being lost", and there is no ETH sweep in StakedLms, so lost dust is permanent.
RATIONALE: With a supply near 1e26 and a 1-wei deposit, `floor(dt*rate/supply)` is 0 for any short interval, yet `lastAccrual` still advances, so frequent accruals (any transfer or deposit) can burn the whole reward. This property tells a harmless dust loss from a real loss. It needs the ghosts above and a check that sLMS is held only by actors; if the harness funds other holders, restrict it to deposits attributed to actors.
```

```
PROPERTY_ID: RD-09
TYPE: GLOBAL
ENGLISH: The emission schedule rounds down and never exceeds the funded budget. `totalBudget() <= PLAY_MINING_SHARE`. `epochBudget(e)` is non-increasing in `e`, is 0 outside `[firstEpoch, firstEpoch + 208)`, and in year y satisfies `epochBudget * 4^y <= firstYearEpochBudget * 3^y`. Total granted never exceeds `totalBudget()`.
SOLIDITY_SKETCH:
  function property_rewards_scheduleWithinBudget() public returns (bool) {
      uint256 fe = rewards.firstEpoch();
      if (rewards.totalBudget() > PLAY_MINING_SHARE) return false;
      if (vesting.totalGranted() > rewards.totalBudget()) return false;
      uint256 prev = type(uint256).max;
      for (uint256 y; y < 4; ++y) {                          // sample, do not loop 208 epochs
          uint256 b = rewards.epochBudget(fe + y * 52);
          if (b > prev) return false; prev = b;
          if (b * 4 ** y > rewards.firstYearEpochBudget() * 3 ** y) return false;
      }
      return rewards.epochBudget(fe + 208) == 0 && (fe == 0 || rewards.epochBudget(fe - 1) == 0);
  }
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: RewardsDistributor constructor NatSpec: "LMS the program pays out at most, in wei. The contract must hold this much" and "the four years together add up to `totalBudget`"; the sum bound is the closed form `52*first*(1 + 3/4 + 9/16 + 27/64) = 52*first*175/64 <= totalBudget_`.
RATIONALE: Two floors stack (`firstYearEpochBudget` and the per-year `3^y/4^y`). They only ever round down, which is the safe side, but a mistake in either breaks the "at most" promise. `vesting.totalGranted() <= totalBudget()` is the cross-contract end of the same bound. The harness starts before `firstEpoch` (epochs before it have zero budget), so keep the `fe - 1` check.
```

```
PROPERTY_ID: RD-10
TYPE: GLOBAL
ENGLISH: Claims in one epoch never add up to more than its budget. For every recorded fee epoch `e`: `Σ_{a in actors} trancheOf(a,e).amount <= epochBudget(e)`, and for a fixed rate `rate * epochFees(e) <= epochBudget(e) * 1e18`. Each tranche is also at most the wallet cap fixed at the first claim.
SOLIDITY_SKETCH:
  function property_rewards_epochClaimsWithinBudget() public returns (bool) {
      for (uint256 i; i < feeEpochs.length; ++i) {
          uint256 e = feeEpochs[i]; uint256 s;
          (uint256 rate, uint256 cap, bool fixed_) = rewards.rateOf(e);
          for (uint256 j; j < actors.length; ++j) { (uint128 amt,) = vesting.trancheOf(actors[j], e); s += amt; if (amt > cap && fixed_) return false; }
          if (s > rewards.epochBudget(e)) return false;
          if (fixed_ && rate * escrow.epochFees(e) > rewards.epochBudget(e) * 1e18) return false;   // only when the cap was not what bound the rate
      }
      return true;
  }
GHOST_NEEDS: none (`feeEpochs` registry already exists)
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: RewardsDistributor NatSpec: "Each claim is a share of the epoch's fees times a rate of at most budget / fees, so the claims of an epoch add up to at most its budget."
RATIONALE: `rate = min(floor(budget*1e18/fees), maxRewardPerEth)` and `reward = min(floor(paid*rate/1e18), walletCap)`; summing floors over players is at most the budget only because `Σ paid <= epochFees`. That relation breaks if a player's `feesPaid` ever exceeds what `epochFees` includes (see RD-05), or if a rate fixed at the first claim is later changed. The `rateOf` fixity case matters most: a cap change after the first claim must not change an already-fixed epoch.
```

```
PROPERTY_ID: RD-11
TYPE: SPECIFIC
ENGLISH: A single claim rounds against the claimant. For each claimed epoch with `paid = feesPaid(player,e)`: `tranche.amount * 1e18 <= paid * rate` (floor, never above), `tranche.amount <= walletCap`, and `tranche.amount == min(floor(paid*rate/1e18), walletCap)` exactly. The rate and cap used are the epoch's fixed values, the same for every later claimant.
SOLIDITY_SKETCH:
  // in rewards_claim_clamped, success branch; pre-capture (rate, cap, ) = rewards.rateOf(e) BEFORE the call if not yet fixed,
  // and compare with the rate fixed by the call
  (uint256 rate1, uint256 cap1, bool fx) = rewards.rateOf(e);   // after: fx == true
  t(fx, "rate not fixed after claim");
  uint256 paid = escrow.feesPaid(player, e);
  (uint128 amt,) = vesting.trancheOf(player, e);
  eq(uint256(amt), _min((paid * rate1) / 1e18, cap1));
  lte(uint256(amt) * 1e18, paid * rate1);
  if (rateBefore.fixed_) { eq(rate1, rateBefore.value); eq(cap1, rateBefore.cap); }   // fixity
GHOST_NEEDS: none
SNAPSHOT_NEEDS: rateOf(e) before and after
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: RewardsDistributor NatSpec: "The rate and the wallet cap are fixed by the first claim, so a later change to a cap cannot treat two claimants of one epoch differently."
RATIONALE: The same player claiming in one batch or many must get the same reward, and the order of claimants must not matter. The `uint120(rate)` and `uint128(walletCap)` narrowing is safe only because the setters bound both, so also run it after `rewards_secondary` moves the caps to their maxima.
```

```
PROPERTY_ID: RD-12
TYPE: GLOBAL
ENGLISH: Vesting rounds down and completes exactly. For every actor and recorded epoch: `released <= vested <= amount`, and once `block.timestamp >= vestingStart(e) + 26 weeks`, `vested == amount` exactly (no dust left unreleasable). Globally `totalReleased <= totalGranted`.
SOLIDITY_SKETCH:
  function property_vesting_roundsDownAndCompletes() public returns (bool) {
      if (vesting.totalReleased() > vesting.totalGranted()) return false;
      for (uint256 i; i < feeEpochs.length; ++i) for (uint256 j; j < actors.length; ++j) {
          (uint128 amt, uint128 rel) = vesting.trancheOf(actors[j], feeEpochs[i]);
          uint256 v = vesting.vested(actors[j], feeEpochs[i]);
          if (rel > v || v > amt) return false;
          if (block.timestamp >= vesting.vestingStart(feeEpochs[i]) + vesting.VESTING_DURATION() && v != amt) return false;
      }
      return true;
  }
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: RewardVesting NatSpec: "A tranche vests linearly over `VESTING_DURATION`, starting the moment its epoch ended", and the code `if (elapsed >= VESTING_DURATION) return amount`.
RATIONALE: `(amount * elapsed) / VESTING_DURATION` floors, so partial vesting can only be below the linear value; the property pins the completion step. Medusa moves time up to 12 hours per call, so full vesting (182 days) is reachable only over many calls; the property is still valid and costs a double loop over small registries.
```

```
PROPERTY_ID: RD-13
TYPE: SPECIFIC
ENGLISH: The dust floor on gasless withdrawals is exact. `withdrawFor(account)` succeeds only when the balance is zero (then `NothingToWithdraw`) or at least `MIN_WITHDRAW_FOR` (0.0001 ether); a balance in `[1, MIN_WITHDRAW_FOR - 1]` always reverts `BelowMinimumWithdrawal`, and `withdraw(to)` still pays it in full (RT-03), so no balance is stuck.
SOLIDITY_SKETCH:
  // escrow_withdrawFor_clamped: account == msg.sender (the actor)
  uint256 w = escrow.withdrawable(actor);
  try escrow.withdrawFor(actor) returns (uint256 amt) { gte(amt, escrow.MIN_WITHDRAW_FOR()); eq(amt, w); }
  catch { /* must be a revert only if w == 0 or w < MIN */ t(w == 0 || w < escrow.MIN_WITHDRAW_FOR(), "withdrawFor reverted on a payable balance"); }
  // follow-up: a dust balance is still withdrawable via withdraw(to) -> amt == w
GHOST_NEEDS: none
SNAPSHOT_NEEDS: withdrawable[actor]
PRIORITY: LOW
GUARANTEE: SHOULD-HOLD
EVIDENCE: PullPayable NatSpec: "`withdraw` has no minimum, so no balance is stuck", and the `MIN_WITHDRAW_FOR` comment on the dust floor.
RATIONALE: This is the boundary of a unit conversion (wei to "worth the relay gas"). Remainder dust from RD-04 (a 1-wei treasury cut) lands in this window, so it also checks that dust stays reachable.
```

```
PROPERTY_ID: RD-14
TYPE: GLOBAL
ENGLISH: The governor quorum never falls below the fixed floor and never rounds below the fraction. `quorum(t) >= quorumFloor(t)` and `quorum(t) >= floor(pastTotalSupply(t) * percent / 100)` for any past timepoint, with `quorumFloor <= floor(lms.totalSupply() * 10 / 100)`.
SOLIDITY_SKETCH:
  function property_governor_quorumNotBelowFloor() public returns (bool) {
      if (block.timestamp < 2) return true;
      uint256 t = block.timestamp - 1;     // a past timepoint
      try governor.quorum(t) returns (uint256 q) {
          if (q < governor.quorumFloor(t)) return false;
          if (q < (stakedLms.getPastTotalSupply(t) * governor.quorumNumerator(t)) / governor.quorumDenominator()) return false;
      } catch { return false; }
      return governor.quorumFloor() <= (lms.totalSupply() * 10) / 100;
  }
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: LOW
GUARANTEE: EXPLORATORY
EVIDENCE: none — inferred. LmsGovernor NatSpec says `quorum` is "the larger of that fraction and `quorumFloor`", which supports the max, but the percent-of-supply rounding direction is the OpenZeppelin default and unpromised. The 10% ceiling is documented in `maxQuorumFloor`'s NatSpec ("10% of the LMS supply").
RATIONALE: A single `max` of two floored values. Low value, low cost. The `getPastTotalSupply` call needs `t` strictly before `clock()`, so guard the timepoint, as above.
```

---

Number of properties proposed: 27 (RT-01 to RT-13, RD-01 to RD-14).

Not proposed, by design: no ERC-4626 preview or convert pairs exist, so Patterns D, E and E2 appear only in their adapted form (RD-02 quote against actual, RD-03 monotonicity). The `previewWithdraw >= previewDeposit` check is not applicable. No `SessionKeyDelegate`, `MultisigPhase`, `LmsToken` or `ChainlinkVrfAdapter` pair involves a rounding or round-trip surface.
