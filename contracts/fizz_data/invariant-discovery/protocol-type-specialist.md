# Protocol-Type Specialist: Last Man Standing

## Classification (checked against `src/`, not the stale x-ray)

| Category | Where it applies |
|---|---|
| Escrow / Order state machine (Queue/Order, adapted) | `GameEscrow`: Open -> Pending -> Live -> Proposed -> Settled / Cancelled, seat list, pull-payments (`PullPayable`) |
| Staking / Locking | `StakedLms` (1:1 wrapper, streamed ETH rewards, unstake cooldown); `RewardVesting` (26 week linear vest); `RewardsDistributor` (play-mining, epoch budgets) |
| Token | `LmsToken` (fixed supply, burnable), `StakedLms` as ERC20Votes |
| Governance | `LmsGovernor` (quorum floor), `MultisigPhase`, `ExpiringPause`, `LiquidityReserve` |
| Fee splitter / Bridge | `FeeRouter`, `BridgeJoinReceiver` |
| NOT a vault | `StakedLms` states it is not ERC-4626. Vault templates V-01..V-08 do not apply as written. V-06 (first-depositor inflation) is replaced by SPEC-21 (1:1 backing). No exchange rate exists, so inflation cannot occur, and SPEC-21 checks it. |
| NOT lending / AMM | L-xx, A-xx skipped. |

Skipped templates and why: V-02..V-05, V-07, V-08 (no share price, no ERC-4626 surface), S-02 (the program is budgeted per epoch, not per-second; covered by SPEC-29), Q-01/Q-02 (there is no FIFO; rank comes from a signed ranking, checked by SPEC-17; Q-03 is SPEC-09), G-01 as stated (sLMS votes, not LMS; see SPEC-27).

Existing Foundry invariants (EscrowInvariant, RewardsInvariant, StakedLmsInvariant) already restate the basic `balance == totalOwed + totalEscrowed`, reward cap and backing checks. Where I include a variant, it is the tighter or ghost-based form, and it is flagged.

Conventions: `G` = ghost, `S` = snapshot. "tracked" = `actors` plus named contracts (`feeRouter`, `timelock`, `safe`, `bridgeReceiver`, `outsider`). Properties use `block.timestamp` only as read, never assumed.

---

## A. GameEscrow: money

```
PROPERTY_ID: SPEC-01
TYPE: GLOBAL
ENGLISH: The escrow is never insolvent: ETH balance covers everything owed plus everything staked in unfinished matches. With forced ETH the relation is >=; with donations tracked in a ghost it is exact.
SOLIDITY_SKETCH:
  function property_escrowSolvent() public returns (bool) {
      uint256 bal = address(escrow).balance;
      uint256 claims = escrow.totalOwed() + escrow.totalEscrowed();
      return bal >= claims                                   // always
          && bal == claims + ghosts.escrowDonatedEth;        // exact: only forced ETH is excess
  }
  // handler escrow_donateETH: ghosts.escrowDonatedEth += amount (after the selfdestruct succeeds)
  // bridge_handleOnHeldEth_clamped must NOT feed the escrow outside bridgeJoin (it moves receiver ETH into escrow via bridgeJoin, which is accounted).
GHOST_NEEDS: uint256 escrowDonatedEth
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: GameEscrow NatSpec on totalEscrowed: "the solvency invariant is address(this).balance == totalOwed + totalEscrowed"; PullPayable NatSpec repeats it.
RATIONALE: Core template L-01 / T-01 adapted. Exact-with-ghost form catches a one-wei leak or a rounding credit that the existing >= invariant tolerates (a leak that is smaller than any donation would be hidden by >=).
```

```
PROPERTY_ID: SPEC-02
TYPE: GLOBAL
ENGLISH: totalEscrowed equals the sum, over matches that are Open, Pending, Live or Proposed, of (stake * seatCount - sum of seats' ETH discounts). Settled and Cancelled matches contribute zero.
SOLIDITY_SKETCH:
  function property_totalEscrowedMatchesLiveMatches() public returns (bool) {
      uint256 sum;
      for (uint i; i < matchIds.length; ++i) {
          GameEscrow.MatchInfo memory m = escrow.getMatch(matchIds[i]);
          if (m.status == None || m.status == Settled || m.status == Cancelled) continue;
          address[] memory seats = escrow.getSeats(matchIds[i]);
          uint256 disc;
          for (uint j; j < seats.length; ++j) disc += escrow.getSeatDiscount(matchIds[i], seats[j]).eth;
          sum += uint256(m.stake) * m.seatCount - disc;
      }
      return escrow.totalEscrowed() == sum;
  }
GHOST_NEEDS: none (bridge-joined seats go through _seat, so they are included)
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: Code identity: `_seat` adds `paid` (stake - discount) and every exit (`finalize`, `_refundAll`) subtracts `stake * seatCount - discount.eth`. NatSpec: "Stakes held for matches that have not yet settled or cancelled."
RATIONALE: A per-match decomposition of SPEC-01. SPEC-01 alone cannot tell a mis-sized totalEscrowed from a mis-sized totalOwed when the errors cancel. Cost: loops over matchIds and seats; fine at this size.
```

```
PROPERTY_ID: SPEC-03
TYPE: GLOBAL
ENGLISH: LMS held against seats is fully custodied: totalLmsEscrowed equals the sum of seat LMS discounts in unfinished matches, and the escrow's LMS balance is at least that.
SOLIDITY_SKETCH:
  function property_lmsEscrowCustody() public returns (bool) {
      uint256 sum;
      for matches in {Open,Pending,Live,Proposed}: for seats: sum += escrow.getSeatDiscount(id, seat).lms;
      return escrow.totalLmsEscrowed() == sum && lms.balanceOf(address(escrow)) >= sum;
  }
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec: "The LMS is held here, against the seat, until the match ends: burned when it settles, refunded with the stake when it is cancelled, vetoed or aborted."
RATIONALE: Token-custody counterpart of SPEC-02. Not in the existing Foundry invariants. `config_secondary` can change `lmsToken`, so the balance clause is on the original LMS (`lms`), not `config.lmsToken()`.
```

```
PROPERTY_ID: SPEC-04
TYPE: GLOBAL
ENGLISH: totalOwed is at least the sum of tracked withdrawable balances, and equals it plus ghosted untracked credits.
SOLIDITY_SKETCH:
  function property_owedCoversBalances() public returns (bool) {
      uint256 s;
      for (i in actors) s += escrow.withdrawable(actors[i]);
      s += escrow.withdrawable(address(feeRouter)) + escrow.withdrawable(address(timelock))
         + escrow.withdrawable(address(bridgeReceiver)) + escrow.withdrawable(outsider);
      return escrow.totalOwed() >= s;
  }
GHOST_NEEDS: none for the >= form
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: Code identity: `totalOwed` changes only in `_credit` (+) and `_payOut` (-), each paired with the same `withdrawable` write. PullPayable NatSpec: "Sum of every unwithdrawn balance."
RATIONALE: Template T-01 (supply == sum of balances) applied to the internal ledger. Strengthen to == if a treasury registry covers every credited address (the treasury can be changed by `config_secondary`, so register every treasury ever set).
```

