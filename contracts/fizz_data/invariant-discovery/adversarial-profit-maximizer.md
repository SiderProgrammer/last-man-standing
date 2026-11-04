# Adversarial Profit Maximizer: proposed properties (Last Man Standing)

Source of truth: `src/` (x-ray ignored where stale). Harness facts honoured: no `vm.warp` persistence, never assert on an actor's ETH around a payable call (assert on escrow-side state, or on ETH an actor RECEIVES), forced ETH/LMS means `>=`, trusted roles are pranked as the timelock so config may change under a live match, "must fail" handlers need try/catch with the assertion in the success branch.

Notation: `E` = `escrow`, `S` = `stakedLms`, `R` = `rewards`, `V` = `vesting`, `B` = `bridgeReceiver`. "Handler-level" = SPECIFIC property called from the named handler's success/failure branch. "Probe" = a new clamped handler that attempts the attack and asserts.

Source observations that motivated several properties (leads, not confirmed bugs):
- `finalize` reads `config.sequencerUptimeFeed()` live (not snapshotted in Terms). A Proposed match has no cancel path, so a feed that reverts or reports down strands every Proposed match until it recovers or config is fixed (ADV-02, ADV-30).
- `FeeRouter.harvest` is atomic with the treasury push: a treasury that rejects ETH also blocks the stakers' share (ADV-10).
- `settle` has no `block.timestamp < info.deadline` check, while `cancelMatch` opens at that same deadline: a seated loser can race a signed result (ADV-29).
- `dismissDispute` after the original deadline sets `deadline = now`, which closes veto and further disputes at once (ADV-06).
- `RewardsDistributor.claim` marks an epoch claimed when `paid != 0` even if `_reward` rounds to 0, and anyone may claim for anyone (ADV-16).
- `MultisigPhase._checkCall` inspects only the first-level target and selector. A nested route (for example `Governor.relay` into the timelock, which the governor may propose through) would bypass it; OZ `onlyGovernance` should block a direct `relay` by the timelock, which ADV-28 tests.

---

## A. Liveness / DoS

```
PROPERTY_ID: [ADV-01]
TYPE: SPECIFIC (escrow_withdraw_clamped, escrow_withdrawFor_clamped, called with every actor in turn)
ENGLISH: An attacker cannot make any account's escrow balance unwithdrawable. For every actor with withdrawable > 0 that can accept ETH, withdraw(self) succeeds for any amount, including dust below MIN_WITHDRAW_FOR, while paused, and after any mix of refunds, settlements, bridge refunds and forced ETH. It pays exactly the credited amount.
SOLIDITY_SKETCH:
  w = E.withdrawable(a); if (w == 0) return;
  balBefore = a.balance; owedBefore = E.totalOwed();
  vm.prank(a); try E.withdraw(a) returns (uint256 amt) {
      eq(amt, w); eq(E.withdrawable(a), 0); eq(E.totalOwed(), owedBefore - w);
      eq(a.balance - balBefore, w);            // receiving ETH is safe to assert
  } catch { t(false, "withdraw reverted with balance"); }
  // withdrawFor: only when w >= MIN_WITHDRAW_FOR (below it must revert BelowMinimumWithdrawal)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: totalOwed, withdrawable[a], a.balance before/after
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: PullPayable NatSpec: "`withdraw` has no minimum, so no balance is stuck"; GameEscrow NatSpec: "a pause must never trap player funds".
RATIONALE: Detects a griefing path (dust, rejecting recipient, pause, accounting drift) that bricks pull payouts.
```

```
PROPERTY_ID: [ADV-02]
TYPE: SPECIFIC (probe `adversary_exitEveryMatch`, plus the cancel/finalize handlers)
ENGLISH: An attacker cannot strand a match. Every match not in a terminal state has a permissionless way out once its documented time condition holds: Open past cancellableAt, Pending or Live past deadline -> cancelMatch; Proposed past deadline with the right ranking and a healthy sequencer -> finalize. None of these reverts, including at boundary lobbies (stake 1 wei with minStake moved to 1, seats 2, fee 0 or 10%, discount rate 1 or 1e30, LMS-discounted seats, rejecting-recipient seats, matchmade lobbies).
SOLIDITY_SKETCH:
  for id in matchIds: info = E.getMatch(id);
    if (info.status==Open && ts >= info.joinDeadline + (info.seatCount >= terms.minSeats ? LOCK_GRACE : 0))
         expectNoRevert(E.cancelMatch(id));
    if ((info.status==Pending||info.status==Live) && ts >= info.deadline) expectNoRevert(E.cancelMatch(id));
    if (info.status==Proposed && ts >= info.deadline && sequencerHealthy() && hash(proposedRanking[id])==info.rankingHash)
         expectNoRevert(E.finalize(id, proposedRanking[id]));
  // expectNoRevert = try/catch -> t(false) in catch; afterwards status in {Cancelled, Settled}
  // and totalEscrowed decreased by stake*seatCount - discount.eth
GHOST_NEEDS: none (uses proposedRanking registry)
SNAPSHOT_NEEDS: totalEscrowed, totalOwed, totalLmsEscrowed before the exit
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: cancelMatch NatSpec "Permissionless once the relevant deadline has passed, so players are never dependent on the operator to recover their stake"; finalize NatSpec "anyone may finalize" after the window.
RATIONALE: Arithmetic underflow (`totalEscrowed -=`, `remainder = pool - paid - discountEth`), a payout loop indexing past the ranking, an LMS burn or refund failure, or a bad config read would freeze stakes permanently. Reachable by fee, minSeats, minStake and discount-rate boundaries.
```

```
PROPERTY_ID: [ADV-03]
TYPE: SPECIFIC (cancelMatch, finalize, veto, dispute, dismissDispute, withdraw, abortMatch handlers)
ENGLISH: A pause never blocks the fund-return paths. While paused(), withdraw, cancelMatch (when eligible), finalize (when eligible), veto, dispute and dismissDispute are never rejected with EnforcedPause. Conversely createMatch, createMatchmade, join, joinWithLms, joinFor, lockMatch and settle are rejected while paused.
SOLIDITY_SKETCH:
  bool wasPaused = E.paused();
  try handlerCall() {} catch (bytes memory r) {
      if (wasPaused && selector(r) == ExpiringPause.EnforcedPause.selector && pathIsNeverPaused) t(false);
  }
  // reverse direction: if wasPaused and call is in the gated set, success => t(false)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: paused flag
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: GameEscrow `_isGuardian` NatSpec: "`finalize`, `veto`, `cancelMatch` and withdrawals are never paused"; dispute NatSpec "Never paused".
RATIONALE: A compromised guardian or governance pause must not trap funds or freeze a surviving result.
```

