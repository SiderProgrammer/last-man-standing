# Conservation Auditor: proposed properties (Last Man Standing)

Scope: accounting / conservation identities only. Source of truth is `src/` (x-ray is stale). Harness facts honoured: no `vm.warp` persistence assumptions, no assertions on an actor's ETH around a payable call (only protocol-side balances; ETH an account RECEIVES from a withdrawal is asserted), donations tracked in ghosts (`escrow_donateETH`, `stakedLms_donateETH`, `feeRouter_donateETH`, `stakedLms_donateLms`), trusted-role actions treated as legal.

Harness facts used while designing the sums (verified in handlers):
- sLMS and LMS only ever move to `actors` (transfer/depositFor/claim receiver/sweepStray/rewards.sweep/reserve release candidates), except `lms_transfer`-style flows never target contracts, and `stakedLms_donateLms` targets the vault only. So holder sets of "actors" are complete for sLMS, vesting tranches and unstake queues.
- Creditor set for `PullPayable.withdrawable`: `actors`, every `Terms.treasury` (initially `timelock`, then `feeRouter`, via `config_secondary` any value set), `config.getParams().treasury`, `feeRouter`, `timelock`, `bridgeReceiver` (only as `to`, never a creditor). Build the set, dedupe, then sum.

Ghost conventions referenced below (all in `Ghosts`):
`donatedEscrowEth`, `donatedStakedEth`, `donatedRouterEth` (reset to 0 on every successful harvest), `donatedStakedLms`, `sweptStakedLms`, `burnedLms`, `stakedRewardsDeposited`, `stakedRewardsClaimed`, `rewardsSwept`, `reserveReleased`, `expectedEpochFees[epoch]`, `expectedFeesPaid[player][epoch]`.

---