```
PROPERTY_ID: SPEC-05
TYPE: SPECIFIC
ENGLISH: finalize conserves value exactly. Let n = seatCount, discount = matchDiscount.eth. After finalize: totalEscrowed falls by stake*n - discount, totalOwed rises by exactly the same amount, and the escrow's ETH balance is unchanged. Each ranked seat i < payoutBps.length is credited floor(distributable*payoutBps[i]/10000); the treasury is credited the remainder, which is >= fee(pool) - discount.
SOLIDITY_SKETCH (inside the finalize handler, around the call):
  S before: totalEscrowed, totalOwed, balance(escrow), withdrawable[ranking[i]], withdrawable[treasury]
  pool = stake*n; fee = pool*feeBps/10000; dist = pool - fee;   // use Terms of the match, not live config
  expectedPaid_i = dist*payoutBps[i]/10000
  eq(owedAfter - owedBefore, pool - discountEth)
  eq(escrowedBefore - escrowedAfter, pool - discountEth)
  eq(balAfter, balBefore)
  eq(withdrawable[ranking[i]] after - before, expectedPaid_i)           // ranking players are distinct from treasury
  gte(treasuryCreditDelta + discountEth, fee)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: totalEscrowed, totalOwed, escrow ETH balance, withdrawable of each seat and of terms.treasury, matchDiscount.eth (via sum of getSeatDiscount), terms (via getMatchTerms)
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `_distribute` NatSpec: "The treasury takes the fee plus whatever integer division left behind, so the pool is always fully assigned and nothing can be stranded." Prize amounts are the explicit formula in `_distribute`.
RATIONALE: Conservation across settlement, the payout hot path. Must read `payoutBps` and `treasury` from `getMatchTerms(matchId)` because `config_secondary` can move live config. Guard the treasury delta: if the treasury is also a seated actor the per-seat equality must add the remainder; with feeRouter as treasury it is not.
```

```
PROPERTY_ID: SPEC-06
TYPE: SPECIFIC
ENGLISH: Every refund path (cancelMatch, veto, abortMatch) credits each seat exactly stake - its ETH discount, returns each seat's LMS discount, empties the match's contribution to totalEscrowed and totalLmsEscrowed, and sets status Cancelled. Total credited equals total staked.
SOLIDITY_SKETCH (inside cancel / veto / abort handlers):
  for each seat s: eq(withdrawable[s] after - before, stake - seatDisc[s].eth)
                   eq(lms.balanceOf(s) after - before, seatDisc[s].lms)
  eq(owedAfter - owedBefore, stake*n - totalDisc.eth)
  eq(escrowedBefore - escrowedAfter, stake*n - totalDisc.eth)
  eq(lmsEscrowedBefore - lmsEscrowedAfter, totalDisc.lms)
  eq(uint(getMatch(id).status), uint(Cancelled))
GHOST_NEEDS: none
SNAPSHOT_NEEDS: per-seat withdrawable and LMS balance for the match's seats, totals above
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `_refundAll` NatSpec: "credits every seat what it paid back: its stake, less any discount, and the LMS that paid for the discount." Contract header: "refunded with the stake when it is cancelled, vetoed or aborted."
RATIONALE: Template "refund is exact" for an escrow. EXPLORATORY side note: `_refundAll` reads `config.lmsToken()` live. If `config_secondary` changed the LMS token (or set it to zero) after a discounted join, the refund pushes the wrong token or reverts. That path is the property to watch: assert on the ORIGINAL `lms` balance. If it fails only after a config LMS-token change, it is a trust-model gap, not a bug (trusted role legal action); report it separately.
```

```
PROPERTY_ID: SPEC-07
TYPE: SPECIFIC
ENGLISH: Exit liveness. A Proposed match past its deadline with the correct ranking, the sequencer up past grace, finalizes without reverting (also while paused). A Live/Pending/Open match past its relevant deadline can be cancelled (also while paused). Withdrawals and veto during the window work while paused.
SOLIDITY_SKETCH (new "must succeed" handlers; try/catch, assert in the catch):
  if (status==Proposed && block.timestamp >= info.deadline && sequencerOk())
      try escrow.finalize(id, proposedRanking[id]) {} catch { t(false, "finalize reverted on a matured result"); }
  if (cancellable(id)) try escrow.cancelMatch(id) {} catch { t(false, "cancel reverted on expired match"); }
  if (withdrawable[a] != 0 && (withdrawable[a] >= MIN_WITHDRAW_FOR)) try escrow.withdraw(a)..  // pranked as a, a is an actor (Actor accepts ETH)
  sequencerOk(): feed.answer==0 && block.timestamp >= startedAt + SEQUENCER_GRACE_PERIOD
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec on `finalize`: "deliberately not paused: a pause must never hold a result that has already survived its challenge window"; on `cancelMatch`: "Permissionless once the relevant deadline has passed, so players are never dependent on the operator to recover their stake"; on `_isGuardian` block: "`finalize`, `veto`, `cancelMatch` and withdrawals are never paused".
RATIONALE: A reverted handler is invisible to the fuzzer, so liveness of the exit paths needs a try/catch assertion (harness fact 6). Likeliest failure: an underflow in `_distribute` (`pool - paid - discountEth`) or an LMS burn failing (`ERC20Burnable(config.lmsToken()).burn(discount.lms)` uses live config), either of which would strand every stake in the match.
```

```
PROPERTY_ID: SPEC-08
TYPE: GLOBAL
ENGLISH: Match status only moves along legal edges, and Settled and Cancelled are terminal. Legal edges: None->Open; Open->Pending|Cancelled; Pending->Live|Cancelled; Live->Proposed|Cancelled; Proposed->Settled|Cancelled.
SOLIDITY_SKETCH:
  // in a post-call hook run by every escrow handler (and by config_secondary / time-only handlers):
  function _recordStatuses() internal {
      for (i in matchIds) { s = status(matchIds[i]); p = ghosts.lastStatus[matchIds[i]];
          t(legal(p, s), "illegal status edge"); ghosts.lastStatus[matchIds[i]] = s; }
  }
  // global form: terminal states never revert to live
  function property_terminalIsTerminal() public returns (bool) {
      for (i in matchIds) if (ghosts.wasTerminal[matchIds[i]] && !isTerminal(status(matchIds[i]))) return false; return true; }
GHOST_NEEDS: mapping(bytes32=>uint8) lastStatus; mapping(bytes32=>bool) wasTerminal
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: Enum documentation in GameEscrow (`Settled`: "Result final and payouts credited", `Cancelled`: "every stake is refundable") and the `_inStatus` guards on every transition.
RATIONALE: Template G-03 (proposal state machine) applied to the match. A match settling twice or a cancelled match settling would double-credit: the stake is paid twice and solvency breaks later.
```

```
PROPERTY_ID: SPEC-09
TYPE: GLOBAL
ENGLISH: Seat bookkeeping is consistent. For every match: getSeats.length == seatCount <= maxSeats; seats are distinct; hasSeat holds for each; status >= Pending implies seatCount >= terms.minSeats; seatCount only grows while Open; no seat is added after lock.
SOLIDITY_SKETCH:
  function property_seatBookkeeping() public returns (bool) {
      for (i in matchIds) { m = getMatch(id); seats = getSeats(id);
          if (seats.length != m.seatCount || m.seatCount > m.maxSeats) return false;
          for j: if (!escrow.hasSeat(id, seats[j])) return false; (+ pairwise distinct, n <= 8)
          if (m.status >= Pending && m.status != Cancelled && m.seatCount < escrow.getMatchTerms(id).minSeats) return false; }
      return true; }
  // plus ghost: seatCount after status leaves Open equals seatCount at the lock
GHOST_NEEDS: mapping(bytes32=>uint16) seatCountAtLock
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `lockMatch` NatSpec ("Randomness is requested only after the seat list is final") and the `NotEnoughPlayers` check; `_seat` enforces uniqueness and capacity.
RATIONALE: Template Q-03 (queue size consistent). The seat list is the sum-of-parts for every payout.
```

```
PROPERTY_ID: SPEC-10
TYPE: GLOBAL
ENGLISH: In a matchmade lobby every seat belongs to the roster, by every join route (join, joinWithLms, joinWithLmsPermit, joinFor, ZapJoin, bridgeJoin). Fees and play-mining count matchmade lobbies only: a private lobby never changes epochFees / feesPaid.
SOLIDITY_SKETCH:
  function property_matchmadeSeatsRostered() public returns (bool) {
      for matches with info.matchmade: for seats: if (!escrow.rostered(id, seat)) return false; return true; }
  // feesPaid side: in escrow_finalize, if (!info.matchmade) eq(epochFees[epoch] after, before);
GHOST_NEEDS: none
SNAPSHOT_NEEDS: epochFees[epoch] (specific part)
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec: "A lobby is private unless the config's matchmaker opened it ... with the roster of players its queue put together: only those may take a seat in it, by any route." and "Fee totals, and so play-mining, count matchmade lobbies only."
RATIONALE: The farming barrier. Note `_joinFailure` checks the roster last; a bridged join must refund (JoinRefunded) rather than seat an unrostered player: the global check proves it.
```