```
PROPERTY_ID: [ADV-04]
TYPE: SPECIFIC (bridge_fillJoin_clamped, bridge_fillAnyMatch_clamped)
ENGLISH: A bridged stake cannot be lost or bricked. For any matchId (unknown, full, closed, paused, matchmade-unrostered, already seated), any player != 0 and any msg.value, bridgeJoin by the receiver never reverts, and the whole value ends up either as a seat (stake escrowed, extra credited) or credited to the player. No value is created or kept by the escrow outside totalEscrowed + totalOwed.
SOLIDITY_SKETCH:
  eBal=address(E).balance; esc=E.totalEscrowed(); owed=E.totalOwed(); w=E.withdrawable(p);
  vm.prank(B); try E.bridgeJoin{value:v}(id,p,origin) {} catch { t(false); }
  eq(address(E).balance - eBal, v);
  eq((E.totalEscrowed()-esc) + (E.totalOwed()-owed), v);
  if (!E.hasSeat(id,p) before) and failure: eq(E.withdrawable(p)-w, v);
  if seated now: gte(E.totalEscrowed()-esc, info.stake) and E.withdrawable(p)-w == v - stake
GHOST_NEEDS: none
SNAPSHOT_NEEDS: balance, totalEscrowed, totalOwed, withdrawable[p]
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: bridgeJoin NatSpec: "for any player but zero it then never reverts... all of it is credited to the player here instead".
RATIONALE: A revert here reverts the relayer fill and leaves the deposit unfilled; a silent mis-credit lets an attacker bridge once and be paid twice.
```

```
PROPERTY_ID: [ADV-05]
TYPE: SPECIFIC (bridge_fill, bridge_fillUnroutable_clamped, bridge_handleV3AcrossMessage)
ENGLISH: Once the caller is the SpokePool, handleV3AcrossMessage never reverts, whatever the token, amount (including more than the receiver holds) or message bytes (empty, short, dirty address bits, huge). Anything it cannot route stays in B and is announced with Unroutable; nothing is lost.
SOLIDITY_SKETCH:
  ethBefore = address(B).balance; wethBefore = weth.balanceOf(B);
  vm.prank(acrossPool); try B.handleV3AcrossMessage(token, amt, address(0), msg_) {} catch { t(false); }
  // value either reached E (E.balance + B.balance conserved) or is still in B
  eq(address(E).balance + address(B).balance + weth.balanceOf(B) >= totalBefore)  // nothing vanished
GHOST_NEEDS: totalBefore snapshot only
SNAPSHOT_NEEDS: B ETH and WETH balances, E balance
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: BridgeJoinReceiver NatSpec: "once the caller is known to be the SpokePool, the handler never reverts".
RATIONALE: A malformed message from anyone (bridges are permissionless) would otherwise block a relayer fill.
```

```
PROPERTY_ID: [ADV-06]
TYPE: GLOBAL
ENGLISH: Seated players cannot delay a result by more than one DISPUTE_EXTENSION in total. For every Proposed match, info.deadline <= proposedDeadline + DISPUTE_EXTENSION, however many disputes and dismissals happen. A dispute by an unseated address or a second dispute by the same seat never succeeds.
SOLIDITY_SKETCH:
  // ghost proposedDeadline[id] set in escrow_settle_* from the ResultProposed deadline
  for id in matchIds: info = E.getMatch(id);
    if (info.status == Proposed) lte(info.deadline, ghosts.proposedDeadline[id] + DISPUTE_EXTENSION);
  // handler-level in escrow_dispute_clamped: unseated or repeat caller must revert (success => t(false))
GHOST_NEEDS: proposedDeadline[matchId]; disputeCount[matchId][seat]
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: dispute NatSpec: "Any seated player, once each... one already open does not extend it again"; dismissDispute NatSpec: "the result goes back to its own challenge deadline".
RATIONALE: A cumulative-bypass (I-d) check: a loser could chain dispute/dismiss cycles to hold winners' payouts indefinitely.
```

```
PROPERTY_ID: [ADV-07]
TYPE: SPECIFIC (vrf handlers)
ENGLISH: The VRF callback cannot be bricked or hijacked. rawFulfillRandomWords from the coordinator never reverts (unknown id, repeat, empty words, consumer revert). A failed delivery keeps the word, and deliver() later delivers the same word for the same request only once. A non-coordinator caller always reverts, and a non-consumer cannot request randomness.
SOLIDITY_SKETCH:
  vm.prank(coordinator): try vrf.rawFulfillRandomWords(id, words) {} catch { t(false); }
  vm.prank(outsider): try vrf.rawFulfillRandomWords(...) { t(false); } catch {}
  vm.prank(outsider): try vrf.requestRandomness(x) { t(false); } catch {}
  after delivery: try vrf.deliver(id) { t(false) } catch {}      // request deleted
  after delivery: match status Live and seed == keccak(abi.encode(word, matchId))
GHOST_NEEDS: delivered[vrfId]
SNAPSHOT_NEEDS: match status before/after
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: ChainlinkVrfAdapter NatSpec: "The coordinator's callback never reverts. VRF does not retry a failed fulfilment"; "only registered consumers... may make one".
RATIONALE: A reverting callback permanently loses a seed (match falls to RandomnessNotDelivered); an open requester drains the subscription.
```

```
PROPERTY_ID: [ADV-08]
TYPE: SPECIFIC (vesting release path)
ENGLISH: A vested tranche can always be released in full, by anyone, to the player only. After vestingStart + VESTING_DURATION, release(player,[epoch]) succeeds and pays exactly amount - released. Nothing is releasable before the epoch ends. Duplicate epochs in one call do not pay twice.
SOLIDITY_SKETCH:
  t0 = V.vestingStart(e); amt = V.trancheOf(p,e).amount; rel = V.trancheOf(p,e).released;
  if (amt != 0 && ts >= t0 + 26 weeks && rel < amt) {
      before = lms.balanceOf(p); vm.prank(anyActor);
      try V.release(p, [e, e]) returns (uint256 got) { eq(got, amt - rel); eq(lms.balanceOf(p)-before, got); } catch { t(false); }
  }
  if (ts <= t0) eq(V.releasable(p,e), 0)
  caller's own LMS balance unchanged when caller != p
GHOST_NEEDS: none
SNAPSHOT_NEEDS: LMS balances of p and caller
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: RewardVesting NatSpec: "vests linearly over VESTING_DURATION, starting the moment its epoch ended"; release "Open to anyone: the LMS only ever goes to player".
RATIONALE: Insolvency of the vesting contract or a third party redirecting a release would lock or steal play-mining rewards.
```