PROPERTY_ID: CON-01
TYPE: GLOBAL
ENGLISH: The escrow always holds at least what it owes: its ETH balance covers pending withdrawals plus live stakes.
SOLIDITY_SKETCH:
```
function property_escrow_solvent() public view returns (bool) {
    return address(escrow).balance >= escrow.totalOwed() + escrow.totalEscrowed();
}
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: GameEscrow NatSpec on `totalEscrowed` and PullPayable NatSpec: "address(this).balance == totalOwed + totalEscrowed" (>= once ETH is forced in, per harness fact 3).
RATIONALE: The core money guarantee. Any phantom credit (double `_credit`, `totalEscrowed` not decremented, bridge refund credited twice) makes the escrow insolvent. Goes beyond the existing Foundry invariant because it runs over bridge, zap, LMS-discount, session and veto paths in one sequence.

---

PROPERTY_ID: CON-02
TYPE: GLOBAL
ENGLISH: Exact form of solvency: balance minus forced donations equals `totalOwed + totalEscrowed`, so no wei is stranded or unexplained (catches value silently entering the escrow without bookkeeping).
SOLIDITY_SKETCH:
```
function property_escrow_exactLedger() public view returns (bool) {
    return address(escrow).balance
        == escrow.totalOwed() + escrow.totalEscrowed() + ghosts.donatedEscrowEth;
}
```
GHOST_NEEDS: `donatedEscrowEth` incremented in `escrow_donateETH` by the clamped amount.
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec states the two totals "account for the entire contract balance"; the only other ETH entry is forced donation, which the ghost tracks. Closed-form identity.
RATIONALE: `>=` hides leaks in the other direction (e.g. `bridgeJoin` crediting less than `msg.value`, remainder neither staked nor owed). Equality pins every entry point. Also catches ETH sent to the escrow by peripheries that should hold nothing.

---

PROPERTY_ID: CON-03
TYPE: GLOBAL
ENGLISH: `totalOwed` equals the sum of every account's `withdrawable` across all addresses that can ever be credited.
SOLIDITY_SKETCH:
```
function property_totalOwed_isSumOfBalances() public view returns (bool) {
    address[] memory set = _creditors(); // actors + feeRouter + timelock + bridgeReceiver
                                         // + treasury of every stored Terms (termsCount, getTerms)
                                         // + config.getParams().treasury, deduped
    uint256 sum;
    for (uint i; i < set.length; ++i) sum += escrow.withdrawable(set[i]);
    return sum == escrow.totalOwed();
}
```
GHOST_NEEDS: optional `address[] creditorsSeen` appended whenever `config_secondary` changes treasury (otherwise read `escrow.getTerms(1..termsCount())` treasuries).
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: PullPayable: `totalOwed` "Sum of every unwithdrawn balance."
RATIONALE: Pattern D. Catches a credit that bumps `totalOwed` without `withdrawable` (or vice versa), and any path that zeroes `withdrawable` without decrementing. If the set is not provably complete under `config_secondary`, assert `sum <= totalOwed` and treat `<` only as a fuzz lead.

---

PROPERTY_ID: CON-04
TYPE: GLOBAL
ENGLISH: `totalEscrowed` equals the ETH actually staked in matches that have not ended: for each match in Open/Pending/Live/Proposed, `stake * seatCount - sum(seat discount eth)`.
SOLIDITY_SKETCH:
```
function property_totalEscrowed_isSumOfLiveMatches() public view returns (bool) {
    uint256 sum;
    for (uint i; i < matchIds.length; ++i) {
        GameEscrow.MatchInfo memory m = escrow.getMatch(matchIds[i]);
        if (m.status < Open || m.status > Proposed) continue;   // None, Settled, Cancelled excluded
        address[] memory seats = escrow.getSeats(matchIds[i]);
        uint256 disc;
        for (uint j; j < seats.length; ++j) disc += escrow.getSeatDiscount(matchIds[i], seats[j]).eth;
        sum += uint256(m.stake) * m.seatCount - disc;
    }
    return sum == escrow.totalEscrowed();
}
```
GHOST_NEEDS: none (loops over `matchIds`; cap iteration to the last N=64 live matches only if gas becomes a problem, else keep exact).
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec on `totalEscrowed`: "Stakes held for matches that have not yet settled or cancelled."
RATIONALE: Pattern D, the escrow's per-match ledger. Catches a terminal transition (settle, veto, cancel, abort) that forgets to decrement, a double-decrement, a `seatCount` vs `matchSeats.length` divergence, and discount accounting errors. `matchIds` grows; keep as is while small.

---

PROPERTY_ID: CON-05
TYPE: GLOBAL
ENGLISH: LMS escrowed against seats equals the sum of seat LMS discounts in unfinished matches, and equals the escrow's LMS balance (nothing else can enter, nothing is stranded).
SOLIDITY_SKETCH:
```
function property_totalLmsEscrowed_exact() public view returns (bool) {
    uint256 sum;
    for each match in Open/Pending/Live/Proposed:
        for each seat: sum += escrow.getSeatDiscount(id, seat).lms;
    return sum == escrow.totalLmsEscrowed()
        && lms.balanceOf(address(escrow)) == sum;
}
```
GHOST_NEEDS: none (no handler transfers LMS to the escrow directly: `lms_transfer` targets only actors).
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec: "LMS held against seats of matches that have not ended" and "burned when it settles, refunded ... when it is cancelled, vetoed or aborted".
RATIONALE: Pattern A+B for the LMS leg. Catches a burn or refund of the wrong amount (e.g. `matchDiscount.lms` vs sum of seat LMS), a veto after discount that does not return LMS, or `totalLmsEscrowed` drifting after a rate change mid-match.

---

PROPERTY_ID: CON-06
TYPE: SPECIFIC
ENGLISH: Every state-changing escrow entry point moves value between `totalEscrowed` and `totalOwed` without creating or destroying it. finalize / veto / cancelMatch / abortMatch: `delta totalOwed == -delta totalEscrowed` and `delta balance == 0`. join / joinFor / joinWithLms / ZapJoin: `delta balance == delta totalEscrowed == paid`. withdraw paths covered in CON-11.
SOLIDITY_SKETCH:
```
// after finalize / veto / cancelMatch / abortMatch (snapshot before the call):
int256 dOwed = int256(escrow.totalOwed()) - int256(before.totalOwed);
int256 dEsc  = int256(escrow.totalEscrowed()) - int256(before.totalEscrowed);
eq(dOwed + dEsc, 0, "terminal transition must conserve");
eq(address(escrow).balance, before.escrowBalance, "terminal transition moves no ETH");
// after join*:
eq(address(escrow).balance - before.escrowBalance, escrow.totalEscrowed() - before.totalEscrowed);
eq(escrow.totalOwed(), before.totalOwed); // joins never credit
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: `State { escrowBalance, totalOwed, totalEscrowed, totalLmsEscrowed }`; `_takeSnapshot` must be rewritten to capture them (currently stores `actor.balance`, which must not be used).
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: Settlement only "credits an internal balance" and refunds only credit (NatSpec); a closed accounting identity per transition.
RATIONALE: Local, stronger version of CON-01..04; pinpoints which transition leaked. `joinWithLms`: `totalEscrowed` rises by `stake - discountEth`, equal to `msg.value`.

---