---

## B. GameEscrow: discount, fees, disputes, pause

```
PROPERTY_ID: SPEC-11
TYPE: SPECIFIC
ENGLISH: quoteLmsDiscount never undercharges and never over-discounts: the discount is <= fee*MAX_DISCOUNT_BPS/10000, lmsUsed <= lmsIn, and the LMS charged is worth at least the discount at the rate (floor one way, ceil the other). Zero rate or token returns (0,0).
SOLIDITY_SKETCH (internal check callable from joinWithLms handler and a pure view handler with random lmsIn / matchId):
  (d, used) = escrow.quoteLmsDiscount(id, lmsIn);
  rate = config.lmsPerEthDiscount();
  if (rate == 0 || config.lmsToken()==0) { eq(d,0); eq(used,0); return; }
  lte(used, lmsIn);
  lte(d, fee(stake, feeBps_of_match) * MAX_DISCOUNT_BPS / BPS_DENOMINATOR);
  gte(Math.mulDiv(used, 1 ether, rate), d);          // protocol is paid at least what it gives
  lt(d, stake)                                        // the join computes stake - discount in uint128
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: Math identity of the two branches in `quoteLmsDiscount` (floor in `discount = mulDiv(lmsIn,1e18,rate)`, Ceil in the capped branch); NatSpec "never more than buys MAX_DISCOUNT_BPS of the fee"; `_joinWithLms` comment "at most half of a fee of at most 10% of it".
RATIONALE: Conversion template. Harness can set the rate to 0, 1 or 1e30: at rate 1e30 and tiny lmsIn the discount floors to 0 (`NoDiscount`); at rate 1, `used` could be 1 wei for large discount, which the Ceil clause must still cover. Check at those boundaries explicitly. Careful: `feeBps` here is from the match's snapshotted Terms (`getMatchTerms`), not live config.
```

```
PROPERTY_ID: SPEC-12
TYPE: SPECIFIC
ENGLISH: joinWithLms (and Permit variant) accounts exactly: msg.value == stake - discount; seat registered; totalEscrowed += stake - discount; totalLmsEscrowed += lmsUsed; escrow LMS balance += lmsUsed; the player's LMS falls by lmsUsed; seatDiscount equals (discount, lmsUsed); player ETH is not asserted.
SOLIDITY_SKETCH:
  (d, used) = quoteLmsDiscount(id, lmsIn) before the call
  eq(escrowedAfter - escrowedBefore, stake - d); eq(lmsEscrowedAfter - lmsEscrowedBefore, used);
  eq(lms.balanceOf(escrow) after - before, used); eq(lms.balanceOf(actor) before - after, used);
  eq(seatDiscount(id, actor).eth, d); eq(seatDiscount(id, actor).lms, used); t(hasSeat(id, actor));
GHOST_NEEDS: none
SNAPSHOT_NEEDS: totalEscrowed, totalLmsEscrowed, lms.balanceOf(escrow), lms.balanceOf(actor)
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `_joinWithLms` code and NatSpec "It stakes that much less ETH; the prize pool is the same".
RATIONALE: Per-call specific property T-04 (sender decreases by amount, receiver increases). Do NOT assert on actor ETH (harness fact 2). Re-quote must use the same block state; a rate change by `config_secondary` cannot happen inside one call.
```

```
PROPERTY_ID: SPEC-13
TYPE: GLOBAL
ENGLISH: Fee accounting. For every fee epoch seen, epochFees[e] equals the sum of feesPaid[p][e] over every player; epochFees is non-decreasing; and the total never exceeds the sum of fee(stake*seatCount) over matchmade matches that settled in that epoch (ghosted).
SOLIDITY_SKETCH:
  function property_feeEpochTotals() public returns (bool) {
      for (e in feeEpochs) { s = 0; for (a in actors) s += escrow.feesPaid(a, e);
          if (s != escrow.epochFees(e)) return false;
          if (escrow.epochFees(e) < ghosts.lastEpochFees[e]) return false;       // monotone
          if (escrow.epochFees(e) > ghosts.maxEpochFees[e]) return false; }       // <= sum fee(stake*n)
      return true; }
  // escrow_finalize handler: if matchmade, ghosts.maxEpochFees[epoch] += stake*n*feeBps/10000 (terms of the match);
  // _trackFeeEpoch() already registers epochs
GHOST_NEEDS: mapping(uint=>uint) lastEpochFees, maxEpochFees (the latter only for matchmade finalizations)
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec: "every seat's fee is added to two running totals for the current fee epoch: the player's own and the epoch's" and "a total only ever grows while its epoch is the current one".
RATIONALE: Template S-01 (sum of staked == total) for the reward-input ledger. Everything in RewardsDistributor trusts this identity: per-epoch claims sum to <= budget ONLY if sum(feesPaid) == epochFees. Participants of matchmade lobbies are actors only (roster), so the actor sum is complete. With a discount, net per seat = fee - seatDiscount.eth, so the upper bound uses net-of-discount or the gross fee (gross is a valid upper bound).
```

```
PROPERTY_ID: SPEC-14
TYPE: GLOBAL
ENGLISH: A fee epoch is final once it ends. After block.timestamp >= (e+1)*FEE_EPOCH, epochFees[e] and feesPaid[p][e] never change.
SOLIDITY_SKETCH:
  // hook run after every call: for e in feeEpochs where block.timestamp / FEE_EPOCH > e:
  //   if (!ghosts.frozen[e]) { ghosts.frozen[e]=true; ghosts.frozenFees[e]=epochFees(e); for a: ghosts.frozenPaid[a][e]=feesPaid(a,e); }
  //   else { eq(epochFees(e), ghosts.frozenFees[e]); for a: eq(feesPaid(a,e), ghosts.frozenPaid[a][e]); }
GHOST_NEEDS: frozen[e], frozenFees[e], frozenPaid[actor][e]
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec in GameEscrow ("it is final the moment the epoch ends") and RewardsDistributor ("an ended epoch's totals never change again, and every player's share of it is final").
RATIONALE: Rewards pay out as soon as an epoch ends; a late write would let claimants collectively exceed the epoch budget. Time moves only between calls (<=12 h), so epoch boundaries are crossed by ordinary Medusa delays. Read the epoch from `block.timestamp`, never from a cached value.
```

```
PROPERTY_ID: SPEC-15
TYPE: SPECIFIC
ENGLISH: finalize burns exactly the match's LMS discount: LMS totalSupply falls by discount.lms, totalLmsEscrowed falls by discount.lms, escrow LMS balance falls by discount.lms, and no LMS is sent to anyone.
SOLIDITY_SKETCH (in finalize handler):
  S before: lms.totalSupply(), totalLmsEscrowed, lms.balanceOf(escrow)
  eq(supplyBefore - supplyAfter, totalDisc.lms); eq(lmsEscrowedBefore - lmsEscrowedAfter, totalDisc.lms);
  eq(lmsBalBefore - lmsBalAfter, totalDisc.lms)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: lms.totalSupply(), totalLmsEscrowed, lms.balanceOf(escrow), match LMS discount total
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec: "burned when it settles"; event `LmsBurned`.
RATIONALE: Token template T-04 for the burn. Keep it separate from SPEC-05 so a burn failure is reported distinctly.
```