```
PROPERTY_ID: [ADV-09]
TYPE: SPECIFIC (stakedLms_claim_clamped, stakedLms_requestUnstake_*, stakedLms_unstakeEveryone_clamped)
ENGLISH: An attacker cannot trap staked LMS. requestUnstake of any amount <= balance succeeds, and claim after unlockAt pays exactly the queued amount 1:1 and never reverts, including when every staker has left (supply 0), after dust reward deposits, and after donations. Views rewardPerShare, earned, rewardRate maths never revert at supply 0.
SOLIDITY_SKETCH:
  u = S.unstakeOf(a); if (u.assets != 0 && ts >= u.unlockAt) {
      before = lms.balanceOf(r); vm.prank(a);
      try S.claim(r) returns (uint256 amt) { eq(amt,u.assets); eq(lms.balanceOf(r)-before, amt); } catch { t(false); }
  }
  property_stakedLms_views_dont_revert(): try S.rewardPerShare() ; for a in actors try S.earned(a) -> catch t(false)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: lms balances
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: StakedLms NatSpec: "one sLMS is always one LMS"; "`claim` returns the LMS once the cooldown has passed".
RATIONALE: Division by zero at supply 0, a uint128 narrowing on pending.assets, or a backing shortfall would lock stake.
```

```
PROPERTY_ID: [ADV-10]
TYPE: SPECIFIC (feeRouter_harvest_clamped)
ENGLISH: Fees credited to the router can always be harvested. If escrow.withdrawable(feeRouter) > 0 or the router holds ETH, harvest() succeeds for any caller, with zero stakers, with stakerBps 0 or 10000, and with forced ETH in the router.
SOLIDITY_SKETCH:
  pre = E.withdrawable(FR) + address(FR).balance; if (pre == 0) return;
  try FR.harvest() returns (uint256 amt) { gte(amt, pre); } catch { t(false, "fees stuck"); }
GHOST_NEEDS: none
SNAPSHOT_NEEDS: router and escrow balances
PRIORITY: HIGH
GUARANTEE: EXPLORATORY
EVIDENCE: none, inferred. Failure needs the owner to set a treasury that rejects ETH (timelock action), so it may be an accepted trust assumption.
RATIONALE: The treasury push is atomic with the staker deposit, so one rejecting treasury blocks both shares permanently until governance repairs it.
```

## B. Value extraction

```
PROPERTY_ID: [ADV-11]
TYPE: SPECIFIC (cancelMatch, abortMatch, veto, and an explicit join-then-cancel probe)
ENGLISH: A join followed by any cancellation is never profitable. Every seat is credited exactly stake - seatDiscount.eth, and gets back exactly seatDiscount.lms LMS. Sum of ETH credited equals the match's contribution to totalEscrowed, totalLmsEscrowed falls by exactly matchDiscount.lms, and no seat is refunded more than it paid.
SOLIDITY_SKETCH:
  for s in E.getSeats(id): w0[s]=E.withdrawable(s); l0[s]=lms.balanceOf(s);
  esc0=E.totalEscrowed(); lmsEsc0=E.totalLmsEscrowed();
  (do cancel/abort/veto)
  for s: d = E.getSeatDiscount(id,s);
      eq(E.withdrawable(s)-w0[s], info.stake - d.eth); eq(lms.balanceOf(s)-l0[s], d.lms);
  eq(esc0 - E.totalEscrowed(), stake*seatCount - sumDiscountEth); eq(lmsEsc0 - E.totalLmsEscrowed(), sumDiscountLms);
GHOST_NEEDS: per-seat paid ETH and LMS at join (cross-check against getSeatDiscount)
SNAPSHOT_NEEDS: withdrawable and LMS balance of each seat, totalEscrowed, totalLmsEscrowed
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: GameEscrow NatSpec: LMS "refunded with the stake when it is cancelled, vetoed or aborted"; `_refundAll` "credits every seat what it paid back".
RATIONALE: Free money via an over-refund, a skipped LMS refund when total.eth == 0, or double refund after config changes.
```

```
PROPERTY_ID: [ADV-12]
TYPE: SPECIFIC (escrow_joinWithLms_clamped, escrow_joinWithLms_smallLms_clamped, quoteLmsDiscount)
ENGLISH: LMS cannot buy more fee discount than it is worth. At the rate read at join, discount_eth * rate <= lms_paid * 1e18 (the LMS side rounds up), discount <= fee(stake)*MAX_DISCOUNT_BPS/10000, discount > 0 implies lms_paid > 0, the seat's recorded Discount.lms equals the LMS the escrow actually received (no uint128 truncation), and due = stake - discount equals msg.value.
SOLIDITY_SKETCH:
  rate = config.lmsPerEthDiscount(); lms0 = lms.balanceOf(E); esc0 = E.totalEscrowed();
  join... ; d = E.getSeatDiscount(id, p);
  lte(uint256(d.eth) * rate, uint256(d.lms) * 1e18);          // mulDiv ceil / floor identity
  lte(d.eth, fee(stake, termsFeeBps) * 5000 / 10000);
  if (d.eth > 0) gt(d.lms, 0);
  eq(lms.balanceOf(E) - lms0, d.lms);                         // detects cast truncation
  eq(E.totalEscrowed() - esc0, info.stake - d.eth);
  also: discount only if rate != 0, token set, and < half of fee
GHOST_NEEDS: rate used at join
SNAPSHOT_NEEDS: escrow LMS balance, totalEscrowed
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec: "pay up to MAX_DISCOUNT_BPS of its fee in LMS instead of ETH, at the config's lmsPerEthDiscount"; context says "floor one way and ceil the other".
RATIONALE: Sub-unit truncation (rate 1e30, 1 wei fee) or ceil/floor reversal would hand out ETH discounts for free LMS (I-a, I-b).
```

```
PROPERTY_ID: [ADV-13]
TYPE: SPECIFIC (after escrow_finalize_clamped)
ENGLISH: A result cannot pay anyone more than the terms the lobby opened on allow, however config changed meanwhile or whether seats used LMS. Each rank i is credited exactly floor((pool - fee(pool, terms.feeBps)) * terms.payoutBps[i] / 10000), independent of discounts. Ranks beyond the schedule get no prize, the treasury gets the rest, and no address that is not a seat or the terms' treasury has its balance changed.
SOLIDITY_SKETCH:
  T = E.getMatchTerms(id); pool = stake*seatCount; dist = pool - pool*T.feeBps/10000;
  for i in ranking: expected = i < T.payoutBps.length ? dist*T.payoutBps[i]/10000 : 0;
      eq(E.withdrawable(ranking[i]) - w0[ranking[i]] - (ranking[i]==T.treasury ? treasuryExtra : 0), expected);
  eq(E.withdrawable(T.treasury)-wT0, pool - sumPaid - sumDiscountEth);
  for x in actors not in seats and != T.treasury: eq(E.withdrawable(x), w0[x]);
  (subtract overlaps when a seat is also the treasury)
GHOST_NEEDS: w0 per actor before finalize
SNAPSHOT_NEEDS: withdrawable of all actors and of T.treasury
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: Terms NatSpec: "fixed from the config at that moment so a governance change cannot alter it for a player who already staked"; `_distribute` NatSpec: "prizes do not depend on how seats paid".
RATIONALE: Detects mid-match parameter-change exploitation, discount-funded-from-prizes, and payout leakage to non-participants.
```