PROPERTY_ID: CON-07
TYPE: SPECIFIC
ENGLISH: After `finalize`, the pool is fully assigned: total newly credited equals `stake * seatCount - discountEth`, and the sum of per-account `withdrawable` deltas over seats and treasury equals that total (no credit lands outside seats and treasury, none is lost).
SOLIDITY_SKETCH:
```
// before finalize: pool = stake*seatCount; D = sum seatDiscount.eth; treasury = getMatchTerms(id).treasury
// snapshot withdrawable for each seat and the treasury (dedupe if treasury is a seat)
// after:
eq(escrow.totalOwed() - before.totalOwed, pool - D);
uint256 credited; for each unique account in seats+treasury: credited += withdrawable(a) - beforeW[a];
eq(credited, pool - D);
// payouts: for i < schedule.length: seat ranking[i] got >= distributable*bps[i]/10000
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: per-account `withdrawable` map for seats + treasury (local arrays in the handler)
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `_distribute` NatSpec: "the pool is always fully assigned and nothing can be stranded"; remainder is the fee "less the discounts".
RATIONALE: Pattern B for settlement. Catches `remainder` underflow or over-credit at boundary parameters `config_secondary` can reach (fee 0 or 10%, 2 seats, payout schedule longer than seats) and misdirected credits.

---

PROPERTY_ID: CON-08
TYPE: SPECIFIC
ENGLISH: After `veto` / `cancelMatch` / `abortMatch`, every seat is credited exactly `stake - seatDiscount.eth` and receives back exactly `seatDiscount.lms` LMS; aggregate credits equal `stake*n - matchDiscount.eth`, aggregate LMS returned equals `matchDiscount.lms`, and `totalLmsEscrowed` falls by exactly that.
SOLIDITY_SKETCH:
```
// before: for each seat s: wBefore[s]=withdrawable(s); lBefore[s]=lms.balanceOf(s); d[s]=getSeatDiscount(id,s)
// after:
for each seat s (unique): eq(withdrawable(s)-wBefore[s], stake - d[s].eth);
                          eq(lms.balanceOf(s)-lBefore[s], d[s].lms);   // LMS is non-payable-safe
eq(before.totalLmsEscrowed - escrow.totalLmsEscrowed(), sum d[s].lms);
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: per-seat withdrawable and LMS balances (local to the handler)
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec `_refundAll`: "credits every seat what it paid back: its stake, less any discount, and the LMS that paid for the discount."
RATIONALE: Refund path is where player funds are most at risk; includes the veto of a result whose discounted seats a guardian refunds, and the mixed discount/no-discount lobby that takes the second loop of `_refundAll`. Skip LMS delta assertions for a seat that is also the caller only if the caller spends LMS in that call (it does not).

---

PROPERTY_ID: CON-09
TYPE: SPECIFIC
ENGLISH: A bridged join conserves every wei delivered: `msg.value` is either staked (up to the stake) plus the excess credited, or entirely credited as a refund; nothing is retained by the receiver or lost.
SOLIDITY_SKETCH:
```
// after bridge_fillJoin_clamped / bridge_fillAnyMatch_clamped with WETH amount A, message routable:
int256 dEsc  = totalEscrowed - before.totalEscrowed;
int256 dOwed = totalOwed - before.totalOwed;
eq(dEsc + dOwed, int256(A), "stake+credit == delivered");
eq(address(escrow).balance - before.escrowBalance, A);
eq(address(bridgeReceiver).balance, before.receiverEth);    // nothing retained
eq(weth.balanceOf(address(bridgeReceiver)), before.receiverWeth);
// seated => dEsc == stake and dOwed == A - stake; refunded => dEsc == 0 and dOwed == A and (player credited by A)
// the player's withdrawable rose by dOwed
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: `receiverEth`, `receiverWeth`, escrow balance, totals
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `bridgeJoin` NatSpec: "all of it is credited to the player here instead"; "More than the stake takes the seat and credits the player the rest"; receiver "Holds nothing between transactions except what it could not route".
RATIONALE: Cross-chain path with no Foundry invariant. Catches the refund-branch credit mismatch (paused, full, rostered-out, stake too low, `JoinFailure.AlreadyJoined`) and an extra credit when the seat is taken.

---

PROPERTY_ID: CON-10
TYPE: SPECIFIC
ENGLISH: Every withdrawal pays out exactly the account's balance: `withdrawable[account]` becomes 0, `totalOwed` falls by `amount`, the escrow loses `amount` ETH, and the destination gains `amount`. `withdrawToChainFor`: the whole balance leaves the escrow, passes through the receiver with no residue, and lands in the SpokePool as WETH.
SOLIDITY_SKETCH:
```
// withdraw(to) / withdrawFor(account):
eq(escrow.withdrawable(account), 0);
eq(before.totalOwed - escrow.totalOwed(), amount);
eq(before.escrowBalance - address(escrow).balance, amount);
if (to is not escrow/harness): eq(to.balance - before.toBalance, amount); // receipts are safe to assert
// bridge_withdrawToChainFor:
eq(before.escrowBalance - address(escrow).balance, amount);
eq(weth.balanceOf(address(acrossPool)) - before.poolWeth, amount);
eq(address(bridgeReceiver).balance, before.receiverEth);
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: `toBalance`, `poolWeth`, `receiverEth`
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `_payOut` zeroes the balance, subtracts from `totalOwed`, then pays; `withdrawToChainFor` NatSpec "bridges a player's whole escrow balance".
RATIONALE: Pull-payment pairing; catches partial payout, balance left non-zero, ETH stuck in the receiver, and the MockAcrossSpokePool's `inputAmount` vs `msg.value` mismatch hiding as a revert. Use the success branch of try/catch for the must-fail variants of `bridge_withdrawToChainFor_clamped`; only assert deltas when it succeeds.

