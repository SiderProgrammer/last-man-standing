# State Transition Mapper: findings (Last Man Standing)

Scope: transitions, postconditions, monotonicity, state sync only. Source read: GameEscrow, PullPayable, ExpiringPause, ProtocolConfig, StakedLms, RewardsDistributor, RewardVesting, FeeRouter, MultisigPhase, SessionKeyDelegate, BridgeJoinReceiver, LiquidityReserve, ChainlinkVrfAdapter, LmsGovernor, LmsToken (src wins over the stale x-ray).

## Step 1: state map (what MUST change / MUST NOT change)

Match machine (GameEscrow.MatchStatus). Legal edges, all others illegal:
None->Open (create*), Open->Pending (lockMatch), Open->Cancelled (cancelMatch), Pending->Live (fulfillRandomness), Pending->Cancelled (cancelMatch), Live->Proposed (settle), Live->Cancelled (cancelMatch, abortMatch), Proposed->Settled (finalize), Proposed->Cancelled (veto). Settled and Cancelled are absorbing.

| fn | must change | must NOT change |
|---|---|---|
| create/createMatchmade | matchNonce+1, new id Open, termsCount 0 or +1 | totalEscrowed, totalOwed, other matches |
| join/joinFor/joinWithLms*/bridgeJoin(seated) | seatCount+1, seat registered, totalEscrowed += paid, (LMS: totalLmsEscrowed += lmsUsed) | totalOwed (except bridge extra), other seats, stake/terms/maxSeats |
| bridgeJoin (refused) | withdrawable[player] and totalOwed += msg.value | totalEscrowed, seatCount, status |
| lockMatch | status Pending, oracle+attestorSetVersion snapshot, deadline = now+RANDOMNESS_TIMEOUT | seats, stake, totalEscrowed |
| fulfillRandomness | Live, seed set, deadline = now+settleWindow | everything money |
| settle | Proposed, historyRoot/rankingHash/transcriptHash/rounds/deadline | money, seats |
| finalize | Settled, totalEscrowed down, totalOwed up, epoch fees (matchmade only), LMS burned | stake, seats |
| veto/abort/cancel | Cancelled, each seat credited stake-discount.eth, LMS pushed back, totalEscrowed down | epoch fees, LMS supply (no burn) |
| dispute | disputed=true (first), deadline += DISPUTE_EXTENSION (first only) | status, money |
| dismissDispute | disputed=false, deadline = max(deadline-EXT, now) | status, money |
| withdraw/withdrawFor/withdrawToBridge | withdrawable[acct]=0, totalOwed -= amount | totalEscrowed, other accounts |
| pause/extendPause/unpause | pausedUntil, pausedByGovernance | everything else |

Other machines: StakedLms reward stream (rewardRate, periodFinish, lastAccrual, rewardPerShareStored) and unstake queue; RewardsDistributor epoch rate (unfixed -> fixed) and per-(player,epoch) claimed flag; RewardVesting tranche (absent -> granted -> released <= amount); SessionKeyDelegate session (none -> active -> expired/revoked, spent <= spendCap, nonce); BridgeJoinReceiver nonce; MultisigPhase (in phase -> over -> retired).

Harness note: `Snapshots.State` and `Ghosts` are placeholders. Every SNAPSHOT_NEEDS below is new State fields. "Per-match" snapshots should be taken for the single match the handler touches (plus a `statusBefore[]` array over `matchIds` only where noted). All "specific" properties are `internal`, called after the protocol call. Time-dependent ones read `block.timestamp`.

---

## A. Match state machine (GameEscrow)

```
PROPERTY_ID: ST-01
TYPE: SPECIFIC (every escrow handler incl. escrow_secondary, bridge_*, session_*, after the call)
ENGLISH: Across any single call, every match's status moves only along a legal edge of the match graph (None->Open->Pending->Live->Proposed->Settled, plus Open/Pending/Live/Proposed -> Cancelled). No skipped state, no edge out of Settled or Cancelled, no edge back to None, and no call changes the status of more than the matches it is meant to touch.
SOLIDITY_SKETCH:
  for i in matchIds(at snapshot time): b = before.status[i]; a = escrow.getMatch(id).status;
    if (a == b) continue;
    legal = (b==None&&a==Open)||(b==Open&&(a==Pending||a==Cancelled))||(b==Pending&&(a==Live||a==Cancelled))
         ||(b==Live&&(a==Proposed||a==Cancelled))||(b==Proposed&&(a==Settled||a==Cancelled));
    t(legal);
  also: number of matches whose status changed in one call <= 1 (each fn touches one match).
GHOST_NEEDS: none
SNAPSHOT_NEEDS: statusBefore[] indexed by matchIds position (copy at snapshotBefore), matchIds.length before
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: The MatchStatus enum natspec and every function's _inStatus/_open/_requireStatus guard in GameEscrow.sol; cancelMatch reverts WrongStatus for Proposed/Settled/Cancelled; Settled/Cancelled have no outgoing guard.
RATIONALE: The status gates all fund movement; one illegal edge (for example Settled->Cancelled) would double-credit a pool.
```

```
PROPERTY_ID: ST-02
TYPE: GLOBAL
ENGLISH: A match that reached Settled or Cancelled is frozen: its full MatchInfo, seat list and per-seat discounts never change again.
SOLIDITY_SKETCH:
  for id in matchIds: if (ghosts.frozenFp[id] != 0) t(fingerprint(id) == ghosts.frozenFp[id]);
  fingerprint = keccak256(abi.encode(escrow.getMatch(id), escrow.getSeats(id)))
  (ghost set by a post-call hook the first time status is observed Settled/Cancelled; global read only)
GHOST_NEEDS: mapping(bytes32=>bytes32) frozenFp; hook `_freezeTerminal()` called at the end of every escrow-touching handler
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: Settled = "Result final and payouts credited", Cancelled = "every stake is refundable" (enum natspec); no function has a write path for these statuses.
RATIONALE: Catches late writes through bridgeJoin, joinFor, dispute, dismissDispute or fulfillRandomness on a finished match, which would not move the status but would corrupt seatCount/deadline/disputed.
```

```
PROPERTY_ID: ST-03
TYPE: GLOBAL
ENGLISH: Fields fixed at creation never change: stake, termsId, maxSeats, matchmade, joinDeadline. Stored Terms (by termsId) are never modified, and termsCount is the latest id with ids dense from 1.
SOLIDITY_SKETCH:
  for id in matchIds: m = getMatch(id); t(m.stake==ghosts.stake[id] && m.termsId==ghosts.termsId[id] && m.maxSeats==ghosts.maxSeats[id] && m.matchmade==ghosts.matchmade[id] && m.joinDeadline==ghosts.joinDeadline[id]);
  for tid in 1..termsCount: t(keccak256(abi.encode(getTerms(tid))) == ghosts.termsHash[tid]);
GHOST_NEEDS: per-match creation record; termsHash[tid] recorded the first time it is seen (created in create handlers)
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: Terms natspec "Never modified once stored"; "fixed from the config at that moment so a governance change cannot alter it for a player who already staked". Harness fact 4: config_secondary moves config under running matches.
RATIONALE: This is the property that the deliberate config-change fuzzing is for. A leaked config read in lock, settle, finalize or _refundAll (for example reading current feeBps instead of terms) would show up as a Terms/behaviour mismatch (see ST-12).
```

```
PROPERTY_ID: ST-04
TYPE: GLOBAL
ENGLISH: Seat bookkeeping is consistent: seatCount == getSeats().length <= maxSeats; every listed seat satisfies hasSeat and has a distinct number; seatNumber(seat i) == i+1 (observable via settle's permutation check); status None implies seatCount 0; seatCount is non-decreasing while Open and frozen afterwards.
SOLIDITY_SKETCH:
  for id: m=getMatch(id); s=getSeats(id); eq(m.seatCount, s.length); lte(m.seatCount, m.maxSeats);
    for k: t(escrow.hasSeat(id,s[k])); for j<k: t(s[j]!=s[k]);
    if (m.status != Open) eq(m.seatCount, ghosts.seatCountAtClose[id]) ; // ghost recorded at first non-Open observation
GHOST_NEEDS: seatCountAtClose[id] (set by hook when status first seen != Open)
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: _seat is the only writer: pushes to matchSeats and sets seatNumber=count+1 together; "Seat numbers run from 1 to at most 256" comment in _assertSeatSet (dispute bitmask relies on it).
RATIONALE: dispute and settle use a 256-bit seat mask; an inconsistent seat count would let a dispute bit collide or a ranking pass _assertSeatSet incorrectly.
```