```
PROPERTY_ID: [ADV-14]
TYPE: GLOBAL (plus handler-level in finalize/join/cancel/veto)
ENGLISH: Play-mining credit cannot be farmed for free or counted early. epochFees and feesPaid grow only inside finalize of a MATCHMADE lobby, by the net ETH fee (fee - seat discount), never in join, cancel, veto, abort, private lobbies or dispute. Per epoch, sum(epochFees) <= ETH actually credited to the treasury by matchmade finalizations in that epoch, and epochFees[e] == sum over actors of feesPaid[a][e] (when only actors play).
SOLIDITY_SKETCH:
  for e in feeEpochs: lte(E.epochFees(e), ghosts.treasuryFeeMatchmade[e]);
                      eq(E.epochFees(e), sum_a E.feesPaid(a,e));
  handler-level: join/cancel/veto/abort/private finalize => feesPaid and epochFees for current epoch unchanged
  matchmade finalize: delta epochFees == sum over seats (fee(stake,feeBps) - seatDiscount.eth)
GHOST_NEEDS: treasuryFeeMatchmade[epoch] (add FeeCredited-equivalent remainder on matchmade finalize), per-epoch actor fee sum
SNAPSHOT_NEEDS: feesPaid and epochFees before and after each lifecycle call
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec: "Only a settled match pays its fee, so only a settled match counts"; "Fee totals count only the ETH part, the net fee"; "Fee totals, and so play-mining, count matchmade lobbies only".
RATIONALE: The reward program prices LMS against real fees; any over-count (join-then-cancel, private lobby, discount ignored) is free LMS.
```

```
PROPERTY_ID: [ADV-15]
TYPE: GLOBAL
ENGLISH: Sybil or timing games cannot pull more LMS out of the program than its budget. For every epoch, the sum of tranches granted to all players <= epochBudget(epoch); each tranche <= the epoch's fixed walletCap and <= feesPaid * fixedRate / 1e18; the fixed rate never exceeds maxRewardPerEth as set when it was fixed; sum of everything granted <= totalBudget() <= LMS funded; zero-fee or pre-program epochs grant nothing.
SOLIDITY_SKETCH:
  for e in feeEpochs: sumE = 0; for p in actors: t = V.trancheOf(p,e).amount; sumE += t;
        (rate,cap,fixed) = R.rateOf(e);
        if (fixed) { lte(t, cap); lte(t, Math.mulDiv(E.feesPaid(p,e), rate, 1e18)); }
      lte(sumE, R.epochBudget(e));
  lte(V.totalGranted(), R.totalBudget());
  gte(lms.balanceOf(address(V)) + V.totalReleased(), V.totalGranted());   // backing
GHOST_NEEDS: none (iterate registries)
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: RewardsDistributor NatSpec: "the claims of an epoch add up to at most its budget"; "the rate is also capped at maxRewardPerEth, and what one wallet earns in an epoch at maxRewardPerWalletPerEpoch".
RATIONALE: Rounding, cap re-reading after the rate is fixed, or the uint120/uint128 narrowing in Rate could over-issue.
```

```
PROPERTY_ID: [ADV-16]
TYPE: SPECIFIC (rewards_claim_clamped, rewards_claim_duplicateEpoch_clamped)
ENGLISH: A claim can never pay an epoch twice, for any caller. Repeating an epoch inside one call, in a later call, or from another caller for the same player must revert (AlreadyClaimed or NothingToClaim), and an existing tranche is never overwritten or increased. A third-party claim only ever vests to the player and cannot burn an epoch whose reward is non-zero.
SOLIDITY_SKETCH:
  before = V.trancheOf(p,e).amount;
  try R.claim(p, [e,e]) { t(false) } catch {}
  if (R.isClaimed(p,e)) { try R.claim(p,[e]) { t(false) } catch {} }
  after: V.trancheOf(p,e).amount == before || before == 0
  claim for p by caller c != p: lms.balanceOf(c) unchanged, tranche belongs to p only
  if claimed epoch had paid>0 and reward==0 -> record dust-burn event (lead for review)
GHOST_NEEDS: claimedAmount[p][e]
SNAPSHOT_NEEDS: tranche amount, isClaimed
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `RewardVesting.grant` reverts AlreadyGranted; distributor sets claimedBits; NatSpec "Open to anyone: the reward can only ever vest to player".
RATIONALE: Double-claim and cumulative bypass of the one-claim-per-epoch rule.
```

```
PROPERTY_ID: [ADV-17]
TYPE: GLOBAL
ENGLISH: Nobody can release more than has vested. Per tranche, released <= vested(now) <= amount; totalReleased <= totalGranted; sum over tranches of released == totalReleased; LMS held by the vesting contract >= totalGranted - totalReleased.
SOLIDITY_SKETCH:
  for e in feeEpochs, p in actors: tr = V.trancheOf(p,e); lte(tr.released, V.vested(p,e)); lte(V.vested(p,e), tr.amount);
  lte(V.totalReleased(), V.totalGranted());
  gte(lms.balanceOf(address(V)), V.totalGranted() - V.totalReleased());
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: RewardVesting NatSpec: linear vest over 26 weeks; accounting identity totalGranted/totalReleased.
RATIONALE: Early or over-release, and an unfunded vesting contract.
```

```
PROPERTY_ID: [ADV-18]
TYPE: SPECIFIC (escrow_settle_badRanking_clamped, escrow_finalize_clamped, new tamper modes)
ENGLISH: A result cannot be forged or redirected. settle succeeds only for exactly the tuple a quorum of the locked attestor-set version signed. Any single change to matchId, rounds, historyRoot, transcriptHash or ranking order, a ranking with a duplicate, an unseated address, a missing seat or an extra entry, signatures below threshold, duplicate or unsorted signers, a signer outside the locked set (including a member of the newest set added after lock), or a signature made for another match, fails. finalize with a permutation other than the proposed one fails.
SOLIDITY_SKETCH:
  for mode in {flipRounds, flipRoot, flipTranscript, swapRank, dupSeat, foreignAddr, dropSeat, extraSeat,
               belowThreshold, dupSigner, unsorted, wrongVersionSigner, otherMatchSig}:
      build bad call; try E.settle(...) { t(false, mode) } catch {}
  try E.finalize(id, permuted) { t(false) } catch {}
  also: settle of a Live match after attestor set rotation still uses info.attestorSetVersion
GHOST_NEEDS: none
SNAPSHOT_NEEDS: match status unchanged after a failed attempt
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `_assertSeatSet` NatSpec "without this a quorum could redirect the pool to addresses that never staked"; settle digest commits to the full tuple (EIP-712); setAttestorSet NatSpec "a match keeps the one it locked under".
RATIONALE: Direct fund redirection if any field is left out of the digest or the seat-set check is bypassed (bitmask with 256 seats, duplicates).
```