```
PROPERTY_ID: SPEC-16
TYPE: SPECIFIC
ENGLISH: Challenge window integrity. (a) finalize succeeds only if block.timestamp >= info.deadline, with the unchanged rankingHash, and (when the sequencer feed is set) only when the sequencer is up and past SEQUENCER_GRACE_PERIOD. (b) The deadline of a Proposed match never exceeds originalDeadline + DISPUTE_EXTENSION, and only one extension is ever applied. (c) Each seat disputes at most once. (d) dismissDispute never sets a deadline earlier than block.timestamp or later than originalDeadline.
SOLIDITY_SKETCH:
  // finalize handler: try/catch around finalize; in success branch:
  gte(block.timestamp, deadlineBefore); t(sequencerUpPastGrace()) ; eq(keccak256(abi.encode(ranking)), rankingHashBefore)
  // global:
  for Proposed matches: lte(info.deadline, ghosts.originalDeadline[id] + DISPUTE_EXTENSION)
  // dispute handler: second dispute by the same seat on the same match must fail (clamped handler + try/catch)
  // dismiss handler: after success, info.disputed==false and info.deadline in [now, originalDeadline] OR == now when original passed
GHOST_NEEDS: mapping(bytes32=>uint40) originalDeadline (set when status becomes Proposed); mapping(bytes32=>mapping(address=>bool)) disputedBy
SNAPSHOT_NEEDS: deadline, disputed, rankingHash of the match
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec on `dispute` ("The first open dispute extends the deadline; one already open does not extend it again", "each may dispute once"); `finalize` ("Not while the L2 sequencer is down, nor for SEQUENCER_GRACE_PERIOD after it comes back"); `dismissDispute` ("the result goes back to its own challenge deadline, or may be finalised at once if that has passed").
RATIONALE: Challenge-window templates (G-04/G-05 adapted). Edge worth exercising: dispute -> dismiss -> dispute-by-another-seat: the second dispute extends again (disputed flag was reset), so total extension can exceed one DISPUTE_EXTENSION if the window is still open. The bound in (b) will flag that. NatSpec says "Extended exactly once while disputed", so the bound is per open dispute; if the fuzzer finds (b) violated through dismiss -> second dispute, mark it EXPLORATORY for human review (each seat may still dispute once, so extension is bounded by seats * DISPUTE_EXTENSION). Tighten (b) to originalDeadline + seatCount * DISPUTE_EXTENSION as the SHOULD-HOLD form and keep the single-extension form as EXPLORATORY.
```

```
PROPERTY_ID: SPEC-17
TYPE: SPECIFIC
ENGLISH: Settlement accepts only a ranking that is exactly the seat set. After a successful settle, rankingHash == keccak256(abi.encode(ranking)), ranking.length == seatCount, every address has a seat, no duplicates; the status is Proposed; nothing was credited.
SOLIDITY_SKETCH:
  // escrow_settle_badRanking_clamped: try escrow.settle(...bad ranking, valid quorum signatures...) { t(false, "bad ranking accepted"); } catch {}
  // escrow_settle (good): after success: eq(owedAfter, owedBefore); eq(escrowedAfter, escrowedBefore); status==Proposed
GHOST_NEEDS: none
SNAPSHOT_NEEDS: totalOwed, totalEscrowed
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `_assertSeatSet` NatSpec: "without this a quorum could redirect the pool to addresses that never staked"; `settle` NatSpec: "Pays nothing yet."
RATIONALE: Permutation template (Q-02 analogue). Include duplicate, extra, missing and non-seated addresses, and a ranking that is a valid permutation of a DIFFERENT match's seats.
```

```
PROPERTY_ID: SPEC-18
TYPE: SPECIFIC
ENGLISH: Pause gating and the governance-pause rule. (a) While paused(): createMatch, createMatchmade, join*, joinFor, lockMatch, settle all fail; finalize, veto, dispute, dismissDispute, cancelMatch, abortMatch, withdraw* succeed when otherwise valid; bridgeJoin never reverts but refunds (JoinRefunded Paused) and takes no seat. (b) The guardian can never end a pause when pausedByGovernance is true. (c) The guardian cannot pause again within GUARDIAN_COOLDOWN of the previous pause ending. (d) A guardian pause lasts at most GUARDIAN_PAUSE. (e) extendPause never shortens pausedUntil.
SOLIDITY_SKETCH:
  // pause handlers: bool gov = escrow.pausedByGovernance(); bool wasPaused = escrow.paused();
  // pranked as guardian: try escrow.unpause() { if (wasPaused && gov) t(false, "guardian lifted a governance pause"); } catch {}
  // guardian pause(): try { gte(block.timestamp, prevPausedUntil + GUARDIAN_COOLDOWN or prevPausedUntil==0) ; eq(pausedUntil, block.timestamp + GUARDIAN_PAUSE); t(!pausedByGovernance) } catch {}
  // extendPause (timelock): try { gte(pausedUntilAfter, pausedUntilBefore); t(pausedByGovernance) } catch {}
  // gating: a join / create / lock / settle that returns while paused() -> t(false)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: pausedUntil, pausedByGovernance, paused()
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: invariant-context.md (I-14 / G-30 now enforced, `GovernancePause`); `ExpiringPause` NatSpec ("A pause governance extended is governance's to end: a compromised guardian must not undo it", "it cannot pause again for GUARDIAN_COOLDOWN"); GameEscrow `_isGuardian` block NatSpec on what a pause halts.
RATIONALE: Pause template (G-03 state machine). One subtle case: a guardian pause being extended by governance converts it, via `extendPause`, to a governance pause (pausedByGovernance=true), and a LATER guardian `pause()` after expiry resets it to false. Test (b) across expiry: after a governance pause expires naturally the flag is stale-true, so the guardian cannot call `unpause` (needs paused()) but also `pause()` resets it, which is fine. Do not assert on the stale flag when not paused.
```

```
PROPERTY_ID: SPEC-19
TYPE: SPECIFIC
ENGLISH: Pull-payment correctness. withdraw / withdrawFor / withdrawToBridge pay exactly the account's withdrawable balance, zero it, lower totalOwed by exactly that amount, and lower the escrow's ETH balance by exactly that amount. withdrawFor works only as the account itself, and refuses 0 < balance < MIN_WITHDRAW_FOR.
SOLIDITY_SKETCH:
  S before: w = withdrawable[a], owed, balance(escrow), balance(to)
  after: eq(withdrawable[a], 0); eq(owedBefore - owedAfter, w); eq(escrowBalBefore - escrowBalAfter, w);
         eq(balance(to) after - before, w)       // to is an Actor or EOA that can receive; receiving is safe to assert
  // withdrawFor by a non-account: try { t(false) } catch {}
  // withdrawFor with 0 < w < MIN: try { t(false) } catch {}
GHOST_NEEDS: none
SNAPSHOT_NEEDS: withdrawable of account, totalOwed, ETH balance of escrow and of `to`
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `PullPayable` code and NatSpec ("every credit and every withdrawal goes through the two functions below"; `withdrawFor`: "Not open to anyone"; MIN_WITHDRAW_FOR docs).
RATIONALE: T-04 on the ledger. The `to` receiver must not be the escrow, a session account with a rejecting fallback, or any address that re-enters; restrict `to` to Actor/EOA/receiver-accepting accounts so the receipt can be asserted.
```

```
PROPERTY_ID: SPEC-20
TYPE: SPECIFIC
ENGLISH: bridgeJoin never loses or mints value. For a call with value v for player p: the escrow's ETH balance rises by exactly v. If the seat cannot be taken, p is credited all of v (totalOwed += v, totalEscrowed unchanged, no seat). If it can, a seat is taken, totalEscrowed += stake, and the excess v - stake is credited to p. A zero player reverts; any other input from the receiver does not revert.
SOLIDITY_SKETCH (bridge handler around receiver.handleV3AcrossMessage, or escrow.bridgeJoin pranked as receiver):
  S before: balance(escrow), totalOwed, totalEscrowed, hasSeat(id,p), withdrawable[p]
  eq(balAfter - balBefore, v);
  if (seated) { eq(escrowedAfter - escrowedBefore, stake); eq(owedAfter - owedBefore, v - stake); }
  else        { eq(escrowedAfter, escrowedBefore);          eq(owedAfter - owedBefore, v); }
  // the receiver path must not revert for a well-formed message: if (rx reverted) t(false)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: as above
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `bridgeJoin` NatSpec: "for any player but zero it then never reverts: the stake has already left its chain ... all of it is credited to the player here instead ... More than the stake takes the seat and credits the player the rest."
RATIONALE: Bridge template (conservation of attested value). Not covered by any existing Foundry invariant (x-ray gap). The roster (SPEC-10) and the JoinFailure order are exercised through the same call.
```