```
PROPERTY_ID: ST-05
TYPE: SPECIFIC (after escrow_join*, escrow_joinFor*, escrow_joinWithLms*, zap_*, bridge_fill* when seated)
ENGLISH: A successful seat on match M: seatCount_M +1, the joiner (and only the joiner) newly hasSeat, totalEscrowed rises by exactly the ETH the seat paid (stake, or stake minus discount for LMS joins), totalOwed unchanged (bridgeJoin: unchanged except the `extra` credit), M's status stays Open, and no other match or seat changes. For LMS joins totalLmsEscrowed rises by lmsUsed, seatDiscount(M,player).eth == stake - paid, and the escrow's LMS balance rises by lmsUsed.
SOLIDITY_SKETCH:
  eq(after.seatCount, before.seatCount+1); t(hasSeat(M,p)); eq(after.totalEscrowed - before.totalEscrowed, paid);
  eq(after.totalOwed, before.totalOwed + extra);  // extra = 0 except bridgeJoin msg.value > stake
  for every other actor q != p: t(hasSeat(M,q) == before.hasSeat[q]);
  LMS: eq(after.totalLmsEscrowed - before.totalLmsEscrowed, lmsUsed); eq(lms.balanceOf(escrow) delta, lmsUsed);
  eq(getSeatDiscount(M,p).eth, stake - paid)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: seatCountM, totalEscrowed, totalOwed, totalLmsEscrowed, lmsBalanceOfEscrow, hasSeat[actors] for M, status M
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: _seat: `totalEscrowed += paid`, `info.seatCount = seat + 1`; _joinWithLms updates seatDiscount, matchDiscount and totalLmsEscrowed together. Do not assert on actor ETH (harness fact 2); every quantity above is protocol-side.
RATIONALE: Pins the entry transition of the main aggregate; the discount path has the most coupled updates (four variables plus a token transfer).
```

```
PROPERTY_ID: ST-06
TYPE: SPECIFIC (after escrow_lockMatch*, escrow_lockAndSeed_clamped)
ENGLISH: A successful lock moves Open->Pending only for a lobby that is full OR past its joinDeadline, and only with seatCount >= terms.minSeats. After it: oracle == the config oracle read at that moment, attestorSetVersion == config.attestorSetVersion() read at that moment, deadline == block.timestamp + RANDOMNESS_TIMEOUT; seats, stake, totalEscrowed, totalOwed unchanged.
SOLIDITY_SKETCH:
  t(before.status==Open); t(before.seatCount == before.maxSeats || block.timestamp >= before.joinDeadline);
  gte(after.seatCount, getMatchTerms(M).minSeats); eq(after.status, Pending);
  eq(after.attestorSetVersion, config.attestorSetVersion()); eq(after.oracle, config.randomnessOracle());
  eq(after.deadline, block.timestamp + RANDOMNESS_TIMEOUT); eq(totalEscrowed after, before)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: MatchInfo of M, totalEscrowed, totalOwed
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: lockMatch code and natspec "Randomness is requested only after the seat list is final"; "oracle and attestor set when it locks" (ProtocolConfig natspec).
RATIONALE: The snapshot is what keeps later oracle/attestor rotations from stranding or retargeting a running match.
```

```
PROPERTY_ID: ST-07
TYPE: SPECIFIC (after fulfillRandomness via vrf/coordinator handlers)
ENGLISH: Seed delivery moves Pending->Live exactly once: a second delivery for the same match, or one for a Cancelled match, is refused and leaves the match unchanged. After success: seed == keccak256(abi.encode(randomness, matchId)) (never the raw word), deadline == now + terms.settleWindow, nothing monetary changes.
SOLIDITY_SKETCH:
  success: eq(after.seed, keccak(abi.encode(word, M))); eq(after.deadline, block.timestamp + terms.settleWindow); eq(after.status, Live);
  repeat/late delivery (try/catch in the handler, e.g. vrf deliver again): in success branch -> t(false); fingerprint(M) unchanged on revert.
GHOST_NEEDS: lastWord[M]
SNAPSHOT_NEEDS: MatchInfo M
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: fulfillRandomness natspec "a second answer, or a late one for a match already cancelled, reverts"; seed binding comment.
RATIONALE: A double seed would let a match restart play with a different seed after rounds are committed.
```

```
PROPERTY_ID: ST-08
TYPE: SPECIFIC (after escrow_settle*, escrow_finalize*)
ENGLISH: settle (Live->Proposed): ranking is exactly the seat set (permutation), rankingHash == keccak256(abi.encode(ranking)), deadline == now + terms.challengeWindow, disputed == false, rounds in [1, 65535], and no money moves. A bad ranking (duplicate, stranger, wrong length, or signatures that are not a quorum of the match's snapshotted attestor set) must never be accepted.
SOLIDITY_SKETCH:
  settle ok: eq(after.status,Proposed); eq(after.rankingHash, keccak(abi.encode(ranking))); eq(after.deadline, block.timestamp+terms.challengeWindow); t(!after.disputed);
             eq(totalEscrowed,totalOwed unchanged); permutation(ranking, getSeats(M));
  settle_badRanking_clamped / wrong-version signatures: in success branch -> t(false)
GHOST_NEEDS: originalDeadline[M] (set here, used by ST-10)
SNAPSHOT_NEEDS: MatchInfo M, totalEscrowed, totalOwed
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: _assertSeatSet natspec "without this a quorum could redirect the pool to addresses that never staked"; settle code.
RATIONALE: The ranking is the only attacker-influenceable payout input.
```

```
PROPERTY_ID: ST-09
TYPE: SPECIFIC (after escrow_finalize*)
ENGLISH: finalize (Proposed->Settled) happens only at/after the (possibly extended) deadline and only with the stored ranking. Postconditions: totalEscrowed falls by exactly stake*seatCount - discount.eth; totalOwed rises by exactly the same amount; each of ranking[0..schedule.length) is credited floor(distributable * bps / 10000) (zero amounts skipped); every seat outside the paid positions (and not the treasury) has unchanged withdrawable; totalLmsEscrowed falls by discount.lms and LMS totalSupply falls by discount.lms (burn); a finalize is refused (no state change) before the deadline, with a different ranking, or while the sequencer is down/in grace.
SOLIDITY_SKETCH:
  gte(block.timestamp, before.deadline); eq(after.status, Settled);
  uint spent = stake*seatCount - discEth;
  eq(before.totalEscrowed - after.totalEscrowed, spent); eq(after.totalOwed - before.totalOwed, spent);
  pool = stake*seatCount; dist = pool - pool*feeBps/1e4;
  for i<schedule.length: amt=dist*bps[i]/1e4; eq(after.withdrawable[ranking[i]] - before.withdrawable[ranking[i]], amt + (ranking[i]==treasury ? remainder : 0));
  for seats beyond schedule (not treasury): eq(after.withdrawable[seat], before.withdrawable[seat]);
  eq(before.totalLmsEscrowed - after.totalLmsEscrowed, discLms); eq(before.lmsSupply - after.lmsSupply, discLms);
  wrong ranking / early / sequencer down: in success branch -> t(false)
GHOST_NEEDS: none (discount.eth/lms read from getSeatDiscount sums before the call)
SNAPSHOT_NEEDS: MatchInfo M, totalEscrowed, totalOwed, totalLmsEscrowed, lms.totalSupply(), withdrawable[actors, treasury] , Terms of M
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: finalize code and natspec ("Not while the L2 sequencer is down", "pays out once its challenge window has closed unvetoed"); `_distribute` pays bps of `distributable`, remainder to treasury; docs "burned when it settles".
RATIONALE: The single most value-bearing transition. Note the treasury may equal a seated actor under config_secondary, hence the treasury exclusion.
```