```
PROPERTY_ID: [ADV-19]
TYPE: SPECIFIC (all StakedLms handlers) + GLOBAL
ENGLISH: Nobody can profit from timing around a reward deposit, and nobody can lower another account's accrued rewards. earned(a) never decreases except through a's own claimRewards; deposit, depositFor, transfer, requestUnstake, depositRewards (including dust, repeated), harvest and donations leave every account's earned() unchanged at that instant; a same-timestamp stake -> harvest -> unstake -> claim by an attacker yields no ETH beyond what it had already accrued.
SOLIDITY_SKETCH:
  snapshot earned[a] for all actors before every S/feeRouter handler (except claimRewards by a);
  after: for a: gte(S.earned(a), before[a]);   // monotone
  deposit/depositFor/transfer/depositRewards/harvest at same ts: for a: eq(S.earned(a), before[a]) (allow +-1 for the mulDiv floor)
  probe adversary_jitStake(amount): D = S.earned(me); deposit(amount); FR.harvest()/depositRewards{value}; requestUnstake(amount);
      try claimRewards(me) returns (uint256 got) { lte(got, D) } catch {}
GHOST_NEEDS: earnedBefore[actor]
SNAPSHOT_NEEDS: earned for all actors, rewardPerShare
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: StakedLms NatSpec: "being staked for a week would earn no more than being staked for a second"; "settling happens in `_update`, before any balance moves, so a mint, burn or transfer can never carry rewards earned by someone else"; "That can never take anything from stakers".
RATIONALE: Classic JIT-staking harvest sandwich and settle-ordering bugs (settledAt for fresh receivers, supply-0 pause path).
```

```
PROPERTY_ID: [ADV-20]
TYPE: GLOBAL
ENGLISH: The staking vault cannot be made insolvent. LMS balance >= totalSupply + totalUnstaking (donations only add), the ETH balance >= sum of earned(a) over all holders (rounding loss stays in the vault), and a full stake -> requestUnstake -> claim round trip returns exactly the LMS staked, no more and no less.
SOLIDITY_SKETCH:
  gte(lms.balanceOf(S), S.totalSupply() + S.totalUnstaking());
  sum=0; for a in actors: sum += S.earned(a); gte(address(S).balance, sum);
  handler-level in claim: lms received == unstakeOf.assets; sweepStray amount == balance - supply - unstaking
GHOST_NEEDS: donatedLms, donatedEth (optional; >= already holds)
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec: "The LMS backing sLMS is totalSupply; with totalUnstaking that is everything owed"; Synthetix-style accumulator floors.
RATIONALE: Rounding drift in rewardPerShare/depositRewards/unpaid carry-over, or sweepStray reaching staked LMS, would let early exiters drain later ones.
```

```
PROPERTY_ID: [ADV-21]
TYPE: GLOBAL
ENGLISH: Votes cannot be inflated, double counted or bought after the snapshot. Sum of getVotes(a) over actors <= sLMS totalSupply; for each proposal, for+against+abstain <= getPastTotalSupply(snapshot); each voter's weight <= getPastVotes(voter, snapshot); a proposal in Succeeded, Queued or Executed has for+abstain >= quorum(snapshot) >= quorumFloor(snapshot) and for > against; quorumFloor never exceeds 10% of LMS supply at the time it was set.
SOLIDITY_SKETCH:
  sum=0; for a in actors: sum += S.getVotes(a); lte(sum, S.totalSupply());
  for pr in proposals: (against,for_,abs) = G.proposalVotes(pr.id); snap = G.proposalSnapshot(pr.id);
       lte(against+for_+abs, S.getPastTotalSupply(snap));
       if (state in {Succeeded,Queued,Executed}) { gte(for_+abs, G.quorum(snap)); gte(G.quorum(snap), G.quorumFloor(snap)); gt(for_, against); }
  handler-level at castVote: weight <= S.getPastVotes(voter, snap)
GHOST_NEEDS: none (iterate `proposals`)
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: ERC20Votes accounting identity; LmsGovernor NatSpec "at the proposal's snapshot, so tokens bought or staked after a proposal is made cannot vote on it"; "quorum is the larger of that fraction and quorumFloor".
RATIONALE: A governance takeover is the strongest extraction path (it owns config, bridge receiver, attestors). Transfers, delegation and requestUnstake between snapshot and vote are the attack space.
```

```
PROPERTY_ID: [ADV-22]
TYPE: SPECIFIC (ZapJoin handlers)
ENGLISH: ZapJoin cannot take anyone else's tokens or leave value behind. Every actor has approved the zap for max, yet a joinWithToken by caller c only ever reduces c's token balance, by at most maxAmountIn; the seat is c's and exactly info.stake is added to totalEscrowed; the zap holds zero ETH and zero input tokens afterwards; partial fills and unexpected deltas revert instead of underpaying the stake.
SOLIDITY_SKETCH:
  tok0[a] for all actors; esc0 = E.totalEscrowed();
  vm.prank(c); try zap.joinWithToken(id, path, maxIn, dl) returns (uint256 amtIn) {
      lte(amtIn, maxIn); eq(tok0[c]-tokenBal(c), amtIn); for a != c: eq(tokenBal(a), tok0[a]);
      eq(E.totalEscrowed()-esc0, stake); t(E.hasSeat(id,c));
      eq(address(zap).balance, 0); eq(tokenBal(zap), 0);
  } catch {}
  thin-pool path (ZAP_THIN_FEE) must always revert, never seat c
GHOST_NEEDS: none
SNAPSHOT_NEEDS: token balances of all actors, zap and poolManager; escrow totals
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: ZapJoin NatSpec: "the input goes straight from the player to the PoolManager... nothing is held between transactions"; "all the escrow receives is a joinFor call with the exact stake attached".
RATIONALE: Pull-from-approved-victim and under-funded seat attacks via the permissionless entry point.
```