---

PROPERTY_ID: CON-11
TYPE: GLOBAL
ENGLISH: Fee ledger consistency: for every fee epoch seen, `epochFees[epoch]` equals the sum of `feesPaid[player][epoch]` over all players, and both equal the independently recomputed fee of every matchmade, finalized match in that epoch (net of ETH discounts; private lobbies contribute zero).
SOLIDITY_SKETCH:
```
function property_feeLedger() public view returns (bool) {
    for (uint i; i < feeEpochs.length; ++i) {
        uint256 e = feeEpochs[i];
        uint256 sum;
        for (uint j; j < actors.length; ++j) sum += escrow.feesPaid(actors[j], e);
        if (sum != escrow.epochFees(e)) return false;
        if (escrow.epochFees(e) != ghosts.expectedEpochFees[e]) return false;
        for (uint j; j < actors.length; ++j)
            if (escrow.feesPaid(actors[j], e) != ghosts.expectedFeesPaid[actors[j]][e]) return false;
    }
    return true;
}
// ghost update in escrow_finalize (before the call, from pre-state): if match.matchmade:
//   fee = stake*terms.feeBps/10000; for each seat: net = fee - seatDiscount.eth (if fee != 0)
//   expectedFeesPaid[seat][epochAtFinalize] += net; expectedEpochFees[epoch] += net
```
GHOST_NEEDS: `expectedEpochFees` (epoch -> uint), `expectedFeesPaid` (player -> epoch -> uint); computed in `escrow_finalize` against the epoch `block.timestamp / FEE_EPOCH` read at call time.
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: GameEscrow NatSpec: "every seat's fee is added to two running totals ... the player's own and the epoch's"; "Fee totals count only the ETH part, the net fee"; "Fee totals, and so play-mining, count matchmade lobbies only". If a rostered seated player outside `actors` is possible, restrict the first equality to `<=`.
RATIONALE: Pattern D. This feeds the whole play-mining payout; a wrong total silently mints LMS. Catches counting at join, counting private lobbies, double counting a re-finalized match, forgetting the discount.

---

PROPERTY_ID: CON-12
TYPE: SPECIFIC
ENGLISH: Fees recorded for play-mining never exceed the real ETH credited to the treasury by that settlement: `sum of recorded net fees <= treasury remainder`.
SOLIDITY_SKETCH:
```
// in escrow_finalize, matchmade only:
uint256 recorded = escrow.epochFees(epoch) - before.epochFees;       // delta of this call
uint256 treasuryCredit = pool - sumPaidToWinners - D;                // recompute from Terms, or
// credit = delta withdrawable[treasury] when treasury is not also a seat
lte(recorded, treasuryCredit, "play-mining counts fee ETH that was not collected");
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: `epochFees(epoch)` before; withdrawable[treasury] before
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: RewardsDistributor NatSpec: "the fees themselves are real ETH that goes to stakers and the treasury"; escrow NatSpec "Only a settled match pays its fee, so only a settled match counts".
RATIONALE: Pattern for "fees recorded but not collected". Analytically it holds because the sum of per-seat floors is at most the floor of the sum, so any violation is a genuine fee-leakage bug (e.g. discount subtraction or payout schedule exceeding 100%).

---

PROPERTY_ID: CON-13
TYPE: GLOBAL
ENGLISH: LMS supply is conserved: it never exceeds the minted amount and equals the minted amount minus everything burned (escrow settlement burns plus `lms_burn`). No phantom mint.
SOLIDITY_SKETCH:
```
function property_lmsSupply() public view returns (bool) {
    return lms.totalSupply() == LMS_SUPPLY - ghosts.burnedLms;
}
// ghosts.burnedLms += discount.lms (sum of seatDiscount.lms for the match) in escrow_finalize when the call succeeds,
// and += value in lms_burn.
```
GHOST_NEEDS: `burnedLms` updated in `escrow_finalize` (sum of `getSeatDiscount(...).lms` over seats before the call, only if status becomes Settled) and in `lms_burn` / `lms_burn_clamped`.
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: LmsToken NatSpec: "Fixed supply, minted once ... no mint function"; escrow burns exactly the LMS paid as discount when the match settles.
RATIONALE: Detects a burn of the wrong amount (burning more or less than `matchDiscount.lms`, hence stakers' or other holders' LMS), or any path that mints.

---

PROPERTY_ID: CON-14
TYPE: GLOBAL
ENGLISH: No LMS leaks out of the known holder set: the balances of every protocol contract, harness account and actor sum to the total supply.
SOLIDITY_SKETCH:
```
function property_lmsClosedSystem() public view returns (bool) {
    uint256 sum = sumActorsERC20Balances(address(lms));
    sum += lms.balanceOf(address(timelock)) + lms.balanceOf(address(rewards))
         + lms.balanceOf(address(vesting)) + lms.balanceOf(address(reserve))
         + lms.balanceOf(address(escrow)) + lms.balanceOf(address(stakedLms))
         + lms.balanceOf(safe) + lms.balanceOf(address(this))
         + lms.balanceOf(address(feeRouter)) + lms.balanceOf(address(phase))
         + lms.balanceOf(address(bridgeReceiver)) + lms.balanceOf(address(zap))
         + lms.balanceOf(address(governor));
    return sum == lms.totalSupply();
}
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: EXPLORATORY
EVIDENCE: none, inferred. The designed recipients are all in this set, but a governance proposal (`LmsGovernor` handlers) could legitimately send LMS elsewhere; if it fails, check proposal targets before calling it a bug.
RATIONALE: Catches LMS stranded in a contract with no exit (vesting, distributor, router, zap, bridge receiver) or sent to an unexpected address (e.g. reserve releasing to vault, safe or itself, which the approval rule forbids).