```
PROPERTY_ID: ST-10
TYPE: SPECIFIC (after escrow_dispute*, dismissDispute and veto in escrow_secondary / guardian handlers)
ENGLISH: Dispute extension state machine. While Proposed: let O = the deadline set at settle. (a) disputed==false => deadline >= O; (b) disputed==true => deadline >= O + DISPUTE_EXTENSION; (c) dispute by seat X sets disputed, adds the extension only if it was not already disputed (a second seat's dispute leaves deadline unchanged); (d) the same seat cannot dispute twice (refused); (e) dismissDispute requires disputed, sets disputed=false and deadline == max(deadline_before - DISPUTE_EXTENSION, block.timestamp); (f) dispute/dismiss/veto are refused when block.timestamp >= deadline; (g) non-seated callers cannot dispute.
SOLIDITY_SKETCH:
  after dispute: t(after.disputed); if(!before.disputed) eq(after.deadline, before.deadline+EXT) else eq(after.deadline, before.deadline);
  after dismiss: t(!after.disputed); eq(after.deadline, max(before.deadline-EXT, block.timestamp));
  global-ish in the same handler: if (status==Proposed) { t(after.deadline >= ghosts.originalDeadline[M]); if(after.disputed) gte(after.deadline, O+EXT); }
  repeat dispute by same seat / stranger: try/catch, success branch -> t(false); dispute with timestamp >= deadline -> t(false)
GHOST_NEEDS: originalDeadline[M] (from ST-08), disputedBy[M][actor] (ghost of successful disputes)
SNAPSHOT_NEEDS: MatchInfo M (deadline, disputed)
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: dispute natspec "The first open dispute extends the deadline; one already open does not extend it again", "each may dispute once"; dismissDispute natspec "the result goes back to its own challenge deadline"; code comment "Extended exactly once while disputed".
RATIONALE: A subtraction of DISPUTE_EXTENSION with no matching add (for example dispute, dismiss, redispute accounting) would make `deadline - EXT` underflow-adjacent or pull the deadline earlier than the original, shortening the veto window.
```

```
PROPERTY_ID: ST-11
TYPE: SPECIFIC (after cancelMatch, abortMatch, veto)
ENGLISH: Every refund path (cancelMatch in Open/Pending/Live, abortMatch from Live, veto from Proposed) ends Cancelled and credits each seat exactly stake - seatDiscount.eth, pushes back exactly seatDiscount.lms of LMS to the seat, lowers totalEscrowed by stake*seatCount - totalDiscount.eth and raises totalOwed by the same, lowers totalLmsEscrowed by the match's LMS, burns nothing (LMS totalSupply unchanged), records no fee epoch change, and leaves every non-seat balance untouched. Preconditions: cancelMatch refused before joinDeadline (+LOCK_GRACE when seatCount>=minSeats) in Open, and before `deadline` in Pending/Live; abortMatch needs a quorum from the match's snapshotted set; veto needs guardian/governance and an open challenge window.
SOLIDITY_SKETCH:
  eq(after.status,Cancelled); for each seat s: eq(after.withdrawable[s]-before.withdrawable[s], stake - disc[s].eth); eq(lmsBal[s] delta, disc[s].lms);
  eq(before.totalEscrowed-after.totalEscrowed, stake*n - sumDiscEth); eq(after.totalOwed-before.totalOwed, same);
  eq(before.totalLmsEscrowed-after.totalLmsEscrowed, sumDiscLms); eq(lms.totalSupply delta, 0);
  for e in feeEpochs: eq(epochFees[e] after, before)
  cancel too early / veto after deadline / abort with insufficient quorum: success branch -> t(false)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: withdrawable[actors], lms.balanceOf[actors], totalEscrowed, totalOwed, totalLmsEscrowed, lms.totalSupply, epochFees[feeEpochs], getSeatDiscount sums
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: _refundAll natspec "credits every seat what it paid back: its stake, less any discount, and the LMS that paid for the discount"; veto natspec "refund every stake"; GameEscrow header: LMS "refunded with the stake when it is cancelled, vetoed or aborted".
RATIONALE: Three entry points share one internal; the discount-free fast path (total.eth==0) and the discounted path diverge, and a seat whose discount.eth is 0 but lms>0 (rate edge, tiny stake) would go through the fast path and lose its LMS refund. Harness fact 8 makes lmsPerEthDiscount=1e30 / 1 reachable, so this is fuzz-reachable.
```

```
PROPERTY_ID: ST-12
TYPE: SPECIFIC (after escrow_finalize*, with config mutated between lobby open and finalize)
ENGLISH: Payouts are computed from the match's snapshotted Terms, never current config. After finalize, the credit to ranking[i] equals the formula using getMatchTerms(M).feeBps/payoutBps/treasury, regardless of what config.feeBps / payoutSchedule / treasury currently are; the fee epoch totals use terms.feeBps; the treasury credited is terms.treasury.
SOLIDITY_SKETCH: compute expected from getMatchTerms(M) (not config.*); compare to withdrawable deltas and the epoch fee delta (see ST-09 and VT-04).
GHOST_NEEDS: none
SNAPSHOT_NEEDS: Terms M; withdrawable[treasuryOfTerms]
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: Terms natspec "fixed from the config at that moment so a governance change cannot alter it for a player who already staked."
RATIONALE: Merged check of ST-03 and ST-09 under the deliberate config mutation of harness fact 4. Mark separately so a failure points at config leakage rather than arithmetic.
```

## B. Pause state machine (ExpiringPause, inherited by GameEscrow)

```
PROPERTY_ID: ST-13
TYPE: SPECIFIC (after escrow_secondary pause/extendPause/unpause by guardian or timelock)
ENGLISH: Pause transitions. (a) Guardian pause: allowed only if pausedUntil==0 or block.timestamp >= pausedUntil + GUARDIAN_COOLDOWN; sets pausedUntil == now + GUARDIAN_PAUSE and pausedByGovernance=false. (b) extendPause (timelock only): requires until > now and until > pausedUntil; sets pausedUntil=until (strictly larger than before) and pausedByGovernance=true. (c) unpause: requires paused(); sets pausedUntil=now; a guardian unpause is refused while pausedByGovernance and paused (GovernancePause); governance can always unpause. (d) A guardian pause never shortens or replaces a running pause (it is refused while paused). (e) Over any single call other than unpause, pausedUntil is non-decreasing.
SOLIDITY_SKETCH:
  guardian pause success: t(before.pausedUntil==0 || block.timestamp >= before.pausedUntil + COOLDOWN); eq(after.pausedUntil, block.timestamp+7d); t(!after.pausedByGov);
  extend success: gt(after.pausedUntil, before.pausedUntil); t(after.pausedByGov);
  guardian unpause when before.pausedByGov && paused(): success branch -> t(false)  [GovernancePause]
  non-unpause calls: gte(after.pausedUntil, before.pausedUntil)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: pausedUntil, pausedByGovernance, paused()
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: ExpiringPause natspec "It can end its own pause early, but not one governance extended or started"; "cannot pause again for GUARDIAN_COOLDOWN"; context file says the I-14/G-30 guard now exists and is SHOULD-HOLD.
RATIONALE: This was a known gap fixed in the audit-fix commits; a regression test inside the fuzzer. The guardian-after-governance sequence (extendPause, then expiry or unpause, then guardian pause) is where the flag can go stale.
```

```
PROPERTY_ID: VS-01
TYPE: GLOBAL
ENGLISH: Pause flag/time sync. (a) !pausedByGovernance => pausedUntil <= ghost.lastGuardianPauseAt + GUARDIAN_PAUSE (a guardian-originated pause is never longer than a week). (b) paused() is exactly block.timestamp < pausedUntil. (c) If pausedUntil != 0 and it was last set by a guardian pause, the guardian cannot pause again before pausedUntil + COOLDOWN (checked via ST-13, ghost only here).
SOLIDITY_SKETCH: if (!escrow.pausedByGovernance()) lte(escrow.pausedUntil(), ghosts.lastGuardianPauseAt + 7 days); t(escrow.paused() == (block.timestamp < escrow.pausedUntil()));
GHOST_NEEDS: lastGuardianPauseAt (set in the guardian-pause handler on success)
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: ExpiringPause natspec ("only for GUARDIAN_PAUSE", "stop play for a week at a time"). Caveat: after a governance extendPause then unpause by governance, pausedByGovernance stays true with pausedUntil=now, so (a) is vacuous there, which is fine.
RATIONALE: Guards the guardian's bounded power.
```