```
PROPERTY_ID: [ADV-23]
TYPE: SPECIFIC (session_execute_clamped, session_grantSession_clamped) + GLOBAL
ENGLISH: A leaked session key is worth no more than its caps. Per (account, key): spent <= spendCap, each call <= valueCap, no call after validUntil or after revoke, validUntil <= grant time + 7 days. The only successful calls are escrow.join(matchId) with value, or escrow.withdrawFor(account) with value 0; any other target, selector, trailing bytes, other withdrawFor account or nonzero value on withdrawFor reverts. Each success increments the account nonce by one (no replay), and the seat or payout always belongs to the account itself, never to the relayer or key.
SOLIDITY_SKETCH:
  for acct in sessionAccounts, k in sessionKeys: (vu,vc,sc,sp) = acct.sessions(k); lte(sp, sc); lte(vc, sc);
  handler: n0 = acct.sessionNonce(); s0 = spent;
     success => eq(acct.sessionNonce(), n0+1); lte(spent - s0, value); selector in {join, withdrawFor};
              join => E.hasSeat(id, acct); withdrawFor => acct.balance increased by credited amount; nobody else's withdrawable changed
     forbidden modes (other target, setRecipient-like selector, extra bytes, expired, revoked, replayed nonce, withdrawFor(other)) => success means t(false)
GHOST_NEEDS: grantTime[account][key]
SNAPSHOT_NEEDS: nonce, spent, escrow.withdrawable of non-account actors
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: SessionKeyDelegate NatSpec: scope "join(matchId) and withdrawFor(account) on escrow, and nothing else"; "a cap per call and a cap in total"; "every session expires, within MAX_SESSION_DURATION".
RATIONALE: Abuse of a compromised browser key, replay and cumulative-cap bypass (I-d).
```

```
PROPERTY_ID: [ADV-24]
TYPE: SPECIFIC (bridge_withdrawToChainFor_clamped)
ENGLISH: Nobody but the player (or the key their ERC-1271 wallet vouches for) can move a player's escrow balance out through the bridge. A Withdrawal fails if any signed field is altered (recipient, destination, outputToken, maxFee, deadline, hubChainId, quote fields), the nonce is stale or replayed, the signature is by another key, or the player is a session account and the signature is by a session key. A success sends the player's whole balance (minus nothing) to the SpokePool, bumps nonces[player] by exactly 1, and satisfies output <= amount and fee <= maxFee.
SOLIDITY_SKETCH:
  for mode in {tamperRecipient, tamperDest, tamperToken, tamperMaxFee, tamperQuote*, staleNonce, replay, wrongSigner,
               expired, wrongHub, sessionKeySigns(sessionAccount)}:
      try B.withdrawToChainFor(w,q,sig) { t(false, mode) } catch {}
  success: eq(nonces_after, nonces_before+1); eq(E.withdrawable(p), 0); eq(totalOwed_before - totalOwed_after, amount);
           gte(amount, MIN_WITHDRAW_FOR); lte(q.outputAmount, amount); lte(amount - q.outputAmount, w.maxFee);
GHOST_NEEDS: lastWithdrawn[p]
SNAPSHOT_NEEDS: nonces, withdrawable, totalOwed
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: BridgeJoinReceiver NatSpec: "The player signs the Across quote too, so whoever submits it chooses nothing"; SessionKeyDelegate NatSpec: "a session key never speaks for the account off-chain".
RATIONALE: The receiver is authorised to drain any balance via withdrawToBridge; its signature check is the only barrier.
```

```
PROPERTY_ID: [ADV-25]
TYPE: GLOBAL
ENGLISH: The receiver is not an ETH sink. B's ETH balance changes only through unroutable arrivals (up) and owner recover (down); it is unchanged by withdrawToChainFor and by any routed join. A SpokePool report of WETH that never arrived must not spend ETH the receiver holds for other depositors.
SOLIDITY_SKETCH:
  ghost heldEth = (+ Unroutable ETH events) - (recover ETH);
  eq(address(B).balance, ghosts.heldEth);                // GLOBAL, tolerate forced ETH via >=
  bridge_handleOnHeldEth_clamped: held funds unchanged unless pool delivered the WETH
GHOST_NEEDS: heldEth
SNAPSHOT_NEEDS: B balance before/after every bridge handler
PRIORITY: MEDIUM
GUARANTEE: EXPLORATORY
EVIDENCE: "Holds nothing between transactions except what it could not route" is NatSpec, but `_unwrap` deliberately falls back to held ETH and the SpokePool is a trusted external (context item 7), so the on-held-ETH half is a trust question.
RATIONALE: A malicious or buggy pool can launder stuck funds into a seat for an attacker-chosen player.
```

```
PROPERTY_ID: [ADV-26]
TYPE: SPECIFIC (new probe `adversary_accessMatrix(selectorSeed)`, callers outsider and non-privileged actors)
ENGLISH: Every privileged function rejects an unprivileged caller. Owner-only: all ProtocolConfig setters, vrf.setCoordinator and setConsumer, B.recover, S.setCooldown and sweepStray, FeeRouter setters, R setters and sweep, reserve.setRecipient, escrow.extendPause. Role-only: createMatchmade (matchmaker), bridgeJoin and withdrawToBridge (bridgeReceiver), fulfillRandomness (the match's oracle), veto and dismissDispute (guardian or owner), pause (guardian), vesting.grant (distributor), handleV3AcrossMessage (SpokePool), unlockCallback (PoolManager), reserve.release (safe or owner). Ownership of every Ownable stays with the timelock.
SOLIDITY_SKETCH:
  for each (target, calldata) in matrix: vm.prank(outsider); (ok,) = target.call(data); if (ok) t(false, name);
  property_owners_are_timelock(): eq(config.owner(), timelock) && same for vrf, B, S, FR, R, reserve (exploratory: trusted handlers may transfer)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: Per-function NatSpec and modifiers (`onlyOwner`, "Guardian only", "Only the config's bridgeReceiver may call it", `NotDistributor`).
RATIONALE: Direct privilege escalation (J). Gives the fuzzer an always-on access-control sweep in addition to the clamped happy paths.
```