---

PROPERTY_ID: CON-15
TYPE: GLOBAL
ENGLISH: StakedLms LMS backing is exact: the vault holds `totalSupply + totalUnstaking + donated - swept` LMS. In particular it is never below `totalSupply + totalUnstaking`.
SOLIDITY_SKETCH:
```
function property_stakedLms_backing() public view returns (bool) {
    uint256 backing = stakedLms.totalSupply() + stakedLms.totalUnstaking();
    uint256 bal = lms.balanceOf(address(stakedLms));
    return bal >= backing
        && bal == backing + ghosts.donatedStakedLms - ghosts.sweptStakedLms;
}
```
GHOST_NEEDS: `donatedStakedLms` (in `stakedLms_donateLms`), `sweptStakedLms` (amount returned by `_stakedLms_sweepStray`, read from the `StraySwept` effect via balance delta).
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: StakedLms NatSpec: "The LMS backing sLMS is `totalSupply`; with `totalUnstaking` that is everything owed. LMS sent here directly is neither, and governance can sweep it." One sLMS is always one LMS.
RATIONALE: Pattern B at 1:1. Existing Foundry invariant likely covers `>=`; the exact form and the ghost accounting catch `sweepStray` taking staked LMS, `claim` underpaying, and `requestUnstake` double counting under a repeated request that restarts the cooldown.

---

PROPERTY_ID: CON-16
TYPE: GLOBAL
ENGLISH: Sum-of-parts for StakedLms: `totalUnstaking` equals the sum of every `unstakeOf[a].assets`; `totalSupply` equals the sum of sLMS balances; the sum of `getVotes` over delegates equals `totalSupply` (every holder is self-delegated or delegated on receipt).
SOLIDITY_SKETCH:
```
function property_stakedLms_sums() public view returns (bool) {
    uint256 unstaking; uint256 bal; uint256 votes;
    for (uint i; i < actors.length; ++i) {
        (uint128 a,) = stakedLms.unstakeOf(actors[i]); unstaking += a;
        bal   += stakedLms.balanceOf(actors[i]);
        votes += stakedLms.getVotes(actors[i]);
    }
    return unstaking == stakedLms.totalUnstaking()
        && bal == stakedLms.totalSupply()
        && votes == stakedLms.totalSupply();
}
```
GHOST_NEEDS: none (all holders and delegatees are `actors`; `stakedLms_delegate_clamped` only picks actors)
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: "Every account that receives sLMS is self-delegated on receipt unless it already chose a delegate" (NatSpec); `totalUnstaking` "LMS held for pending unstakes"; ERC20Votes identity of votes to delegated supply. Votes equality requires that no holder ever has delegate 0; the contract guarantees it for receivers.
RATIONALE: Pattern A/D. A voting-power leak (votes not following transfers/burns on `requestUnstake`) is the highest-impact governance accounting bug. If `getVotes` equality is too strict (burn without delegate), downgrade that clause to `<=`.

---