```
PROPERTY_ID: ST-14
TYPE: SPECIFIC (escrow handlers executed while paused() is true, using try/catch)
ENGLISH: A pause never blocks value exit: withdraw, withdrawFor, finalize (after its deadline), cancelMatch (when eligible), veto, dispute, dismissDispute and abortMatch are never refused with EnforcedPause; conversely createMatch, join*, lockMatch, settle and bridgeJoin's seating path ARE refused while paused (bridgeJoin credits the player instead, reason Paused).
SOLIDITY_SKETCH:
  try escrow.<exit fn>(...) {} catch (bytes memory r) { t(selector(r) != ExpiringPause.EnforcedPause.selector); }
  try escrow.createMatch(...) { t(!paused) } catch {}
  bridgeJoin while paused: eq(seatCount after, before); eq(withdrawable[player] delta, msg.value)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: paused(), seatCount, withdrawable[player]
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: GameEscrow `_isGuardian` natspec: "`finalize`, `veto`, `cancelMatch` and withdrawals are never paused: a pause must never trap player funds or hold a result that has survived its challenge window." ExpiringPause: "never pauses refunds or withdrawals".
RATIONALE: A forgotten `whenNotPaused` on an exit path is a fund-trapping bug; an extra one on a delivery path strands matches.
```

## C. PullPayable accounting transitions

```
PROPERTY_ID: ST-15
TYPE: SPECIFIC (after escrow_withdraw*, escrow_withdrawFor*, bridge_withdrawToChainFor*)
ENGLISH: A withdrawal by account A: withdrawable[A] becomes 0 and falls by exactly the amount returned, totalOwed falls by the same amount, no other account's withdrawable changes, totalEscrowed unchanged, and the ETH recipient receives exactly `amount`. withdrawFor is refused unless msg.sender == account and it refuses a non-zero balance under MIN_WITHDRAW_FOR; withdrawToBridge is refused unless caller is the bridge receiver. A zero balance reverts (no silent success).
SOLIDITY_SKETCH:
  eq(ret, before.withdrawable[A]); eq(after.withdrawable[A], 0); eq(before.totalOwed-after.totalOwed, ret);
  for q != A: eq(after.withdrawable[q], before.withdrawable[q]); eq(after.totalEscrowed, before.totalEscrowed);
  recipient EOA actor: eq(recipient.balance after - before, ret)  // receiving ETH is safe to assert (harness fact 2)
  withdrawFor(account != msg.sender) or amount in (0, MIN): success branch -> t(false)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: withdrawable[actors], totalOwed, totalEscrowed, recipient balance
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: PullPayable._payOut; withdrawFor natspec "Pays account's balance to account itself. The account only."
RATIONALE: Covers the other half of the credit/withdraw pair; the audit changed withdrawFor, so assert the new gate.
```

```
PROPERTY_ID: VT-01
TYPE: SPECIFIC (all handlers except withdraw/withdrawFor/bridge withdraw), per actor
ENGLISH: Credits only grow a balance: for every account, withdrawable is non-decreasing across any call that is not a withdrawal by that account. totalOwed is non-decreasing across any call that is not a withdrawal.
SOLIDITY_SKETCH: if (!isWithdrawHandler) { for a in actors+{treasury(s)}: gte(after.withdrawable[a], before.withdrawable[a]); gte(after.totalOwed, before.totalOwed); }
GHOST_NEEDS: none
SNAPSHOT_NEEDS: withdrawable[actors ∪ feeRouter], totalOwed
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: PullPayable header: "every credit and every withdrawal goes through the two functions below".
RATIONALE: Catches a path (refund, extra credit, JoinRefunded) that debits or resets a balance as a side effect. Note FeeRouter.harvest withdraws on behalf of the router itself, so it is an allowed decrease for feeRouter.
```

## D. Fee epoch accumulators (GameEscrow feesPaid, epochFees)

```
PROPERTY_ID: VT-02
TYPE: SPECIFIC (after finalize); GLOBAL half in VT-03
ENGLISH: Fee accumulators only move in finalize of a matchmade lobby, only in the epoch block.timestamp/FEE_EPOCH, and only upward. For a matchmade match with fee>0: epochFees[e] rises by Σ_seats (fee - seatDiscount.eth) and feesPaid[p][e] rises by (fee - seatDiscount.eth) for each seat p; for a non-matchmade finalize, or fee==0, no feesPaid/epochFees entry anywhere changes. Cancelled and vetoed matches add nothing. Entries for epochs other than the current one never change in any call.
SOLIDITY_SKETCH:
  e = block.timestamp/FEE_EPOCH; fee = stake*feeBps/1e4;
  matchmade&&fee>0: eq(epochFees[e]-before, Σ(fee - disc[p].eth)); for p: eq(feesPaid[p][e]-before, fee - disc[p].eth);
  else: eq(epochFees[e], before); for q in actors: eq(feesPaid[q][e], before)
  for e2 in feeEpochs, e2 != e: eq(epochFees[e2], before) ; for q: eq(feesPaid[q][e2], before)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: epochFees[feeEpochs ∪ current], feesPaid[actors][those epochs], match terms feeBps, matchmade, seat discounts
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: GameEscrow natspec: "Only a settled match pays its fee, so only a settled match counts"; "Fee totals count only the ETH part, the net fee"; "Fee totals, and so play-mining, count matchmade lobbies only".
RATIONALE: Play-mining pays LMS from these numbers (RewardsDistributor); inflating them mints rewards.
```

```
PROPERTY_ID: VT-03
TYPE: GLOBAL
ENGLISH: Once an epoch has ended, its totals are final. For every epoch e < block.timestamp / FEE_EPOCH that was observed, epochFees[e] and feesPaid[p][e] (all actors) equal the value first observed after the epoch ended. Also epochFees[e] == Σ over players recorded by finalize of feesPaid[p][e] (restricted to ghost-tracked players), and both are non-decreasing in any call.
SOLIDITY_SKETCH:
  for e in feeEpochs: if (e < block.timestamp/FEE_EPOCH) { if(!ghosts.frozen[e]) skip (hook freezes it) else eq(epochFees(e), ghosts.frozenEpochFees[e]); for p in actors: eq(feesPaid(p,e), ghosts.frozenFeesPaid[p][e]); }
  eq(epochFees(e), ghosts.sumFeesPaid[e])   // ghost sum over finalize rankings
GHOST_NEEDS: frozen[e], frozenEpochFees[e], frozenFeesPaid[p][e], sumFeesPaid[e] (updated by the finalize handler from the ranking); hook `_freezeEpochs()` at the end of every handler
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: GameEscrow header "since a total only ever grows while its epoch is the current one, it is final the moment the epoch ends"; RewardsDistributor header "an ended epoch's totals never change again, and every player's share of it is final".
RATIONALE: The distributor fixes rates at first claim; if a late finalize could still alter a closed epoch, two claimants of one epoch would get different rates (the exact failure the docs argue is impossible).
```

```
PROPERTY_ID: VS-02
TYPE: GLOBAL
ENGLISH: Match registry sync. matchNonce == number of matches ever created == number of ids in matchIds (when every creation goes through a registering handler); every id in matchIds has status != None; ids are unique; termsCount <= matchNonce and each match's termsId is in [1, termsCount].
SOLIDITY_SKETCH: eq(escrow.matchNonce(), matchIds.length); for id: t(getMatch(id).status != None); t(1 <= m.termsId && m.termsId <= escrow.termsCount());
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: LOW
GUARANTEE: EXPLORATORY
EVIDENCE: none, inferred (relies on the harness registering every created lobby; bridge/zap paths do not create lobbies).
RATIONALE: Cheap entity-count check; also detects a hidden create path.
```

```
PROPERTY_ID: VS-03
TYPE: GLOBAL
ENGLISH: Escrow aggregates decompose over matches. totalEscrowed == Σ over matches in Open/Pending/Live/Proposed of (stake*seatCount - Σ seat discount.eth). totalLmsEscrowed == Σ over the same matches of Σ seat discount.lms. A match in None/Settled/Cancelled contributes zero to both.
SOLIDITY_SKETCH:
  for id: if (status in {Open,Pending,Live,Proposed}) { seats=getSeats(id); sumE += stake*n; for s: sumE -= getSeatDiscount(id,s).eth; sumL += getSeatDiscount(id,s).lms; }
  eq(escrow.totalEscrowed(), sumE); eq(escrow.totalLmsEscrowed(), sumL);
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: totalEscrowed natspec "Stakes held for matches that have not yet settled or cancelled"; totalLmsEscrowed "LMS held against seats of matches that have not ended". This is the per-match decomposition behind the declared solvency invariant; it localises a break to a particular match state, which the balance-only invariant cannot.
RATIONALE: Overlaps conservation (another agent) by design: it is stated as state sync so a failure names the match and status. Loops are bounded by matchIds * seats; keep it cheap with an early exit if matchIds is large.
```

## E. StakedLms reward stream and unstake queue