---

## C. StakedLms (staking / token / votes)

```
PROPERTY_ID: SPEC-21
TYPE: GLOBAL
ENGLISH: sLMS is a 1:1 wrapper and the LMS backing is never short. The vault's LMS balance, net of donated LMS and plus swept strays, equals sLMS totalSupply plus totalUnstaking. Always LMS.balanceOf(vault) >= totalSupply + totalUnstaking. Hence no first-depositor or donation inflation is possible: an LMS donation changes neither supply nor any redemption.
SOLIDITY_SKETCH:
  function property_stakedLmsBacked() public returns (bool) {
      uint256 owedLms = stakedLms.totalSupply() + stakedLms.totalUnstaking();
      uint256 bal = lms.balanceOf(address(stakedLms));
      return bal >= owedLms && bal == owedLms + ghosts.stakedLmsDonatedLms - ghosts.stakedLmsSwept;
  }
  // handlers: stakedLms_donateLms adds to donated; stakedLms_sweepStray adds returned amount to swept
GHOST_NEEDS: uint256 stakedLmsDonatedLms; uint256 stakedLmsSwept
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: StakedLms NatSpec: "Stake LMS, receive sLMS one for one", "The LMS backing sLMS is totalSupply; with totalUnstaking that is everything owed. LMS sent here directly is neither, and governance can sweep it."
RATIONALE: Replaces V-06 (share inflation): there is no share price, so the equivalent attack is a donation breaking the 1:1 relation. The ghost form catches a deposit that mints more than it transfers (fee-on-transfer) or a claim that pays more than recorded; the >= form alone would hide a shortfall covered by a donation. Not purely a restatement of the existing StakedLmsInvariant if that is >=.
```

```
PROPERTY_ID: SPEC-22
TYPE: SPECIFIC
ENGLISH: sweepStray removes exactly the excess and never touches staked or unstaking LMS. After a successful sweep the vault's LMS balance equals totalSupply + totalUnstaking exactly, and the recipient gains exactly the amount. It reverts only when there is nothing to sweep.
SOLIDITY_SKETCH (timelock-pranked handler):
  S before: bal, supply, unstaking, balance(to)
  try sweepStray(to) returns (amt) { eq(amt, balBefore - supply - unstaking); eq(lms.balanceOf(vault), supply + unstaking); eq(lms.balanceOf(to) after - before, amt); }
  catch { /* only legal if balBefore == supply + unstaking, i.e. NothingToWithdraw */ }
GHOST_NEEDS: none
SNAPSHOT_NEEDS: vault LMS balance, supply, totalUnstaking, receiver LMS balance
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec: "Staked and unstaking LMS cannot be touched."
RATIONALE: A trusted-role action, so the property is about the formula, not the permission. An underflow here (`balance - supply - unstaking`) would signal SPEC-21 broke first.
```

```
PROPERTY_ID: SPEC-23
TYPE: GLOBAL
ENGLISH: The unstake queue is internally consistent. totalUnstaking equals the sum of every account's unstakeOf.assets; each pending unlockAt is at most requestTime + MAX_COOLDOWN; nothing unlocks earlier than the cooldown in force at its (last) request.
SOLIDITY_SKETCH:
  function property_unstakeQueue() public returns (bool) {
      uint256 s;
      for (a in actors + tracked) s += stakedLms.unstakeOf(a).assets;
      if (s != stakedLms.totalUnstaking()) return false;      // use <= if any account outside the tracked set can request
      for (a): if (assets != 0 && unlockAt < ghosts.lastRequestAt[a] + ghosts.cooldownAtRequest[a]) return false;
      return true; }
  // staker handlers write lastRequestAt / cooldownAtRequest[a] on each requestUnstake
GHOST_NEEDS: mapping(address=>uint256) lastRequestAt, cooldownAtRequest
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec on `requestUnstake`: "A second request adds to the first and restarts the cooldown for the whole amount"; `setCooldown`: "Changes the cooldown for future requests. Pending ones keep theirs."
RATIONALE: Template S-03 (cannot withdraw before lock ends). `claim` and `requestUnstake` handlers add the specific side below (SPEC-24).
```

```
PROPERTY_ID: SPEC-24
TYPE: SPECIFIC
ENGLISH: requestUnstake burns exactly `amount` sLMS, increases totalUnstaking and the account's pending by amount, sets unlockAt = block.timestamp + cooldown for the whole pending amount, and leaves the LMS balance unchanged. claim succeeds only when block.timestamp >= unlockAt, pays exactly the pending assets to the receiver, zeros the entry, and lowers totalUnstaking by it.
SOLIDITY_SKETCH:
  // request: eq(balanceOf after, before - amt); eq(totalUnstaking after - before, amt); eq(pending.assets after - before, amt);
  //          eq(pending.unlockAt, block.timestamp + stakedLms.cooldown()); eq(supplyBefore - supplyAfter, amt)
  // claim: try claim(r) returns (amt) { gte(block.timestamp, unlockBefore); eq(amt, assetsBefore); eq(lms.balanceOf(r) after - before, amt); eq(unstakeOf.assets, 0); }
  //        catch {}  and a "must succeed" probe when block.timestamp >= unlockAt && assets != 0 (liveness)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: sLMS balance/supply of caller, totalUnstaking, unstakeOf[caller], receiver LMS balance
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec on `requestUnstake` ("burns the sLMS at once ... `claim` returns the LMS once the cooldown has passed") and `claim`.
RATIONALE: Template S-03 / S-05. Note the griefing edge to keep in mind: anyone can call `depositFor`, but only msg.sender can request. A third party cannot restart another's cooldown, so assert that unstakeOf[x].unlockAt of an account other than the caller never changes in any call.
```

```
PROPERTY_ID: SPEC-25
TYPE: GLOBAL
ENGLISH: Reward solvency. The ETH in the vault covers every account's earned rewards plus the unpaid remainder of the stream. rewardPerShare never decreases.
SOLIDITY_SKETCH:
  function property_rewardsSolvent() public returns (bool) {
      uint256 sumEarned;
      for (a in actors + tracked) sumEarned += stakedLms.earned(a);
      uint64 last = stakedLms.lastAccrual(); uint64 fin = stakedLms.periodFinish();
      uint256 remaining;
      if (last < fin) {
          uint256 supply = stakedLms.totalSupply();
          uint256 until = supply == 0 ? last : (block.timestamp < fin ? block.timestamp : fin);
          remaining = (uint256(fin - until) * stakedLms.rewardRate()) / 1e27;
      }
      return address(stakedLms).balance >= sumEarned + remaining
          && stakedLms.rewardPerShare() >= ghosts.lastRewardPerShare;       // ghost updated in hook
  }
GHOST_NEEDS: uint256 lastRewardPerShare (updated after every call)
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec: "rewardPerShare only ever grows" and "ETH that arrives with no stakers waits for the first ones rather than being lost"; floors are always in the contract's favour, so earned + remaining <= deposited <= balance.
RATIONALE: Template S-02/S-06 (distributed <= allocated). The sum is over a SUBSET of holders; the inequality holds for any subset. Beware the `last >= fin` and `supply == 0` branches mirrored from `rewardPerShare` / `_accrue`. Differs from the existing RewardsInvariant: it includes the not-yet-accrued stream tail, which is where a depositRewards rounding error (rate floor, `unpaid` recomputed from a floored rate) would show.
```