```
PROPERTY_ID: [ADV-27]
TYPE: SPECIFIC (escrow_secondary pause/unpause/extendPause) + GLOBAL
ENGLISH: The guardian cannot hold play stopped or undo governance. A guardian unpause during a governance pause (pausedByGovernance) reverts; guardian pause() never shortens or replaces a longer pause (pausedUntil is non-decreasing across guardian calls); a guardian pause lasts at most GUARDIAN_PAUSE; a second guardian pause is refused until pausedUntil + GUARDIAN_COOLDOWN (also after an early unpause); extendPause by anyone but governance reverts.
SOLIDITY_SKETCH:
  pu0 = E.pausedUntil(); gov0 = E.pausedByGovernance();
  guardian unpause while paused && gov0: success => t(false)
  guardian pause success => gte(E.pausedUntil(), pu0) && E.pausedUntil() == ts + 7 days && (pu0 == 0 || ts >= pu0 + 7 days) && !E.pausedByGovernance()
  ghost lastGuardianPauseEnd; GLOBAL: lte(E.pausedUntil(), max(ghost.maxGovUntil, lastGuardianPauseStart + 7 days))
GHOST_NEEDS: maxGovUntil, lastGuardianPauseStart
SNAPSHOT_NEEDS: pausedUntil, pausedByGovernance
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: ExpiringPause NatSpec "can end its own pause early, but not one governance extended"; context I-14 / G-30 now enforced.
RATIONALE: Compromised guardian griefing; also a state-machine bug where pause() resets pausedByGovernance on an ongoing governance pause.
```

```
PROPERTY_ID: [ADV-28]
TYPE: SPECIFIC (multisig_secondary) + GLOBAL
ENGLISH: The Safe cannot keep power or LMS past the phase, directly or nested. Only the Safe schedules or cancels, only before phaseEnd; a call to the timelock, transferOwnership, renounceOwnership, any call to the token, sweep, sweepStray, setRecipient or recover(LMS) is refused, in schedule and in every element of scheduleBatch. After phaseEnd and retire(), phase holds neither PROPOSER nor CANCELLER, retire() before phaseEnd reverts, and nothing the Safe scheduled moves timelock LMS, changes any owner, or gives Safe or phase LMS or sLMS votes (including via governor.relay).
SOLIDITY_SKETCH:
  forbidden modes (incl. nested relay(timelock, ...), batch with one bad element at last index, data shorter than 4 bytes to token): success => t(false)
  GLOBAL: if (ts >= phase.phaseEnd() && retired) t(!timelock.hasRole(PROPOSER, phase) && !timelock.hasRole(CANCELLER, phase));
  for ops executed that were scheduled via phase: lms.balanceOf(timelock) not decreased, owners unchanged
  lms.balanceOf(safe)==0 && S.balanceOf(safe)==0 && S.getVotes(safe)==0  (exploratory: only if no handler funds safe)
GHOST_NEEDS: opsScheduledByPhase[], timelockLmsBefore at execute
SNAPSHOT_NEEDS: timelock LMS balance, owners
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: MultisigPhase NatSpec lists each refusal and "Once that has passed, anyone may call retire, which renounces both roles for good"; the nested-bypass part is EXPLORATORY.
RATIONALE: Voting-power persistence after the training-wheels phase and the Safe draining treasury LMS are the headline governance risks; the first-level selector check is easy to route around.
```

```
PROPERTY_ID: [ADV-29]
TYPE: SPECIFIC (escrow_cancelMatch_clamped, escrow_lockMatch_clamped)
ENGLISH: Lock and cancel cannot be raced for advantage. A lobby that reached the terms' minSeats cannot be cancelled before joinDeadline + LOCK_GRACE; cancelMatch before the stated deadline (Open: joinDeadline, Pending: seed deadline, Live: settle deadline) reverts; cancelMatch on None, Proposed, Settled or Cancelled reverts; lockMatch on a full lobby before joinDeadline succeeds (when not paused, oracle healthy) and on an under-quorum lobby always reverts.
SOLIDITY_SKETCH:
  eligible = computeFromInfo(info, terms);  // as in ADV-02
  try E.cancelMatch(id) { if (!eligible) t(false) } catch { if (eligible) t(false) }
  lock: full && !paused && oracleHealthy => must succeed; seatCount < terms.minSeats => must revert
GHOST_NEEDS: none
SNAPSHOT_NEEDS: match info, terms, block.timestamp
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: cancelMatch NatSpec: "a seated player who expects to lose could cancel it in the same block as the lock and race it" (hence LOCK_GRACE).
RATIONALE: A seated loser escaping via refund. Also flags the settle-versus-cancel race at the Live deadline (settle has no deadline check) so a human can decide whether it matters.
```

```
PROPERTY_ID: [ADV-30]
TYPE: SPECIFIC (escrow_finalize_clamped, sequencer toggles)
ENGLISH: A result cannot finalise while the L2 sequencer is down or within SEQUENCER_GRACE_PERIOD of recovery, so the outage cannot shorten the challenge window; and once up and past grace, an eligible finalize never fails because of the feed.
SOLIDITY_SKETCH:
  (answer, startedAt) = feed.latestRoundData();
  down = answer != 0 || ts < startedAt + 1 hours;
  windowOver = ts >= info.deadline && rankingOk;
  try E.finalize(id, ranking) { if (down) t(false) } catch { if (!down && windowOver) t(false) }
GHOST_NEEDS: none
SNAPSHOT_NEEDS: feed round data
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: finalize NatSpec: "Not while the L2 sequencer is down, nor for SEQUENCER_GRACE_PERIOD after it comes back".
RATIONALE: Veto-suppression by timing, and the reverse liveness failure if the feed read can revert or is unset.
```

```
PROPERTY_ID: [ADV-31]
TYPE: SPECIFIC (fulfillRandomness probes)
ENGLISH: A seed cannot be injected or reused. fulfillRandomness succeeds only from the oracle the match locked with, only while Pending, and only once. After an oracle change the new oracle cannot seed an old Pending match and the old one still can. An Open or Cancelled match cannot be seeded. The same randomness word seeds two matches differently, and a zero word is a valid seed.
SOLIDITY_SKETCH:
  for id in matchIds: s = status(id);
    vm.prank(x): try E.fulfillRandomness(id, w) { assert(x == info.oracle && s == Pending) } catch {}
  after seeding: seed == keccak256(abi.encode(w, id)); status == Live; deadline == ts + terms.settleWindow
  seeds of two matches from equal w differ
GHOST_NEEDS: none
SNAPSHOT_NEEDS: oracle snapshot of the match
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: fulfillRandomness NatSpec: "The oracle is the one the match asked, not the current one"; "Only a Pending match takes a seed, so a second answer, or a late one for a match already cancelled, reverts".
RATIONALE: Seed manipulation lets a colluding quorum or oracle pre-compute outcomes.
```