```
PROPERTY_ID: VT-04
TYPE: GLOBAL (with post-call hook updating the ghost)
ENGLISH: rewardPerShare() (the stored accumulator plus accrual) never decreases. lastAccrual never decreases and never exceeds periodFinish nor block.timestamp. Neither moves backward through donations, transfers, claims or empty-supply periods.
SOLIDITY_SKETCH: gte(stakedLms.rewardPerShare(), ghosts.maxRps); gte(stakedLms.lastAccrual(), ghosts.maxLastAccrual); lte(stakedLms.lastAccrual(), stakedLms.periodFinish()); lte(stakedLms.lastAccrual(), block.timestamp);
GHOST_NEEDS: maxRps, maxLastAccrual (updated by hook after each handler)
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: StakedLms header "`rewardPerShare` only ever grows"; "ETH earned per sLMS since deployment" (rewardPerShare natspec).
RATIONALE: A decreasing accumulator makes `rewardPerShare() - settledAt[account]` underflow-revert inside `earned` and every `_update`, which would brick transfers and staking (DoS), or pay out twice. Wrap the lastAccrual<=periodFinish part in a state-based condition; it can be violated only if `_accrue` mis-orders the supply==0 branch.
```

```
PROPERTY_ID: ST-16
TYPE: SPECIFIC (after stakedLms_deposit*, depositFor, requestUnstake*, claim, transfer, delegate, depositRewards*, donate*)
ENGLISH: Moving or minting/burning stake never changes anyone's accrued reward at that instant. For every actor a, earned(a) after == earned(a) before for deposit, depositFor, transfer, requestUnstake, claim (unstake), delegate, and depositRewards (the deposit only restarts the stream, it does not pay or take back what is already earned). For claimRewards by C: earned(C) becomes 0 and the ETH received by `to` equals earned(C) before; every other actor's earned is unchanged.
SOLIDITY_SKETCH:
  for a in actors: eq(stakedLms.earned(a), before.earned[a]);   // same-timestamp pairs (calls are atomic, timestamp does not move inside a handler)
  claimRewards: eq(earned(C) after, 0); eq(to.balance delta, before.earned[C]) (receiving is safe); others unchanged; eq(stakedLms.balance delta, -before.earned[C])
GHOST_NEEDS: none
SNAPSHOT_NEEDS: earned[actors], stakedLms ETH balance, to.balance
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: StakedLms header: "settling happens in `_update`, before any balance moves, so a mint, burn or transfer can never carry rewards earned by someone else"; requestUnstake natspec "Rewards earned up to this moment stay claimable"; "Anyone may deposit rewards ... can never take anything from stakers". The equality is exact: both _settle and earned use mulDiv(balance, rps - settledAt) with the same rps at the same timestamp.
RATIONALE: A strict equality is stronger than the existing Foundry invariants; rounding or ordering mistakes in `_update` (settle after the balance moved, or one side skipped when from==to) show up immediately. Include self-transfer (from==to) and transfer to a fresh address.
```

```
PROPERTY_ID: ST-17
TYPE: SPECIFIC (after stakedLms_depositRewards*)
ENGLISH: depositRewards restarts the stream coherently: periodFinish == block.timestamp + rewardDuration, lastAccrual == block.timestamp, and the stream's face value rewardRate * rewardDuration / 1e27 is within 1 wei below (msg.value + unpaid_before), where unpaid_before = (periodFinish_before - now) * rewardRate_before / 1e27 if the old stream was still running, else 0. rewardPerShare is unchanged, and totalSupply, totalUnstaking, balances are unchanged.
SOLIDITY_SKETCH:
  eq(after.periodFinish, block.timestamp + REWARD_DURATION); eq(after.lastAccrual, block.timestamp);
  x = msg.value + unpaidBefore;  lte(after.rate*dur, x*1e27); gte(after.rate*dur/1e27 + 1, x);
  eq(after.rps, before.rps_at_now)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: rewardRate, periodFinish, lastAccrual, rewardPerShare, msg.value passed
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: depositRewards natspec "it and whatever is still unpaid are paid out evenly over the next `rewardDuration`"; the rate is a floor mulDiv.
RATIONALE: Dust deposits repeated every block compound the rounding (the natspec acknowledges decay); this bounds each step's loss to under 1 wei.
```

```
PROPERTY_ID: ST-18
TYPE: SPECIFIC (first stake after supply hit zero: stakedLms_deposit*/depositFor when totalSupply()==0 before)
ENGLISH: With nothing staked the stream pauses rather than leaking: if totalSupply()==0 and lastAccrual < periodFinish before the call, then after the first deposit (periodFinish - lastAccrual) is unchanged and rewardPerShare is unchanged. In general, rewardPerShare() does not move while totalSupply()==0.
SOLIDITY_SKETCH:
  if (before.totalSupply==0 && before.lastAccrual < before.periodFinish) { eq(after.periodFinish - after.lastAccrual, before.periodFinish - before.lastAccrual); eq(after.rewardPerShareStored-ish via rewardPerShare(), before.rps); }
  with the harness's stakedLms_unstakeEveryone_clamped followed by a time delay then deposit.
GHOST_NEEDS: none
SNAPSHOT_NEEDS: totalSupply, lastAccrual, periodFinish, rewardPerShare
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: StakedLms header: "While nothing is staked the stream pauses — its end moves out by the time that passed — so ETH that arrives with no stakers waits for the first ones rather than being lost."
RATIONALE: This is the path that can strand or double-assign rewards; setup requires all 8 actors unstaked, which the handler stakedLms_unstakeEveryone_clamped supports.
```

```
PROPERTY_ID: ST-19
TYPE: SPECIFIC (after requestUnstake*, claim, setCooldown in stakedLms_secondary)
ENGLISH: Unstake queue. requestUnstake(x): totalSupply falls by x, balance falls by x, totalUnstaking rises by x, unstakeOf.assets rises by x, unstakeOf.unlockAt == now + cooldown (for the whole pending amount), and totalSupply + totalUnstaking is unchanged. claim: refused before unlockAt; afterwards unstakeOf deleted, totalUnstaking falls by assets, the receiver gains exactly assets LMS. setCooldown changes only `cooldown`: no pending unlockAt changes. EXPLORATORY sub-claim: an existing pending entry's unlockAt never moves earlier (a later request after a cooldown reduction would shorten the first amount's wait).
SOLIDITY_SKETCH:
  request: eq(after.totalSupply+after.totalUnstaking, before.totalSupply+before.totalUnstaking); eq(unstakeOf(a).assets, before.assets+x); eq(unstakeOf(a).unlockAt, block.timestamp+cooldown());
  claim: gte(block.timestamp, before.unlockAt); eq(lms delta of receiver, before.assets);
  setCooldown: for a: eq(unstakeOf(a).unlockAt, before.unlockAt)
  EXPLORATORY: if (before.assets>0) gte(after.unlockAt, before.unlockAt)   // this can fail after a cooldown decrease by timelock
GHOST_NEEDS: none
SNAPSHOT_NEEDS: totalSupply, totalUnstaking, unstakeOf[actors], lms.balanceOf[receiver], cooldown
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD for the main claim; the unlockAt-never-earlier sub-claim is EXPLORATORY
EVIDENCE: requestUnstake natspec "A second request adds to the first and restarts the cooldown for the whole amount"; setCooldown natspec "Changes the cooldown for future requests. Pending ones keep theirs." (the sub-claim contradicts neither literally but checks the intent: StakedLms header says voters stay exposed for the cooldown after voting).
RATIONALE: Governance safety rests on cooldown > voting period + timelock delay; a restart after a cooldown cut lets earlier-pending LMS leave sooner than promised.
```

```
PROPERTY_ID: VS-04
TYPE: GLOBAL
ENGLISH: Stake entity sync. totalUnstaking == Σ_actors unstakeOf.assets; totalSupply == Σ_actors sLMS balances (every mint goes to an actor in the harness); no actor has unstakeOf.assets == 0 with unlockAt != 0 (delete resets both); stakedLms's LMS balance >= totalSupply + totalUnstaking (>= because of stakedLms_donateLms).
SOLIDITY_SKETCH: for a: sumU += unstakeOf(a).assets; sumB += balanceOf(a); t(assets>0 || unlockAt==0); eq(totalUnstaking, sumU); eq(totalSupply, sumB); gte(lms.balanceOf(stakedLms), totalSupply+totalUnstaking);
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: EXPLORATORY for the equalities over actors (depends on all holders being actors); the LMS-balance >= part is SHOULD-HOLD
EVIDENCE: StakedLms header "The LMS backing sLMS is `totalSupply`; with `totalUnstaking` that is everything owed. LMS sent here directly is neither, and governance can sweep it."
RATIONALE: Entity counts for the queue; sweepStray must also leave this bound intact (add: after sweepStray, LMS balance == totalSupply + totalUnstaking exactly).
```