```
PROPERTY_ID: SPEC-26
TYPE: SPECIFIC
ENGLISH: No state change can transfer unearned rewards. Across any single call, for every tracked account X other than the caller of claimRewards, earned(X) does not change at that instant; for the claimant it falls to zero, and the vault's ETH falls by exactly the amount paid. In particular deposit, depositFor, requestUnstake, sLMS transfer, depositRewards and FeeRouter.harvest (which calls depositRewards) leave every earned(X) unchanged within the call.
SOLIDITY_SKETCH (wrap every StakedLms handler plus feeRouter_harvest, harvest through the router):
  S before: earned(X) for X in actors, ETH balance of vault
  after: for X: if (!(claimant && X == caller)) eq(earned(X) after, earned(X) before);
         claimant: eq(earned(caller), 0), eq(vaultEthBefore - vaultEthAfter, amountPaid), eq(amountPaid, earnedBefore(caller))
  // claimRewards reverts with NothingToWithdraw iff earned == 0 (probe with try/catch)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: earned(actor) for each actor, vault ETH balance
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec: "settling happens in `_update`, before any balance moves, so a mint, burn or transfer can never carry rewards earned by someone else", and the whole "stake, call harvest and take a full share ... in a single transaction" paragraph (anti-sniping).
RATIONALE: Anti-sniping is the design goal of the streaming. Same-timestamp equality is exact because `earned` and `_settle` use the same floor (`mulDiv(balance, rps - settledAt)`). Also covers `_update` ordering when from == to (self-transfer) and the self-delegation hook.
```

```
PROPERTY_ID: SPEC-27
TYPE: GLOBAL
ENGLISH: Voting power is conserved. No account's votes exceed sLMS totalSupply and the delegated votes plus undelegated balances equal totalSupply. A receiver with sLMS is never left undelegated by the protocol itself (explicit delegate(0) excepted).
SOLIDITY_SKETCH:
  function property_votesConserved() public returns (bool) {
      uint256 votes; uint256 undelegated;
      for (a in actors) { votes += stakedLms.getVotes(a); if (stakedLms.delegates(a) == address(0)) undelegated += stakedLms.balanceOf(a); }
      return votes + undelegated <= stakedLms.totalSupply()        // subset-safe
          && (ghosts.allHoldersTracked ? votes + undelegated == stakedLms.totalSupply() : true);
  }
  // also: for a in actors: stakedLms.getPastVotes(a, t) <= stakedLms.getPastTotalSupply(t) for ghosted t in the past
GHOST_NEEDS: set of delegatee addresses (if any non-actor can be delegated to); sLMS recipients registry
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: ERC20Votes semantics (OpenZeppelin): the sum of delegated units equals the delegators' balances; StakedLms NatSpec ("Every account that receives sLMS is self-delegated on receipt unless it already chose a delegate").
RATIONALE: Template G-01/G-02. Equality needs every holder and delegatee registered; the <= form is subset-safe. Votes are a timestamp clock here, so any past-vote check needs a ghosted past time strictly less than block.timestamp.
```

```
PROPERTY_ID: SPEC-28
TYPE: GLOBAL
ENGLISH: ETH stranded in the vault is bounded. After the stream has ended and every account has claimed, the vault holds at most donated ETH plus a small rounding dust.
SOLIDITY_SKETCH:
  // when block.timestamp >= periodFinish && periodFinish > lastAccrual-or-equal && supply > 0:
  uint256 stranded = address(stakedLms).balance - ghosts.stakedLmsDonatedEth - sumEarned;
  return stranded <= ghosts.accrualCount + actors.length + 1;     // ~1 wei per accrual and per account
GHOST_NEEDS: stakedLmsDonatedEth; accrualCount (count of state-changing StakedLms calls)
SNAPSHOT_NEEDS: none
PRIORITY: LOW
GUARANTEE: EXPLORATORY
EVIDENCE: none, inferred. NatSpec only says ETH that arrives with no stakers waits, not that dust is bounded.
RATIONALE: S-05/S-06 analogue (nothing left behind). With total sLMS around 1.6e24 and PRECISION 1e27, floor loss per accrual is < 1 wei, so a larger gap means rewards are lost. If a depositor stakes so much that supply*rate rounding swallows small deposits, the property flags it (an adversarial LMS-supply case worth a human look).
```

---

## D. Play-mining: RewardsDistributor, RewardVesting

```
PROPERTY_ID: SPEC-29
TYPE: GLOBAL
ENGLISH: Claims of an epoch never exceed its budget, and no wallet exceeds the wallet cap fixed for that epoch. Total granted across the program never exceeds the program budget, which never exceeds the funded PLAY_MINING_SHARE.
SOLIDITY_SKETCH:
  function property_playMiningBudget() public returns (bool) {
      for (e in feeEpochs) { uint256 s;
          for (a in actors) { uint256 amt = vesting.trancheOf(a, e).amount; s += amt;
              (, uint256 cap, bool fixed_) = rewards.rateOf(e);
              if (fixed_ && amt > cap) return false; }
          if (s > rewards.epochBudget(e)) return false; }
      return vesting.totalGranted() <= rewards.totalBudget() && rewards.totalBudget() <= PLAY_MINING_SHARE;
  }
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: RewardsDistributor NatSpec: "Each claim is a share of the epoch's fees times a rate of at most budget / fees, so the claims of an epoch add up to at most its budget"; "the four years together add up to `totalBudget`".
RATIONALE: Template S-06 (distributed <= allocated). Holds only if SPEC-13 and SPEC-14 hold; a failure here with those passing points at `_reward`/`_fixRate`. Pre-program epochs have a zero budget, so any tranche in one is itself a violation (fold into the check). The sum is over actors, which cover every fee payer in matchmade lobbies.
```

```
PROPERTY_ID: SPEC-30
TYPE: GLOBAL
ENGLISH: An epoch's rate and wallet cap are fixed by its first claim. Once rateOf(e).fixed is true, (rate, walletCap) never change, including after setMaxRewardPerEth / setMaxRewardPerWalletPerEpoch. An epoch cannot be claimed before it ends or after claims close.
SOLIDITY_SKETCH:
  // hook: for e in feeEpochs: (r, c, f) = rewards.rateOf(e);
  //   if (f) { if (!ghosts.rateSeen[e]) {ghosts.rateSeen[e]=true; ghosts.r[e]=r; ghosts.c[e]=c;} else {eq(r,ghosts.r[e]); eq(c,ghosts.c[e]);} }
  // claim handler: success => block.timestamp >= (epoch+1)*epochLength && block.timestamp < claimsCloseAt(); isClaimed(player, epoch) afterwards (when paid>0)
GHOST_NEEDS: rateSeen[e], r[e], c[e]
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec: "The rate and the wallet cap are fixed by the first claim, so a later change to a cap cannot treat two claimants of one epoch differently."
RATIONALE: Fairness template. `config_secondary`-style governance calls on the rewards contract run as the timelock in the harness, so they happen between claims of the same epoch.
```

```
PROPERTY_ID: SPEC-31
TYPE: GLOBAL
ENGLISH: Vesting accounting. For every tracked (player, epoch): released <= vested(player, epoch) <= amount; vested is monotone in time and equals amount from vestingStart + 26 weeks; before vestingStart it is zero. totalReleased <= totalGranted, and the vesting contract always holds enough LMS: balance >= totalGranted - totalReleased. Sum of tranche amounts (tracked) <= totalGranted.
SOLIDITY_SKETCH:
  function property_vestingAccounting() public returns (bool) {
      uint256 sg; uint256 sr;
      for (a, e in tracked x feeEpochs) { t = vesting.trancheOf(a, e); v = vesting.vested(a, e);
          if (t.released > v || v > t.amount) return false;
          if (block.timestamp >= vesting.vestingStart(e) + 26 weeks && v != t.amount) return false;
          if (block.timestamp <= vesting.vestingStart(e) && v != 0) return false;
          if (v < ghosts.lastVested[a][e]) return false;
          sg += t.amount; sr += t.released; }
      return sr <= vesting.totalReleased() && sg <= vesting.totalGranted()
          && vesting.totalReleased() <= vesting.totalGranted()
          && lms.balanceOf(address(vesting)) >= vesting.totalGranted() - vesting.totalReleased();
  }
GHOST_NEEDS: lastVested[player][epoch]
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: RewardVesting NatSpec: "A tranche vests linearly over VESTING_DURATION, starting the moment its epoch ended"; `grant` NatSpec: "The distributor has already sent the LMS."; `release` formula.
RATIONALE: Template S-03/S-06 for the vesting leg. Includes the solvency of the grant (RewardsDistributor.claim transfers `reward` before `grant`, and `grant` may skip a zero amount; the totals must still agree: sum of non-skipped amounts == reward).
```