PROPERTY_ID: CON-17
TYPE: GLOBAL
ENGLISH: StakedLms ETH is conserved against an independent ledger: ETH held equals ETH ever deposited as rewards (directly or via harvest) minus ETH ever claimed plus forced donations.
SOLIDITY_SKETCH:
```
function property_stakedLms_ethLedger() public view returns (bool) {
    return address(stakedLms).balance
        == ghosts.stakedRewardsDeposited - ghosts.stakedRewardsClaimed + ghosts.donatedStakedEth;
}
// ghosts.stakedRewardsDeposited += msg.value in stakedLms_depositRewards*; += (harvested * stakerBps_before / 10000) in feeRouter_harvest
// ghosts.stakedRewardsClaimed   += return value of claimRewards
```
GHOST_NEEDS: `stakedRewardsDeposited`, `stakedRewardsClaimed`, `donatedStakedEth`; `feeRouter_harvest` must read `feeRouter.stakerBps()` before the call and use the returned `amount`.
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `depositRewards` is the only payable entry (the vault has no `receive`), `claimRewards` is the only exit; closed accounting identity. Per-wei dust stays in the contract by design, so the ledger holds exactly.
RATIONALE: Pattern B. Catches ETH lost through the paused-stream branch (`supply == 0`), a claim paying more than `owed`, and harvest depositing a different amount than the ghost expects.

---