## F. FeeRouter

```
PROPERTY_ID: ST-20
TYPE: SPECIFIC (after feeRouter_harvest*)
ENGLISH: harvest drains everything it can see and splits by stakerBps: afterwards escrow.withdrawable(feeRouter) == 0 and feeRouter's ETH balance == 0 (it holds nothing between transactions); the vault receives floor(amount*stakerBps/10000) via depositRewards (periodFinish restarts when that is non-zero), the treasury the rest; the escrow's totalOwed falls by what the router had credited; nothing in matches changes. With nothing to split it reverts and changes nothing.
SOLIDITY_SKETCH:
  eq(escrow.withdrawable(feeRouter), 0); eq(address(feeRouter).balance, 0);
  eq(before.totalOwed - after.totalOwed, before.withdrawable[feeRouter]);
  toStakers = amount*stakerBps/1e4; eq(stakedLms ETH delta, toStakers); eq(treasury ETH delta (if EOA actor), amount - toStakers)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: withdrawable[feeRouter], totalOwed, feeRouter ETH balance (includes forced donation), stakedLms balance, treasury balance
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: FeeRouter header: "Holds no ETH between transactions ... `harvest` splits whatever balance it finds, so nothing that arrived another way can stay."
RATIONALE: feeRouter_donateETH forces ETH in; the postcondition must still leave the router empty. Treasury and stakerBps are changeable (feeRouter_secondary), so use the current values.
```

## G. RewardsDistributor and RewardVesting

```
PROPERTY_ID: VT-05
TYPE: GLOBAL
ENGLISH: An epoch's rate terms are write-once. If rateOf(e).fixed_ is true it stays true, and (rate, walletCap) never change thereafter even if setMaxRewardPerEth / setMaxRewardPerWalletPerEpoch are called. isClaimed(p,e) never goes true->false. A vesting tranche with amount>0 implies isClaimed(p,e) and fixed_(e).
SOLIDITY_SKETCH: for e in feeEpochs: (r,c,f)=rewards.rateOf(e); if(ghosts.fixed[e]) { t(f); eq(r, ghosts.rate[e]); eq(c, ghosts.cap[e]); } else if (f) record;
  for p in actors: if(ghosts.claimed[p][e]) t(rewards.isClaimed(p,e)); if (vesting.trancheOf(p,e).amount>0) { t(rewards.isClaimed(p,e)); t(f); }
GHOST_NEEDS: fixed[e], rate[e], cap[e], claimed[p][e] (set by hook after claim)
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: RewardsDistributor header "The rate and the wallet cap are fixed by the first claim, so a later change to a cap cannot treat two claimants of one epoch differently"; rateOf natspec "fixed once claimed from".
RATIONALE: Claimants of one epoch must share a rate. Harness fact 9: epochs before firstEpoch have zero budget; include them so a zero-rate fix cannot later change.
```

```
PROPERTY_ID: ST-21
TYPE: SPECIFIC (after rewards_claim*, including duplicateEpoch_clamped)
ENGLISH: claim(player, epochs): (a) refused unless every listed epoch has ended (block.timestamp >= (e+1)*epochLength) and block.timestamp < claimsCloseAt(); (b) refused if any listed epoch is already claimed for the player, including a duplicate within the list; (c) for each epoch with feesPaid>0: isClaimed becomes true, the rate is fixed, and the tranche amount == min(feesPaid*rate/1e18, walletCap) (zero amounts mean no tranche but the epoch stays marked); (d) epochs with feesPaid == 0 stay unclaimed; (e) vesting.totalGranted rises by the returned reward, which equals the LMS that left the distributor and arrived in the vesting contract; (f) no other player's claimed flag or tranche changes.
SOLIDITY_SKETCH:
  for i: e=epochs[i]; gte(block.timestamp, (e+1)*epochLength); paid=escrow.feesPaid(player,e);
    if (paid>0) { t(isClaimed(player,e)); (r,c,) = rateOf(e); eq(trancheOf(player,e).amount, min(paid*r/1e18, c)); } else t(!isClaimed(player,e));
  eq(vesting.totalGranted() - before.totalGranted, reward); eq(before.lmsBal[rewards]-after.lmsBal[rewards], reward); eq(after.lmsBal[vesting]-before.lmsBal[vesting], reward);
  duplicate epoch in list / future epoch / post-close: success branch -> t(false)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: isClaimed[p][epochs], feesPaid, vesting.totalGranted, lms balances of rewards/vesting, trancheOf
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: claim code and natspec ("Epochs with no fees paid are skipped, and stay unclaimed"; "A claim ... adds the epoch's reward to `vesting`, a tranche"); the 1e18 RATE_SCALE reward formula.
RATIONALE: Pairs the claimed-bit with the grant; a mismatch (bit set, no tranche, or tranche without bit) either burns rewards or allows double claims.
```

```
PROPERTY_ID: VT-06
TYPE: GLOBAL
ENGLISH: RewardVesting accumulators. totalGranted and totalReleased only grow; totalReleased <= totalGranted; per tranche released <= amount and amount is write-once (never changes after being non-zero); released is monotone. Σ_{actors, feeEpochs} tranche.amount == totalGranted (when all claimants are actors) and Σ tranche.released == totalReleased.
SOLIDITY_SKETCH: gte(vesting.totalGranted(), ghosts.maxGranted); gte(vesting.totalReleased(), ghosts.maxReleased); lte(totalReleased,totalGranted);
  for p,e: tr = trancheOf(p,e); lte(tr.released, tr.amount); if(ghosts.amt[p][e]!=0) eq(tr.amount, ghosts.amt[p][e]); sumA+=tr.amount; sumR+=tr.released;
  eq(sumA, totalGranted); eq(sumR, totalReleased);
GHOST_NEEDS: maxGranted, maxReleased, amt[p][e] (recorded after claim)
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD for monotonicity and released<=amount (structural: grant reverts AlreadyGranted, release adds only `due`); EXPLORATORY for the Σ equalities (depends on all claimants being actors and on nothing granting outside claim)
EVIDENCE: RewardVesting natspec "Every tranche's amount, added up" (totalGranted), "Everything paid out so far" (totalReleased); AlreadyGranted guard.
RATIONALE: Aggregate/entity-count consistency of the vesting ledger.
```

```
PROPERTY_ID: ST-22
TYPE: SPECIFIC (after vesting_release*) and GLOBAL half
ENGLISH: release pays only what vested and exactly records it. Per released epoch, the tranche's released rises by the amount paid and never exceeds vested(player, epoch) at that timestamp; amount paid == Δ LMS balance of the player == Δ totalReleased == Δ (LMS held by vesting, negative); a repeat release in the same block pays nothing and reverts (NothingToRelease); nothing releases before vestingStart(epoch) (= epoch end), and vested() is monotone in time and equals the full amount from start + 26 weeks. Other players' tranches are unchanged.
SOLIDITY_SKETCH:
  for e: lte(tr.released, rewards.vesting().vested(p,e)); after: if (block.timestamp <= vestingStart(e)) eq(tr.released, 0);
  eq(lms delta of player, amountPaid); eq(vesting.totalReleased() - before, amountPaid); eq(before.vestingLms - after.vestingLms, amountPaid);
  immediate second release same epochs: success branch -> t(false)
  GLOBAL: for p,e with amount>0: lte(released, vested(p,e)); if (block.timestamp >= vestingStart(e)+VESTING_DURATION) t(vested == amount)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: trancheOf[p][epochs], lms.balanceOf(p), vesting lms balance, totalReleased
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: RewardVesting natspec "A tranche vests linearly over VESTING_DURATION, starting the moment its epoch ended"; `release` and `vested` code; "nothing votes, or can be sold, before it vests".
RATIONALE: Early release is the anti-farming guarantee for governance. Note vested(rounding): (amount*elapsed)/26w floors, so released can lag by under one wei per tranche but never exceed vested.
```

## H. SessionKeyDelegate