```
PROPERTY_ID: SPEC-32
TYPE: SPECIFIC
ENGLISH: release pays exactly the vested-minus-released amount to the player (never to the caller), once per unit of vesting. Calling it twice at the same timestamp pays nothing the second time (reverts NothingToRelease). Releasing a not-yet-vested tranche pays 0. LMS balance of the player rises by exactly amount, the vesting contract's falls by exactly amount, totalReleased rises by amount.
SOLIDITY_SKETCH:
  expected = sum over epochs (without duplicates) of releasable(player, e) before the call
  eq(lms.balanceOf(player) after - before, amount); eq(amount, expected);
  eq(vestingBalBefore - vestingBalAfter, amount); eq(totalReleasedAfter - totalReleasedBefore, amount);
  // duplicate epoch in the array: the second occurrence has releasable == 0 only because `released` was updated in the loop; amount must still equal the single-count expectation
GHOST_NEEDS: none
SNAPSHOT_NEEDS: lms balances of player and vesting, totalReleased, releasable per epoch
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: NatSpec: "Open to anyone: the LMS only ever goes to `player`."
RATIONALE: Template T-04 for the payout, with a duplicate-epoch probe (`epochs = [e, e]`) since `release` reads `releasable` per iteration and writes `released` per iteration.
```

---

## E. Token, router, governance, bridge-out

```
PROPERTY_ID: SPEC-33
TYPE: GLOBAL
ENGLISH: LMS supply is fixed and only ever burned. totalSupply never exceeds the initial supply and never rises; it falls only by burns the harness made (escrow burn on settle, ERC20Burnable burn / burnFrom); the sum of tracked LMS balances never exceeds totalSupply; address(0) holds none.
SOLIDITY_SKETCH:
  function property_lmsSupply() public returns (bool) {
      uint256 ts = lms.totalSupply();
      if (ts > LMS_SUPPLY || ts > ghosts.lastLmsSupply) return false;                       // monotone non-increasing
      if (ts != LMS_SUPPLY - ghosts.lmsBurned) return false;                                // burns tracked in handlers
      uint256 held;
      for (h in actors + [timelock, safe, rewards, vesting, reserve, stakedLms, escrow, feeRouter, bridgeReceiver, phase, outsider]) held += lms.balanceOf(h);
      return held <= ts && lms.balanceOf(address(0)) == 0;
  }
GHOST_NEEDS: lastLmsSupply (hook), lmsBurned (burn handlers and finalize with a discount)
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: LmsToken NatSpec: "Fixed supply, minted once to `recipient`, with no owner and no mint function, so nobody can dilute stakers after launch."
RATIONALE: Token templates T-01, T-06. The `lmsBurned` exact form needs the burn amounts ghosted; if too costly, keep the monotone and cap clauses.
```

```
PROPERTY_ID: SPEC-34
TYPE: SPECIFIC
ENGLISH: FeeRouter.harvest splits exactly and leaves nothing behind. Let A = escrow credit pulled plus any ETH already held. Then toStakers = floor(A * stakerBps / 10000), toTreasury = A - toStakers; the vault receives toStakers as a reward deposit (its ETH rises by toStakers), the treasury receives toTreasury, the router's ETH balance is zero afterwards, and the escrow's withdrawable[feeRouter] is zero. It reverts only when A == 0.
SOLIDITY_SKETCH:
  S before: A = withdrawable[feeRouter] + balance(feeRouter), vaultEth, treasuryEth (treasury is an EOA/Actor that can receive), stakerBps
  try feeRouter.harvest() returns (amt) {
      eq(amt, A); toS = A*bps/10000;
      eq(vaultEthAfter - vaultEthBefore, toS); eq(treasuryEthAfter - treasuryEthBefore, A - toS);
      eq(address(feeRouter).balance, 0); eq(escrow.withdrawable(address(feeRouter)), 0);
  } catch { /* legal only if A == 0, or the treasury refused ETH (TransferFailed) */ }
GHOST_NEEDS: none
SNAPSHOT_NEEDS: ETH balances of feeRouter, vault, treasury; escrow.withdrawable[feeRouter]
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: FeeRouter NatSpec: "Holds no ETH between transactions ... `harvest` splits whatever balance it finds, so nothing that arrived another way can stay."
RATIONALE: Router conservation. `feeRouter_donateETH` selfdestructs ETH in, so the global form is `balance == 0` ONLY right after a harvest; globally the router's balance equals ghost-donated ETH not yet harvested (EXPLORATORY global variant: `balance(feeRouter) == ghosts.routerDonatedPending`). Treasury changes through `setTreasury` mean you must read the treasury at the call.
```

```
PROPERTY_ID: SPEC-35
TYPE: SPECIFIC
ENGLISH: Governor safety. (a) A proposal in state Succeeded, Queued or Executed has forVotes + abstainVotes >= quorum(snapshot) >= quorumFloor(snapshot), and forVotes > againstVotes. (b) Total votes cast on a proposal never exceed getPastTotalSupply(snapshot). (c) Execution happens only at or after the timelock eta. (d) A proposal that was defeated or cancelled never executes.
SOLIDITY_SKETCH:
  for p in proposals: st = governor.state(p.id); snap = governor.proposalSnapshot(p.id);
      (againstV, forV, abstainV) = governor.proposalVotes(p.id);
      if (st in {Succeeded, Queued, Executed}) { gte(forV + abstainV, governor.quorum(snap)); gte(governor.quorum(snap), governor.quorumFloor(snap)); gt(forV, againstV); }
      if (snap < block.timestamp) try stakedLms.getPastTotalSupply(snap) returns (uint256 ts) { lte(forV + againstV + abstainV, ts); } catch {}
  // execute handler: success => block.timestamp >= governor.proposalEta(id); ghost wasDefeatedOrCanceled[id] => never Executed
GHOST_NEEDS: wasDefeatedOrCanceled[id]
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: LmsGovernor NatSpec: "`quorum` is therefore the larger of that fraction and `quorumFloor`"; "Voting power is read from StakedLms ... at the proposal's snapshot, so tokens bought or staked after a proposal is made cannot vote on it". OpenZeppelin GovernorCountingSimple / TimelockControl semantics for (a), (c), (d).
RATIONALE: Template G-03/G-04/G-05. Part (a)'s floor clause is the protocol-specific guarantee ("one proposer could pass anything alone" must stay impossible). (b) is the flash-stake defence. Part (d): a vetoed (`phase.cancel`) proposal must show Canceled and never Executed.
```

```
PROPERTY_ID: SPEC-36
TYPE: SPECIFIC
ENGLISH: The Safe's phase is bounded. (a) schedule / scheduleBatch / cancel through MultisigPhase succeed only for the Safe, only before phaseEnd, and (schedule) never for a target of the timelock, a transferOwnership / renounceOwnership selector, any call to the LMS token, RewardsDistributor.sweep, StakedLms.sweepStray, LiquidityReserve.setRecipient, or BridgeJoinReceiver.recover of the LMS token. (b) After phaseEnd and retire(), the phase holds neither PROPOSER nor CANCELLER role, forever.
SOLIDITY_SKETCH:
  // forbidden modes of multisig_secondary: try phase.schedule(...forbidden...) { t(false, "forbidden call scheduled"); } catch {}
  // also scheduleBatch with one forbidden entry among clean ones
  // global:
  function property_phaseRetired() public returns (bool) {
      if (ghosts.phaseRetired) return !timelock.hasRole(timelock.PROPOSER_ROLE(), address(phase)) && !timelock.hasRole(timelock.CANCELLER_ROLE(), address(phase));
      return true; }
  // post-end: any call by safe to schedule/cancel: try { t(false) } catch {}
GHOST_NEEDS: phaseRetired (set when retire() succeeds)
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: invariant-context.md ("MultisigPhase._checkCall now also refuses anything that moves LMS"); MultisigPhase NatSpec ("it ends on a date anyone can read here", "no call to the token at all", "the Safe's veto ends on a date").
RATIONALE: Governance training-wheels template. No existing Foundry coverage (x-ray gap). Forbidden-call matching is by selector, so a bypass could come from: a forbidden selector placed in a batch after a clean call; `data.length < 4`; or a `recover` payload shorter than 36 bytes (the decode is skipped). Include those shapes in the clamped handler, and `recover(WETH-like other token)` as an allowed control case.
```