PROPERTY_ID: CON-18
TYPE: GLOBAL
ENGLISH: StakedLms never promises more ETH than it holds: the total claimable by all stakers now plus the unpaid remainder of the stream is at most the ETH balance.
SOLIDITY_SKETCH:
```
function property_stakedLms_entitlementsCovered() public view returns (bool) {
    uint256 owedNow;
    for (uint i; i < actors.length; ++i) owedNow += stakedLms.earned(actors[i]);
    uint64 last = stakedLms.lastAccrual(); uint64 fin = stakedLms.periodFinish();
    uint256 rate = stakedLms.rewardRate();
    uint256 remaining;
    if (last < fin) {
        uint256 from = stakedLms.totalSupply() == 0 ? last : (block.timestamp > last ? block.timestamp : last);
        if (fin > from) remaining = (uint256(fin - from) * rate) / 1e27;
    }
    return owedNow + remaining <= address(stakedLms).balance;
}
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: Every wei of `earned` and of the stream originates from `depositRewards` ETH; floor divisions in `rewardPerShare`, `earned` and `rate` only lose dust, so entitlements cannot exceed holdings (NatSpec: ETH that arrives with no stakers "waits for the first ones rather than being lost"). For `from`, when the stream is active and the supply is non-zero use `max(now, last)` capped at `fin`; avoid the case `from > fin` handled by the guard.
RATIONALE: The classic Synthetix insolvency: a late staker or a transfer capturing rewards already credited to another account, rounding up in `rate`, or `unpaid` carried over twice on repeated deposits. A last claimer failing with `TransferFailed` is the observable symptom.

---

PROPERTY_ID: CON-19
TYPE: SPECIFIC
ENGLISH: After `feeRouter_harvest` the router holds nothing and the split is exact: stakers receive `amount * stakerBps / 10000` into the vault, the treasury receives the rest, and `amount` equals everything harvested (pending escrow credit plus the router's ETH balance before the call, including forced donations).
SOLIDITY_SKETCH:
```
// before: pending = escrow.withdrawable(feeRouter); routerBal = address(feeRouter).balance; bps = feeRouter.stakerBps(); t = feeRouter.treasury()
// after (success): amount = return value
eq(amount, pending + routerBal);
eq(address(feeRouter).balance, 0);
eq(escrow.withdrawable(address(feeRouter)), 0);
uint256 toStakers = amount * bps / 10000;
eq(address(stakedLms).balance - before.vaultBal, toStakers);
if (t not in {feeRouter, stakedLms, escrow}) eq(t.balance - before.tBal, amount - toStakers);
ghosts.donatedRouterEth = 0;
```
And the global form: `address(feeRouter).balance == ghosts.donatedRouterEth` (the router holds only unharvested forced ETH).
GHOST_NEEDS: `donatedRouterEth` (+= in `feeRouter_donateETH`, reset to 0 after a successful harvest)
SNAPSHOT_NEEDS: `vaultBal`, `tBal`, `pending`, `routerBal`
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: FeeRouter NatSpec: "Holds no ETH between transactions ... harvest splits whatever balance it finds, so nothing that arrived another way can stay."
RATIONALE: Pattern B for the fee path. Catches rounding that leaves dust in the router every time, a forced donation that is never forwarded, and the treasury being paid the wrong remainder after `setStakerBps` boundaries 0 and 10000.

---

PROPERTY_ID: CON-20
TYPE: GLOBAL
ENGLISH: RewardVesting books balance with its token holdings and tranches: `totalGranted` equals the sum of all tranche amounts, `totalReleased` equals the sum of all tranche `released`, `released <= amount` per tranche, and the vesting contract holds exactly `totalGranted - totalReleased` LMS.
SOLIDITY_SKETCH:
```
function property_vesting_books() public view returns (bool) {
    uint256 g; uint256 r;
    for (uint i; i < feeEpochs.length; ++i)
        for (uint j; j < actors.length; ++j) {
            (uint128 amt, uint128 rel) = vesting.trancheOf(actors[j], feeEpochs[i]);
            if (rel > amt) return false;
            g += amt; r += rel;
        }
    return g == vesting.totalGranted() && r == vesting.totalReleased()
        && lms.balanceOf(address(vesting)) == g - r;
}
```
GHOST_NEEDS: none (tranche epochs are a subset of `feeEpochs`; a tranche needs `feesPaid > 0` which exists only for finalized-epoch fees; if rewards claims can happen for epochs not in `feeEpochs`, add a `claimedEpochs` registry)
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: RewardVesting NatSpec: "Every tranche's amount, added up" for `totalGranted`; "The distributor has already sent the LMS" (so holdings equal granted minus released). No handler transfers LMS to the vesting contract directly.
RATIONALE: Pattern A/B. Catches a grant that records less or more than what the distributor sent (a `continue` branch with `amount == 0`), a release double-paying the same epoch (the `epochs` list in `release` may repeat an epoch: the second `releasable` must be 0) and a `released` bookkeeping drift.

---

PROPERTY_ID: CON-21
TYPE: GLOBAL
ENGLISH: Play-mining supply conservation: the distributor's remaining LMS plus everything granted equals the original program funding minus anything swept; and per epoch, tranches granted never exceed the epoch's budget.
SOLIDITY_SKETCH:
```
function property_rewards_conservation() public view returns (bool) {
    if (lms.balanceOf(address(rewards)) + vesting.totalGranted()
        != PLAY_MINING_SHARE - ghosts.rewardsSwept) return false;
    for (uint i; i < feeEpochs.length; ++i) {
        uint256 e = feeEpochs[i]; uint256 s;
        for (uint j; j < actors.length; ++j) { (uint128 a,) = vesting.trancheOf(actors[j], e); s += a; }
        if (s > rewards.epochBudget(e)) return false;
    }
    return true;
}
```
GHOST_NEEDS: `rewardsSwept` (balance delta of `_rewards_sweep`; unreachable before `claimsCloseAt` but keep the term)
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: RewardsDistributor NatSpec: "the claims of an epoch add up to at most its budget"; budget split `totalBudget` over the 4-year program; funded with `PLAY_MINING_SHARE`.
RATIONALE: Pattern A. Mints LMS to farmers if violated. Interacts with `rewards_secondary` changing `maxRewardPerEth` and the wallet cap between the first claim and later ones (the rate is fixed on the first claim, so it must stay consistent) and with `epochFees` correctness (CON-11). Exact `<=` only holds if all players in the epoch are in `actors`; extend the sum if not.

---

PROPERTY_ID: CON-22
TYPE: SPECIFIC
ENGLISH: ZapJoin conserves value: after `joinWithToken` the escrow gained exactly the stake in ETH and `totalEscrowed` rose by it, the pool manager's ETH fell by exactly the stake, and the zap contract holds no ETH or tokens.
SOLIDITY_SKETCH:
```
// after zap_joinWithToken success; stake = escrow.getMatch(id).stake
eq(address(escrow).balance - before.escrowBalance, stake);
eq(escrow.totalEscrowed() - before.totalEscrowed, stake);
eq(before.poolMgrBalance - address(poolManager).balance, stake);
eq(address(zap).balance, 0);
eq(zapToken.balanceOf(address(zap)), 0);
eq(zapTokenB.balanceOf(address(zap)), 0);
// token side: amountIn <= maxAmountIn (return value)
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: `poolMgrBalance`, `escrowBalance`, `totalEscrowed`
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: ZapJoin NatSpec: "nothing is held between transactions — the input goes straight from the player to the PoolManager, and the ETH straight on to the escrow"; "Nothing is left over to refund".
RATIONALE: Pattern B on the periphery. Catches a partial fill leaving residual ETH or intermediate currency in the zap and an escrow join with a stake different from the swap output.

---