```
PROPERTY_ID: ST-23
TYPE: SPECIFIC (after session_grantSession*, session_revokeSession*, session_execute*)
ENGLISH: Session state machine per (account, key). grantSession (only by the account itself): stores validUntil, valueCap, spendCap exactly as given with spent == 0, requires validUntil in (now, now + MAX_SESSION_DURATION], valueCap <= spendCap, key not zero/self; it touches no other key's session. revokeSession deletes the key's session so sessionActive is false and executeWithSession by that key fails. execute success: nonce rises by exactly 1, spent rises by exactly `value`, value <= valueCap, spent <= spendCap, key not expired, target is the escrow and the selector is join(matchId) or withdrawFor(self) (with value 0 and the account itself as argument). Expired, revoked, replayed (old nonce) or over-cap calls are refused with no state change.
SOLIDITY_SKETCH:
  grant: (vu,vc,sc,sp)=acct.sessions(k); eq(vu,validUntil); eq(vc,valueCap); eq(sc,spendCap); eq(sp,0); for other keys j: sessions(j) == before.sessions[j];
  execute ok: eq(acct.sessionNonce(), before.nonce+1); eq(sp_after, sp_before+value); lte(value, vc); lte(sp_after, sc); t(block.timestamp < vu);
  withdrawFor path: eq(escrow.withdrawable(acct), 0)  // value == 0 so spent unchanged
  expired/revoked/replayed/over-cap/wrong target: success branch -> t(false)
GHOST_NEEDS: grantTime[acct][key] (for VS-05)
SNAPSHOT_NEEDS: sessions(k) tuples for all sessionKeys per sessionAccount, sessionNonce per account, escrow.totalEscrowed (for join value)
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: SessionKeyDelegate natspec ("value — a cap per call and a cap in total, both set at grant", "every session expires, within MAX_SESSION_DURATION", "The spend restarts at zero", "the nonce advances first, so a target that re-enters cannot replay"); code reverts for each condition. Do not assert on the account's ETH: assert escrow-side deltas (harness fact 2).
RATIONALE: The x-ray flags nothing covers SessionKeyDelegate. A leaked key must stay bounded by these caps.
```

```
PROPERTY_ID: VS-05
TYPE: GLOBAL
ENGLISH: For every sessionAccount and sessionKey: spent <= spendCap, valueCap <= spendCap, and if sessionActive then validUntil <= grantTime + MAX_SESSION_DURATION and validUntil > block.timestamp; a key never granted or revoked has validUntil == 0; sessionNonce is monotone.
SOLIDITY_SKETCH: for acct in sessionAccounts, k in sessionKeys: (vu,vc,sc,sp)=acct.sessions(k); lte(sp,sc); lte(vc,sc); if(acct.sessionActive(k)) { lte(vu, ghosts.grantTime[acct][k] + 7 days); } gte(acct.sessionNonce(), ghosts.maxNonce[acct]);
GHOST_NEEDS: grantTime[acct][key] (from handler), maxNonce[acct]
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: SessionKeyDelegate natspec above; `Session` struct comments ("Zero means no session: there is no never expires").
RATIONALE: Cheap structural guard over the session registry.
```

## I. BridgeJoinReceiver and bridgeJoin

```
PROPERTY_ID: ST-24
TYPE: SPECIFIC (after bridge_fillJoin*, bridge_fillAnyMatch*, bridge_fillUnroutable*)
ENGLISH: bridgeJoin never reverts for a valid caller and non-zero player, and routes the value to exactly one of two outcomes. Seat taken (only if match Open, not past joinDeadline, not full, player not seated, rostered if matchmade, not paused, value >= stake): seatCount+1, totalEscrowed += stake, the excess (value - stake) credited, seatOrigin(M,player) == originChainId. Refused (any other case): seatCount, totalEscrowed unchanged, withdrawable[player] and totalOwed rise by exactly msg.value, a JoinRefunded event with the matching reason. In both cases escrow ETH balance rises by exactly msg.value. The seat must be taken whenever all conditions hold (no spurious refund).
SOLIDITY_SKETCH:
  canSeat = _canSeat(M,player) && !paused && value >= stake;   // computed BEFORE the call
  if (canSeat) { eq(seatCount after, before+1); eq(totalEscrowed delta, stake); eq(withdrawable[player] delta, value - stake); eq(seatOrigin, originChainId) }
  else { eq(seatCount,before); eq(totalEscrowed,before); eq(withdrawable[player] delta, value); }
  eq(address(escrow).balance delta, value)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: seatCount M, totalEscrowed, totalOwed, withdrawable[player], escrow ETH balance, paused
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: bridgeJoin natspec "for any player but zero it then never reverts: the stake has already left its chain ... all of it is credited to the player here instead"; "More than the stake takes the seat and credits the player the rest."
RATIONALE: A revert here reverts the Across fill (stuck deposit); a spurious refund bypasses the seat. The matchmade/rostered case is the one most likely to diverge between _joinFailure and _seat. Compare _canSeat in Base with _joinFailure ordering: _joinFailure checks `value < stake` before NotRostered, _seat checks rostered, so a rostered failure with enough value hits NotRostered; verify no revert when both fail.
```

```
PROPERTY_ID: ST-25
TYPE: SPECIFIC (after bridge_withdrawToChainFor*, session of the signer)
ENGLISH: A successful bridge withdrawal: nonces[player] rises by exactly 1 and no other player's nonce changes; the player's escrow balance goes to 0 and totalOwed falls by that amount; the receiver's ETH balance after == before (everything forwarded to the SpokePool); the SpokePool receives the full amount. A replay of the same signed Withdrawal (same nonce), a wrong nonce, an expired deadline, a wrong hubChainId, a bad signature, or a quote differing from the signed one is refused with no change. The unsigned fields cannot be altered by the submitter.
SOLIDITY_SKETCH:
  eq(bridge.nonces(p), before.nonce+1); for q != p: eq(nonces(q), before);
  eq(escrow.withdrawable(p), 0); eq(before.totalOwed-after.totalOwed, amount); eq(address(bridge).balance, before.bridgeBalance); eq(acrossPool received, amount);
  bridge_withdrawToChainFor_clamped (forbidden modes): replay/tampered quote/expired/wrong chain -> success branch t(false)
GHOST_NEEDS: none
SNAPSHOT_NEEDS: nonces[signerActors], withdrawable, totalOwed, bridge ETH balance, spoke pool balance
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: BridgeJoinReceiver natspec "The player signs the Across quote too, so whoever submits it chooses nothing: not the output, not the exclusive relayer, not the deadline"; "Holds nothing between transactions except what it could not route". The context file says the withdrawFor and Quote fixes landed.
RATIONALE: Regression guard for the audit fix and the nonce state machine.
```

```
PROPERTY_ID: VS-06
TYPE: GLOBAL
ENGLISH: BridgeJoinReceiver holds only unroutable value: (ETH balance + WETH balance of the receiver) >= ghosts.unroutableHeld, and nothing else lands there; after a successful recover the held amount falls by what was sent. nonces[player] is monotone.
SOLIDITY_SKETCH: gte(address(bridge).balance + weth.balanceOf(address(bridge)), ghosts.unroutableHeld); // >= for forced ETH
GHOST_NEEDS: unroutableHeld (increase on Unroutable events via bridge_fillUnroutable*, decrease on recover)
SNAPSHOT_NEEDS: none
PRIORITY: LOW
GUARANTEE: EXPLORATORY
EVIDENCE: none, inferred. The bridge_handleOnHeldEth_clamped handler deliberately makes the pool report WETH that never arrived (harness fact 7, EXPLORATORY by instruction), so exclude that handler from the ghost or treat violations there as an accepted trust assumption.
RATIONALE: Detects stuck or leaked value in the receiver.
```

## J. ProtocolConfig, MultisigPhase, LiquidityReserve, governance

```
PROPERTY_ID: ST-26
TYPE: SPECIFIC (after config_secondary and handlers on ProtocolConfig)
ENGLISH: Config transitions keep the config valid and versioned: attestorSetVersion rises by exactly 1 per setAttestorSet and only then; thresholdOf[version] and getAttestors(version) of past versions never change (old matches keep their set); lmsToken, once non-zero, never changes; params always satisfy feeBps <= MAX_FEE_BPS, 2 <= minSeats <= maxSeats <= 256, minStake > 0 and <= maxStake, windows in (0, MAX_WINDOW], payout schedule length <= minSeats, schedule sums to 10000; and matchLifetime() < timelock.getMinDelay() whenever the owner is the timelock.
SOLIDITY_SKETCH:
  gte-by-one version; for v in 1..version: eq(keccak(getAttestors(v)), ghosts.setHash[v]); eq(thresholdOf(v), ghosts.th[v]);
  if (ghosts.lmsToken != 0) eq(config.lmsToken(), ghosts.lmsToken);
  getParams() validity predicate; eq(config.payoutBpsTotal(), 10000); lt(config.matchLifetime(), timelock.getMinDelay())
GHOST_NEEDS: setHash[v], th[v], lmsToken
SNAPSHOT_NEEDS: attestorSetVersion
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: ProtocolConfig natspec ("Every change makes a new version; a match keeps the one it locked under", "Once only" for setLmsToken, "the owner's delay has to outlast a whole match ... checked whenever the windows or the owner change"); _setParams/_setPayoutSchedule reverts.
RATIONALE: The timelock-delay > matchLifetime relation is the premise for the snapshot design; the harness changes windows via config_secondary, so confirm the guard really holds on every path (setChallengeWindow and setParams both call _checkDelay).
```