```
PROPERTY_ID: SPEC-37
TYPE: SPECIFIC
ENGLISH: LiquidityReserve releases LMS only to an approved recipient, and the vault (StakedLms), the Safe, the reserve itself and the zero address can never be approved. Reserve LMS cannot be staked by it: its sLMS balance changes only by someone else's depositFor. After release, the reserve's LMS falls by exactly amount and the recipient's rises by amount.
SOLIDITY_SKETCH:
  global: !reserve.isApproved(address(stakedLms)) && !reserve.isApproved(safe) && !reserve.isApproved(address(reserve)) && !reserve.isApproved(address(0))
  ghost-based: lms.balanceOf(reserve) == LIQUIDITY_SHARE - ghosts.reserveReleased + ghosts.reserveDonatedIn
  release handler: eq(lms.balanceOf(reserve) before - after, amount); t(reserve.isApproved(to)) in success branch
GHOST_NEEDS: reserveReleased; reserveDonatedIn (any actor transfers of LMS to the reserve)
SNAPSHOT_NEEDS: LMS balances of reserve and recipient
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: LiquidityReserve NatSpec: "the vault, the Safe and the reserve itself can never be approved, so the plain routes to staking it are closed even to a proposal."
RATIONALE: The reserve is the governance-capture barrier for 5% of supply. Note `release(to, amount)` by an approved recipient that is itself a staker contract is outside the contract's control (the recipient is trusted); only the listed forbidden recipients are guaranteed.
```

```
PROPERTY_ID: SPEC-38
TYPE: SPECIFIC
ENGLISH: Bridge-out is signed, single-use and exact. withdrawToChainFor with a valid signature moves the player's entire escrow balance and nothing else: nonces[player] rises by exactly 1; the escrow's withdrawable[player] is zero; escrow ETH and totalOwed each fall by the amount; the SpokePool receives exactly the amount; fee (amount - outputAmount) <= maxFee. A replayed signature, a wrong chain id, an expired deadline, a signature by someone other than the player, or any altered quote / recipient / destination must fail. The receiver holds no player funds afterwards.
SOLIDITY_SKETCH:
  success: S before: w = withdrawable[player], nonce, escrow ETH, totalOwed, acrossPool ETH/WETH received
    eq(nonces[player] after - before, 1); eq(withdrawable[player], 0); eq(owedBefore - owedAfter, w); eq(amount, w);
    lte(amount - q.outputAmount, w_.maxFee); gte(amount, MIN_WITHDRAW_FOR)
  bridge_withdrawToChainFor_clamped (must fail): replay, tamper any one field of Withdrawal or Quote, wrong signer, wrong hub id, past deadline -> try { t(false) } catch {}
GHOST_NEEDS: none
SNAPSHOT_NEEDS: described above
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: invariant-context.md (G-46: the player signs the Quote too, "The submitter chooses nothing"); BridgeJoinReceiver NatSpec ("bridges a player's whole escrow balance to a chain and address they signed for").
RATIONALE: Signed-message bridge template. Cover each field of `Withdrawal` AND `Quote` since the typehash nests Quote; a missing field in the struct hash is the classic bug.
```

```
PROPERTY_ID: SPEC-39
TYPE: GLOBAL
ENGLISH: Snapshotted terms are immutable. For every termsId in 1..termsCount, the stored Terms never change; each match's terms (rulesHash, treasury, feeBps, minSeats, windows, payoutBps) equal what the config held when the lobby opened, however config changes afterwards. termsCount is non-decreasing and a termsId is never re-pointed.
SOLIDITY_SKETCH:
  function property_termsImmutable() public returns (bool) {
      for (id = 1; id <= escrow.termsCount(); ++id) { h = keccak256(abi.encode(escrow.getTerms(id)));
          if (ghosts.termsHash[id] != 0 && ghosts.termsHash[id] != h) return false; ghosts.termsHash[id] ... (record in hook) }
      return escrow.termsCount() >= ghosts.lastTermsCount; }
  // createMatch handlers: record terms at creation for the match; for every match getMatchTerms(id) hash == recorded
GHOST_NEEDS: mapping(uint32=>bytes32) termsHash; mapping(bytes32=>bytes32) termsHashAtCreate; lastTermsCount
SNAPSHOT_NEEDS: config params at creation
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: GameEscrow `Terms` NatSpec: "fixed from the config at that moment so a governance change cannot alter it for a player who already staked ... Never modified once stored."
RATIONALE: The harness lets the config move to boundaries mid-match (harness fact 4); this is the stated defence. Note what is NOT snapshotted: `lmsToken`, `lmsPerEthDiscount`, `attestorSet` (versioned), `sequencerUptimeFeed`, `bridgeReceiver`, `matchmaker`: those are live reads (see SPEC-06 note).
```

```
PROPERTY_ID: SPEC-40
TYPE: GLOBAL
ENGLISH: Match randomness and result data are write-once per phase. The seed is zero until the match is Live and never changes afterwards; historyRoot, rounds, rankingHash and transcriptHash are set only when the status becomes Proposed and do not change until the match is Settled or Cancelled; the oracle and attestorSetVersion are fixed at lock. fulfillRandomness is accepted only from the oracle recorded at lock, once.
SOLIDITY_SKETCH:
  hook per match: when status >= Live and seed was recorded: eq(info.seed, ghosts.seed[id]);
                  when status == Proposed: eq(rankingHash, ghosts.rankingHash[id]) etc.;
                  when status >= Pending: eq(info.oracle, ghosts.oracle[id]); eq(info.attestorSetVersion, ghosts.setVersion[id]);
  // double fulfillRandomness via the mock coordinator: try { t(false) } catch {}
GHOST_NEEDS: seed[id], rankingHash[id], historyRoot[id], oracle[id], setVersion[id]
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `fulfillRandomness` NatSpec: "Only a Pending match takes a seed, so a second answer, or a late one for a match already cancelled, reverts. The oracle is the one the match asked, not the current one."
RATIONALE: Randomness-integrity template (the oracle can be replaced by `config_secondary`/`vrf` settings mid-match). A later oracle change must not strand a Pending match: add a liveness probe, "after config.setRandomnessOracle(new), the OLD oracle's fulfill still moves a Pending match to Live".
```

---

## Notes for the pipeline

- Total proposed: 40 properties (SPEC-01 .. SPEC-40).
- HIGH priority, highest expected yield: SPEC-01/02 (solvency decomposition), 05/06/07 (conservation and exit liveness), 16 (challenge window), 18 (pause rules), 20 (bridgeJoin), 21/25/26 (stake backing, reward solvency, anti-sniping), 29/31 (budget and vesting), 35/36 (governor and MultisigPhase), 38 (bridge-out signature coverage).
- EXPLORATORY: SPEC-28 only. SPEC-06 and SPEC-39 each carry an EXPLORATORY sub-note (live reads of `lmsToken` after a config change); that sub-case is a trust-model gap, not a bug, if it fails only after a trusted-role action.
- Everything with a payable call asserts on the protocol side only (escrow, vault, router, vesting balances); only ETH or LMS an account RECEIVES is asserted.
- Not covered here (left to other agents): `SessionKeyDelegate`, `ZapJoin`, `ChainlinkVrfAdapter`, `SignatureLib` internals, `ProtocolConfig` parameter validation, `bridge_handleOnHeldEth_clamped` (EXPLORATORY by instruction, no property proposed).