PROPERTY_ID: CON-23
TYPE: SPECIFIC
ENGLISH: StakedLms `sweepStray` can only take unaccounted LMS: after it succeeds the vault still holds exactly `totalSupply + totalUnstaking` LMS, and the swept amount equals the previous surplus.
SOLIDITY_SKETCH:
```
// before: surplus = lms.balanceOf(vault) - totalSupply - totalUnstaking
// after success: amount == surplus; lms.balanceOf(vault) == totalSupply + totalUnstaking; recipient LMS += amount
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: `vaultLms`, `totalSupply`, `totalUnstaking`
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec: "Staked and unstaking LMS cannot be touched."
RATIONALE: Governance sweep is the one path allowed to remove LMS from the vault; this pins its exact bound (also covers the case where a pending `claim` subsequently reverts for lack of LMS).

---

PROPERTY_ID: CON-24
TYPE: GLOBAL
ENGLISH: LiquidityReserve conserves its LMS: its balance equals the initial liquidity share minus everything released, and none of it ever reaches the vault, the Safe, or itself.
SOLIDITY_SKETCH:
```
function property_reserve_conservation() public view returns (bool) {
    return lms.balanceOf(address(reserve)) == LIQUIDITY_SHARE - ghosts.reserveReleased
        && !(reserve.isApproved(address(stakedLms)) || reserve.isApproved(safe) || reserve.isApproved(address(reserve)));
}
// ghosts.reserveReleased += amount in a successful _reserve_release (LMS delta of reserve)
```
GHOST_NEEDS: `reserveReleased`
SNAPSHOT_NEEDS: none
PRIORITY: LOW
GUARANTEE: SHOULD-HOLD
EVIDENCE: LiquidityReserve NatSpec: pays out only to approved recipients, and "the vault, the Safe and the reserve itself can never be approved". Unsolicited LMS donations to the reserve are not reachable in the harness (`lms_transfer` targets actors only).
RATIONALE: Pattern B for the 5% liquidity share. The approval clause is a state-machine check but is the condition for the LMS conservation to be meaningful.

---

PROPERTY_ID: CON-25
TYPE: SPECIFIC
ENGLISH: Held value in BridgeJoinReceiver when the pool lies: a `bridge_handleOnHeldEth_clamped` call spends ETH the receiver already holds. Conservation expectation: any ETH the receiver forwards to the escrow in a handler call must have arrived in that call (as WETH) or be accounted as previously held; the receiver's ETH balance must never fall below zero accounting for `Unroutable` holdings.
SOLIDITY_SKETCH:
```
// ghosts.bridgeHeldEth: += amount when a handler call ends with Unroutable ETH (receiver ETH rose, escrow flat);
//                       -= amount on bridge_secondary recover(ETH) and on a successful handleOnHeld routing
// global:
function property_bridge_heldEthAccounted() public view returns (bool) {
    return address(bridgeReceiver).balance == ghosts.bridgeHeldEth;
}
```
GHOST_NEEDS: `bridgeHeldEth`, updated from before/after balance deltas in `bridge_fill*`, `bridge_handleOnHeldEth_clamped`, `bridge_secondary`
SNAPSHOT_NEEDS: receiver ETH and WETH, escrow balance
PRIORITY: LOW
GUARANTEE: EXPLORATORY
EVIDENCE: none, inferred. The SpokePool is a trusted external that the docs accept; a violation of the held-ETH path is a trust-assumption failure, not a bug on its own.
RATIONALE: Checks that the "never reverts, holds what it cannot route" contract does not silently donate held ETH to a player's seat. Treat any failure as a lead for MIGRATION.md section 7 review.

---

## Summary

25 conservation properties (CON-01 to CON-25): 18 HIGH, 3 MEDIUM, 4 LOW. 23 tagged SHOULD-HOLD with cited evidence, 2 EXPLORATORY (CON-14, CON-25).

Implementation notes for the generator:
- `Snapshots.State._takeSnapshot` currently stores `actor.balance`; rewrite it to capture protocol-side balances and totals only (never an actor's ETH around a payable call).
- Specific properties (CON-06 to CON-10, CON-12, CON-19, CON-22, CON-23) need success-branch checks only, and a try/catch around `escrow_settle_badRanking_clamped`, `escrow_join_alreadySeated_clamped`, `rewards_claim_duplicateEpoch_clamped`, `bridge_withdrawToChainFor_clamped` so a must-fail case never falls through to an asserted delta.
- Global properties that loop (`CON-03`, `CON-04`, `CON-05`, `CON-11`, `CON-20`, `CON-21`) iterate `matchIds`, `feeEpochs`, `actors`; they can be capped to the most recent 64 entries if too slow, at the cost of exactness.
- Ghost hooks to add: donation handlers (`escrow_donateETH`, `stakedLms_donateETH`, `stakedLms_donateLms`, `feeRouter_donateETH`), `escrow_finalize` (burnedLms, expected fee ledger), `lms_burn*`, `stakedLms_claimRewards*`, `stakedLms_depositRewards*`, `feeRouter_harvest`, `_stakedLms_sweepStray`, `_rewards_sweep`, `_reserve_release`.