```
PROPERTY_ID: ST-27
TYPE: SPECIFIC (after multisig_secondary modes) and GLOBAL half
ENGLISH: MultisigPhase state machine. Before phaseEnd only the Safe can schedule/scheduleBatch/cancel; at or after phaseEnd all three are refused; retire is refused before phaseEnd and, after it, leaves the phase without PROPOSER and CANCELLER roles in the timelock (idempotent and not reversible by the Safe). Any call that is a transferOwnership/renounceOwnership selector, targets the timelock, targets LMS, or is sweep/sweepStray/setRecipient or recover(LMS,...) is refused in schedule and in every element of scheduleBatch (all-or-nothing). Every operation the phase ever scheduled satisfies those restrictions.
SOLIDITY_SKETCH:
  forbidden modes: try phase.schedule(...) { t(false) } catch {}  (also scheduleBatch with one forbidden element at index>0)
  after phaseEnd: schedule/cancel by safe -> success branch t(false)
  after retire: t(!timelock.hasRole(PROPOSER_ROLE, address(phase))); t(!timelock.hasRole(CANCELLER_ROLE, address(phase)));
  GLOBAL: block.timestamp < phase.phaseEnd() => timelock.hasRole(PROPOSER_ROLE, phase) unless retired; ghost.retired => roles absent
GHOST_NEEDS: scheduledViaPhase[] (target, selector), retired flag
SNAPSHOT_NEEDS: timelock role bits for phase, timelock.isOperation(id)
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: MultisigPhase natspec (list of refused calls; "Once that has passed, anyone may call retire"); context file notes _checkCall now covers LMS-moving calls. Selector-based match means a same-named function on any target is refused too (accepted design).
RATIONALE: Closes the "nothing covers MultisigPhase" x-ray gap. Add a batch with the forbidden call at the last position to check the loop covers all elements.
```

```
PROPERTY_ID: ST-28
TYPE: SPECIFIC (after reserve_secondary and any call touching LiquidityReserve)
ENGLISH: LiquidityReserve releases only to an approved recipient and only by the Safe or the timelock; the vault, the Safe and the reserve itself can never be (or remain) approved; a release moves exactly `amount` LMS out of the reserve and into the recipient, and never to the vault.
SOLIDITY_SKETCH:
  setRecipient(vault|safe|reserve|0, true) -> success branch t(false);  release(to not approved) -> success branch t(false); release by outsider -> t(false)
  ok: eq(reserveLms delta, -amount); eq(lms.balanceOf(to) delta, amount); t(to != stakedLms)
  GLOBAL: t(!reserve.isApproved(vault) && !reserve.isApproved(safe) && !reserve.isApproved(address(reserve)))
GHOST_NEEDS: none
SNAPSHOT_NEEDS: reserve LMS balance, recipient LMS balance
PRIORITY: LOW
GUARANTEE: SHOULD-HOLD
EVIDENCE: LiquidityReserve natspec "the vault, the Safe and the reserve itself can never be approved". Caveat: an approved recipient could later be set false then re-approved; nothing in code stops a recipient that is a contract forwarding LMS to the vault, which is outside scope.
RATIONALE: Voting-power laundering guard (5% of supply clears the quorum floor).
```

```
PROPERTY_ID: ST-29
TYPE: SPECIFIC (after governor/timelock handlers) and GLOBAL half
ENGLISH: Governance state sync. LMS supply is constant at LMS_SUPPLY minus burned escrow LMS: lms.totalSupply() == LMS_SUPPLY - ghosts.burned (the only burn path is GameEscrow finalize; players may burn their own, so use <= and track burns). The quorum floor at any recorded past timepoint never changes (checkpointed), and quorum(t) >= quorumFloor(t) always; a proposal's state moves only forward through Pending, Active, Succeeded|Defeated, Queued, Executed (Canceled/Expired terminal).
SOLIDITY_SKETCH:
  lte(lms.totalSupply(), LMS_SUPPLY); eq(lms.totalSupply(), LMS_SUPPLY - ghosts.burned);
  for t in ghosts.pastTimes: eq(governor.quorumFloor(t), ghosts.floorAt[t]); gte(governor.quorum(t), governor.quorumFloor(t));
  proposal state machine: rank(state) non-decreasing except none; Executed/Canceled/Expired absorbing
GHOST_NEEDS: burned (from LmsBurned and player burns), pastTimes[], floorAt[], lastProposalState[id]
SNAPSHOT_NEEDS: lms.totalSupply
PRIORITY: LOW
GUARANTEE: EXPLORATORY for the supply identity (players can burn and unknown holders may exist); SHOULD-HOLD for state-machine absorption (OZ Governor semantics, ProposalState enum)
EVIDENCE: LmsToken natspec "Fixed supply ... no mint function"; LmsGovernor "The floor is checkpointed like the fraction is, so changing it never moves the goalposts of a vote already under way".
RATIONALE: Cheap sanity checks around the governance state the harness drives with real proposals (proposals registry).
```

## K. Cross-contract paired-operation symmetry

```
PROPERTY_ID: ST-30
TYPE: SPECIFIC (after escrow_join then escrow_cancelMatch / veto pair, tracked per player via ghosts)
ENGLISH: Join then refund is a no-op for the player: for a player who joined match M with ETH stake s (and LMS l for a discounted seat) and whose match ended Cancelled, the player's cumulative escrow credit from M is exactly s - discount.eth plus l LMS back, and nothing was added to feesPaid/epochFees. For a Settled match the player's credit is the schedule share for their rank and (fee) is accounted for the treasury; the sum credited for a match equals what was escrowed for it.
SOLIDITY_SKETCH: ghosts.credited[M][p] += delta of withdrawable[p] attributed to M at the terminal transition (finalize/_refundAll handlers);
  Cancelled: eq(ghosts.credited[M][p], stake - disc[p].eth); Settled: Σ_p credited[M][p] (+treasury) == stake*n - disc.eth
GHOST_NEEDS: credited[matchId][player], creditedTreasury[matchId]
SNAPSHOT_NEEDS: withdrawable[actors, treasury] at terminal calls
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: _refundAll natspec ("credits every seat what it paid back"); _distribute comment "the pool is always fully assigned and nothing can be stranded".
RATIONALE: Pair symmetry per match rather than per call; also checks that a refund through bridgeJoin (JoinRefunded) is not later also seated.
```

---

Total: 42 properties (ST-01..ST-30 = 30, VT-01..VT-06 = 6, VS-01..VS-06 = 6).

## Points worth a human look (EXPLORATORY leads surfaced while mapping)

1. `StakedLms.requestUnstake` overwrites `unlockAt` with `now + cooldown` for the whole pending amount. After the timelock lowers `cooldown`, a second small request shortens the wait of LMS requested earlier, which contradicts "Pending ones keep theirs" and the vote-exposure argument. Covered by the EXPLORATORY sub-claim in ST-19.
2. `_refundAll` takes the discount-free fast path when `matchDiscount.eth == 0`, which skips the LMS refund loop. If a seat's discount can be zero ETH while paying non-zero LMS (tiny stake, very low `lmsPerEthDiscount`, rounding in `quoteLmsDiscount`), the LMS would be stuck in the escrow and `totalLmsEscrowed` never decremented. `_joinWithLms` reverts `NoDiscount` only for `discount == 0`, so `eth` is > 0 for any LMS-paying seat, which probably prevents this; ST-11 and VS-03 check it anyway (low probability).
3. `bridgeJoin` evaluates `_joinFailure` (value vs stake before rostered check); a matchmade lobby with a non-rostered player and a short value returns `StakeTooLow` rather than `NotRostered`. Harmless, but the reason mapping in ST-24 should accept either.