```
PROPERTY_ID: [ADV-32]
TYPE: SPECIFIC (feeRouter_harvest_clamped) + GLOBAL
ENGLISH: Harvesting cannot be used to skim or redirect fees. After any harvest the router holds 0 ETH and escrow.withdrawable(router) is 0; the vault received exactly floor(amount * stakerBps / 10000) and the treasury exactly the rest; the caller's identity does not change the split; ETH forced into the router is split like any other.
SOLIDITY_SKETCH:
  pre = E.withdrawable(FR) + address(FR).balance; sBal0 = address(S).balance; tBal0 = treasury.balance;
  amt = FR.harvest();
  eq(amt, pre); eq(address(FR).balance, 0); eq(E.withdrawable(FR), 0);
  eq(address(S).balance - sBal0, amt*bps/10000);
  eq(treasury.balance - tBal0, amt - amt*bps/10000);   // receiving side only; treasury is not msg.sender
GHOST_NEEDS: none
SNAPSHOT_NEEDS: balances of router, vault and treasury
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: FeeRouter NatSpec: "Holds no ETH between transactions"; "splits whatever balance it finds".
RATIONALE: Rounding or reentrancy leakage on the one permissionless fee-moving call.
```

```
PROPERTY_ID: [ADV-33]
TYPE: GLOBAL
ENGLISH: The escrow cannot be drained or made insolvent by any sequence, including forced ETH. address(E).balance >= totalOwed + totalEscrowed, totalOwed >= sum of withdrawable over actors and treasury, totalLmsEscrowed <= LMS held by the escrow and equals the sum of Discount.lms over non-terminal matches.
SOLIDITY_SKETCH:
  gte(address(E).balance, E.totalOwed() + E.totalEscrowed());
  gte(E.totalOwed(), sum_a E.withdrawable(a) + E.withdrawable(treasuryAddrs));
  lms.balanceOf(E) >= E.totalLmsEscrowed();  eq(E.totalLmsEscrowed(), sum over matchIds non-terminal of matchDiscount.lms)   // needs ghost since matchDiscount is private
GHOST_NEEDS: lmsEscrowedByMatch[id] (add at join, remove at terminal)
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: GameEscrow NatSpec: solvency invariant `address(this).balance == totalOwed + totalEscrowed` (>= once ETH is forced in).
RATIONALE: The harness runs under Echidna and Medusa, where the Foundry invariant suite does not execute; this is the base drain detector the other properties lean on.
```

```
PROPERTY_ID: [ADV-34]
TYPE: SPECIFIC (probe `adversary_drainAndReenter`)
ENGLISH: An empty protocol is re-enterable and clean. After all matches are terminal and every account has withdrawn, totalEscrowed == 0, totalOwed == 0, totalLmsEscrowed == 0 and the escrow balance equals the forced-ETH ghost; a fresh lobby then opens, fills, settles and pays normally. In the vault, after every staker has left and claimed, supply == 0 and totalUnstaking == 0 and LMS balance equals donations; a dust stake, then a reward deposit, then claims work and stranded ETH is not claimable by anyone before it is earned.
SOLIDITY_SKETCH:
  if (allTerminal() && all withdrawable == 0) { eq(E.totalEscrowed(),0); eq(E.totalOwed(),0); eq(E.totalLmsEscrowed(),0); eq(address(E).balance, ghosts.forcedEth); }
  vault: if (S.totalSupply()==0 && S.totalUnstaking()==0) eq(lms.balanceOf(S), ghosts.donatedLms)
  first-staker probe: stake 1 wei at supply 0 with waiting ETH -> claim same ts yields 0; earned grows only with time
GHOST_NEEDS: forcedEth, donatedLms
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: EXPLORATORY
EVIDENCE: none, inferred from Pattern G. (Vault NatSpec says ETH with no stakers "waits for the first ones", so the first-staker share is by design.)
RATIONALE: Residue after full exit and first-depositor capture of a stalled stream.
```

```
PROPERTY_ID: [ADV-35]
TYPE: SPECIFIC (handlers that touch other accounts)
ENGLISH: A third party cannot change another account's position. depositFor, transfer, depositRewards, joinFor, claim on behalf, release on behalf and harvest leave every other account's unstakeOf (assets and unlockAt), withdrawable (unless it is the named beneficiary or seat), owed rewards and vesting released unchanged. In particular no one can restart or extend someone else's unstake cooldown or queue.
SOLIDITY_SKETCH:
  snapshot for b != caller: S.unstakeOf(b), S.balanceOf(b) (allow increase for depositFor target), E.withdrawable(b), V.trancheOf(b,e)
  after each handler: eq for all fields except the documented beneficiary
GHOST_NEEDS: none
SNAPSHOT_NEEDS: per-actor unstakeOf, withdrawable, balances
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `requestUnstake` burns from msg.sender only; `release`/`claim` NatSpec "can only ever vest/pay to player".
RATIONALE: Griefing and cooldown-resetting attacks on victims (J).
```

```
PROPERTY_ID: [ADV-36]
TYPE: SPECIFIC (needs an Actor variant with a hostile receive())
ENGLISH: An ETH-receiving hook cannot double-pay or corrupt accounting. During withdraw, withdrawFor, claimRewards, FeeRouter harvest and bridge payouts, a recipient that re-enters withdraw, join, cancelMatch, finalize, claimRewards or depositRewards ends with total received == total credited, and every aggregate (totalOwed, totalEscrowed, S rewards) balanced.
SOLIDITY_SKETCH:
  ReentrantActor.receive(): attempt one of {withdraw, join{value}, cancelMatch, finalize, claimRewards, depositRewards} (try/catch)
  after: eq(received, creditedBefore); ADV-33 and ADV-20 solvency hold
GHOST_NEEDS: creditedBefore[actor]
SNAPSHOT_NEEDS: balances and totals before the call
PRIORITY: MEDIUM
GUARANTEE: EXPLORATORY
EVIDENCE: none, inferred. `Actor.receive()` is empty today, so no existing handler exercises reentrancy. join, joinFor, lockMatch, dispute, dismissDispute and bridgeJoin are not nonReentrant, so cross-function reentrancy depends on checks-effects-interactions.
RATIONALE: Cross-function reentrancy through the pull payouts and the staker ETH claim.
```

## Notes for the pipeline

- Highest-yield cluster (most likely to reveal real bugs): ADV-02 (exit liveness at boundary config), ADV-12 (discount maths at rate extremes), ADV-13 (terms snapshot vs. mid-match config change), ADV-14/15 (reward over-issue), ADV-19/20 (staking accrual and solvency), ADV-18 and ADV-24 (forgery paths), ADV-28 (nested bypass).
- New harness pieces implied: ghosts `proposedDeadline`, `treasuryFeeMatchmade[epoch]`, `lmsEscrowedByMatch`, `heldEth`, `forcedEth`, `donatedLms`, `maxGovUntil`; probes `adversary_exitEveryMatch`, `adversary_accessMatrix`, `adversary_jitStake`, `adversary_drainAndReenter`; a reentrant Actor variant (ADV-36).
- ADV-10, ADV-25, ADV-34 and ADV-36 are EXPLORATORY; every other property carries cited evidence.
