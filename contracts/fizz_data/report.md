# Fuzzing Suite Report

## Suite Overview
- **Project**: Last Man Standing (LMS), an ETH escrow for a last-man-standing elimination game. The source is `x-ray/x-ray.md`, which is stale in places; `fizz_data/invariant-context.md` records where. There is no `protocol-understanding.md`.
- **Suite location**: `test/fizz/`
- **Contracts targeted**: GameEscrow (with PullPayable and ExpiringPause), ProtocolConfig, StakedLms, RewardsDistributor, RewardVesting, FeeRouter, BridgeJoinReceiver, ZapJoin, SessionKeyDelegate, ChainlinkVrfAdapter, LiquidityReserve, MultisigPhase, LmsGovernor. LmsToken is exercised through `LmsTokenHandler`.
- **Total handlers**: 103 `contract_action` functions in `test/fizz/handlers/`, not counting internal `_x_y` helpers. 9 of them are `*_secondary` dispatchers.
- **Properties**: 61 implemented of 68 specified (29 global, 32 function-specific). 7 are not implemented.

## Coverage Results
Source: the "Final campaign" table in `fizz_data/coverage-targets.md` (Medusa, 20 minutes, `FOUNDRY_PROFILE=fuzz`). Two targets were lowered in cycle 2: RewardsDistributor to 65% and RewardVesting to 70%. The misses there are views and an unreachable `sweep` body.

| Contract | Target | Achieved | Status |
|---|---|---|---|
| GameEscrow | 80% | 97% | ✅ |
| PullPayable | 80% | 100% | ✅ |
| ExpiringPause | 60% | 100% | ✅ |
| ProtocolConfig | 60% | 87% | ✅ |
| StakedLms | 80% | 96% | ✅ |
| RewardsDistributor | 65% (adjusted from 80%) | 73% | ✅ |
| RewardVesting | 70% (adjusted from 80%) | 77% | ✅ |
| FeeRouter | 80% | 93% | ✅ |
| BridgeJoinReceiver | 50% | 94% | ✅ |
| ZapJoin | 50% | 92% | ✅ |
| SessionKeyDelegate | 50% | 79% | ✅ |
| ChainlinkVrfAdapter | 50% | 86% | ✅ |
| LiquidityReserve | 60% | 87% | ✅ |
| MultisigPhase | 60% | 72% | ✅ |
| LmsGovernor | 60% | 81% | ✅ |

Line coverage shows a line ran, not that the property around it was checked. The cycle 2 notes list these as not reached, and they were not re-checked for the final run: `LmsGovernor.setQuorumFloor` through a proposal, `Governor._cancel`, and `MultisigPhase.scheduleBatch` past its deny-list, which the handler deliberately never passes.

## Skipped Paths
| Contract | Function / Path | Reason |
|---|---|---|
| GameEscrow | `joinWithLmsPermit` | Not selected; the permit is attempted, not required. |
| StakedLms | `depositWithPermit` | Same. |
| RewardsDistributor | `claimable`, `rateOf`, `totalBudget` views; `sweep` body | The views are uncovered. `sweep` after `claimsCloseAt` is five years out, which a sequence does not reach. |
| RewardVesting | `releasableIn` view | Uncovered view. |
| BridgeJoinReceiver | lines 158, 182 | The escrow refusing the receiver, and WETH refusing to unwrap. Neither can happen with the real escrow and the mock WETH. |
| SpokeRouter | whole contract | Excluded from selection: it only deposits on a spoke chain. |
| PlayerAvatars | whole contract | Excluded from selection: it holds no funds. |
| SessionKeyDelegate | real EIP-7702 delegation | Session accounts are plain `SessionKeyDelegate` instances, not delegated EOAs. |
| Trusted roles | timelock delay | Roles are pranked as the timelock with no delay, standing in for an executed proposal. |

## Campaign Results
- **Fuzzer used**: Medusa 1.5.1. Echidna was NOT run because it is not installed.
- **Duration**: 20 minutes, 10 workers (final campaign). A 10-minute first campaign is described below.
- **Total calls**: about 249,000
- **Sequences**: 2,884
- **Branches hit**: 13,230
- **Corpus size**: 467
- **Tests**: 134 passed, 0 failed, no violation files in `corpus_medusa/test_results/`
- **Foundry wiring tests** (`FoundryTester.sol`): 9 passed
- **Violations found**: 0

**There are no confirmed protocol violations and no repro tests.** This is a weak clean result, not a proof.

- Throughput fell to about 187 calls per second once all properties were active, from about 5,000 before. 2,884 sequences is shallow, and deep multi-step states are likely under-sampled.
- 7 of 68 properties are not implemented: GL-17, SP-03, SP-22, SP-31, SP-36, SP-37, SP-38. SP-36 (reentrancy) has no hostile-recipient actor, because `Actor.receive()` is empty.
- Several implemented properties have partial coverage: SP-12, SP-14, SP-16, SP-20, SP-32, SP-33, SP-34 (see PROPERTIES.md and the handlers).
- Not exercised: a real EIP-7702 delegation, SpokeRouter, PlayerAvatars, the permit join and deposit paths, and sweep after claims close. Trusted roles are pranked with no timelock delay.
- Harness windows differ from `Deploy.s.sol`: join and settle 5 days, challenge 1 day, timelock delay 14 days, cooldown 20 days, voting period 5 days, multisig phase 30 days. A bug that depends on the deployed values would not show here.

### Violation Details
None confirmed. The first campaign (10 minutes) flagged two tests, and neither is a confirmed protocol bug.

**1. `escrow_cancelMatch_clamped`, "SP-11: a seat did not get its LMS back"**
- **Property violated**: SP-11 (refund exactness)
- **Guarantee**: SHOULD-HOLD
- **Assertion**: every seat of a cancelled match gets back its `seatDiscount.lms`.
- **Root cause**: harness bug, confirmed. The fuzzer's `stakedLms_delegate(escrow)` made the escrow a known address. SP-11 then checked the escrow's own LMS as if it were a seat. Every real seat got its LMS back in the trace.
- **Severity assessment**: test harness false positive. Fixed in the harness; it did not recur in the 20-minute run.
- **Reproducing sequence**: reproduced by deterministic Foundry replay at Medusa's addresses, chain id and time deltas. Not kept as a test.
- **Foundry repro**: N/A (no `test_repro_*` exists).

**2. `escrow_finalize_clamped`, 87-call unshrunk sequence saved at shutdown**
- **Property violated**: unknown
- **Guarantee**: unknown
- **Assertion**: unknown
- **Root cause**: UNEXPLAINED. Medusa's own trace ends without a panic. A deterministic Foundry replay at Medusa's addresses, chain id and time deltas passes; the same method reproduced case 1 exactly. It did not recur in the 20-minute run. The cause of the flag is not known.
- **Severity assessment**: needs human review. It is not a confirmed bug and not resolved. The sequence is no longer in `test_results`.
- **Reproducing sequence**: none retained in the project.
- **Foundry repro**: N/A

## Properties Implemented
Spec status comes from PROPERTIES.md: 29 of 30 global and 32 of 38 specific are `[x]`. Guarantee tags are copied from PROPERTIES.md. Confidence is an assessment from the spec and the notes on partial coverage, not a line-by-line review of each assertion. Specific properties are `internal` and called from handlers; the names are the `property_*` helpers in `Properties.sol`.

### Global (`property_*`, public)
| # | Property | Type | Guarantee | Confidence |
|---|---|---|---|---|
| GL-01 | property_escrowLedgerExact | Global | SHOULD-HOLD | HIGH |
| GL-02 | property_totalOwedIsSumOfBalances | Global | SHOULD-HOLD | HIGH |
| GL-03 | property_totalEscrowedIsSumOfLiveMatches | Global | SHOULD-HOLD | HIGH |
| GL-04 | property_lmsEscrowCustody | Global | SHOULD-HOLD | HIGH |
| GL-05 | property_matchStatusMachine | Global | SHOULD-HOLD | HIGH |
| GL-06 | property_matchRecordsImmutable | Global | SHOULD-HOLD | HIGH |
| GL-07 | property_seatBookkeeping | Global | SHOULD-HOLD | HIGH |
| GL-08 | property_matchmadeSeatsRostered | Global | SHOULD-HOLD | HIGH |
| GL-09 | property_feeLedgerConsistent | Global | SHOULD-HOLD | HIGH |
| GL-10 | property_endedEpochFrozen | Global | SHOULD-HOLD | HIGH |
| GL-11 | property_challengeDeadlineBounded | Global | SHOULD-HOLD | HIGH |
| GL-12 | property_stakedLmsBacking | Global | SHOULD-HOLD | HIGH |
| GL-13 | property_stakedLmsSumsAndVotes | Global | SHOULD-HOLD | MEDIUM (known addresses only) |
| GL-14 | property_stakedLmsRewardsCovered | Global | SHOULD-HOLD | MEDIUM (known addresses only) |
| GL-15 | property_stakedLmsEthLedger | Global | SHOULD-HOLD | HIGH |
| GL-16 | property_rewardAccumulatorsMonotone | Global | SHOULD-HOLD | HIGH |
| GL-18 | property_vestingBooks | Global | SHOULD-HOLD | MEDIUM (known addresses and seen epochs only) |
| GL-19 | property_rewardsBudget | Global | SHOULD-HOLD | HIGH |
| GL-20 | property_rateWriteOnce | Global | SHOULD-HOLD | HIGH |
| GL-21 | property_lmsSupplyConserved | Global | SHOULD-HOLD | HIGH |
| GL-22 | property_reserveCustody | Global | SHOULD-HOLD | HIGH |
| GL-23 | property_pauseFlagsConsistent | Global | SHOULD-HOLD | HIGH |
| GL-24 | property_feeRouterHoldsOnlyDonations | Global | SHOULD-HOLD | HIGH |
| GL-25 | property_sessionCaps | Global | SHOULD-HOLD | MEDIUM (plain delegate, no real 7702) |
| GL-26 | property_governanceTallies | Global | SHOULD-HOLD | MEDIUM (registered proposals only) |
| GL-27 | property_proposalStateForward | Global | SHOULD-HOLD | MEDIUM |
| GL-28 | property_phaseRetiredHasNoRoles | Global | SHOULD-HOLD | HIGH |
| GL-29 | property_ownershipAndTimelockLms | Global | EXPLORATORY | MEDIUM |
| GL-30 | property_configHistoryAndLifetime | Global | SHOULD-HOLD | HIGH |

### Function-specific
| # | Property | Type | Guarantee | Confidence |
|---|---|---|---|---|
| SP-01 | property_joinSeatAccounting | Specific | SHOULD-HOLD | HIGH |
| SP-02 | property_lmsDiscountBounds | Specific | SHOULD-HOLD | HIGH |
| SP-04 | property_createSnapshotsConfig, property_lockSnapshotsConfig | Specific | SHOULD-HOLD | HIGH |
| SP-05 | property_randomnessDelivery | Specific | SHOULD-HOLD | HIGH |
| SP-06 | property_settleProposes | Specific | SHOULD-HOLD | HIGH |
| SP-07 | property_forgedResultRejected, property_permutedFinalizeRejected | Specific | SHOULD-HOLD | HIGH |
| SP-08 | property_finalizeConserves | Specific | SHOULD-HOLD | HIGH |
| SP-09 | property_finalizePayouts | Specific | SHOULD-HOLD | HIGH |
| SP-10 | property_finalizeFeeLedger | Specific | SHOULD-HOLD | HIGH |
| SP-11 | property_refundExact | Specific | SHOULD-HOLD | MEDIUM (a harness bug was found in it) |
| SP-12 | `adversary_exitEveryMatch` and the clamped exits | Specific | SHOULD-HOLD | MEDIUM (partial; liveness half only while the sequencer feed is the mock or zero) |
| SP-13 | property_withdrawExact | Specific | SHOULD-HOLD | HIGH |
| SP-14 | exit handlers with pause mode on | Specific | SHOULD-HOLD | MEDIUM (partial) |
| SP-15 | property_guardianPause, property_extendPause, property_unpause | Specific | SHOULD-HOLD | HIGH |
| SP-16 | property_disputeTransitions, property_dismissTransitions | Specific | SHOULD-HOLD | MEDIUM (partial) |
| SP-17 | property_bridgeJoinConserves | Specific | SHOULD-HOLD | HIGH |
| SP-18 | `bridge_fill`, `bridge_fillUnroutable_clamped` | Specific | SHOULD-HOLD | HIGH |
| SP-19 | property_bridgeWithdrawOut | Specific | SHOULD-HOLD | HIGH |
| SP-20 | property_stakingNeutral, property_claimRewards | Specific | SHOULD-HOLD | MEDIUM (partial) |
| SP-21 | property_stakeDeposit, property_requestUnstake, property_claim | Specific | SHOULD-HOLD | HIGH |
| SP-23 | property_depositRewards | Specific | SHOULD-HOLD | HIGH |
| SP-24 | check after `stakedLms_unstakeEveryone_clamped` | Specific | SHOULD-HOLD | HIGH |
| SP-25 | property_sweepStray | Specific | SHOULD-HOLD | HIGH |
| SP-26 | property_harvestSplit | Specific | SHOULD-HOLD | HIGH |
| SP-27 | harvest liveness in `feeRouter_harvest` | Specific | EXPLORATORY | MEDIUM |
| SP-28 | property_rewardsClaim | Specific | SHOULD-HOLD | HIGH |
| SP-29 | property_vestingRelease | Specific | SHOULD-HOLD | HIGH |
| SP-30 | property_zapJoinConserves | Specific | SHOULD-HOLD | HIGH |
| SP-32 | property_sessionGrant, property_sessionRevoke, property_sessionExecuted | Specific | SHOULD-HOLD | MEDIUM (partial; no real 7702) |
| SP-33 | `multisig_secondary` forbidden modes | Specific | SHOULD-HOLD | MEDIUM (partial) |
| SP-34 | property_reserveSetRecipient, property_reserveRelease | Specific | SHOULD-HOLD | MEDIUM (partial) |
| SP-35 | property_accessControlMatrix | Specific | SHOULD-HOLD | HIGH |

### Specified but NOT implemented
| # | Property | Guarantee | Why it matters |
|---|---|---|---|
| GL-17 | Stream dust bound | EXPLORATORY | The rounding leak is not bounded in the harness. |
| SP-03 | `quoteLmsDiscount` zero-safe and monotone | EXPLORATORY | Rounding discipline unchecked beyond SP-02. |
| SP-22 | A later `requestUnstake` never moves an earlier `unlockAt` sooner | EXPLORATORY | `requestUnstake` overwrites `unlockAt`, so it can after the timelock cuts the cooldown. A review lead. |
| SP-31 | ZapJoin charges the rounded-up cost | EXPLORATORY | Mock-pool convention only. |
| SP-36 | Hostile ETH recipient cannot corrupt accounting | EXPLORATORY | No hostile-recipient actor. `join`, `joinFor`, `lockMatch`, `dispute`, `dismissDispute` and `bridgeJoin` are not `nonReentrant`. This is the largest gap. |
| SP-37 | A third party cannot change another account's position | SHOULD-HOLD | Only the staking half exists. |
| SP-38 | Credits only grow a balance | SHOULD-HOLD | Not wired. It would catch a path that silently zeroes a balance. |

## Open TODOs
No `TODO` or `FIXME` comments in `test/fizz/` (all `.sol` files searched). The open items are the unimplemented properties above.

## Harness Findings
- Medusa reported correct coverage only with a dedicated `[profile.fuzz]` in `foundry.toml`. Without it, the second compiler profile produces two compile units and every contract with immutables shows 0%. **Run campaigns with `FOUNDRY_PROFILE=fuzz`.**
- Slither did not run under Medusa because of a web3 version conflict in the local Python environment. Non-fatal.
- The wrapper's plateau detection looks for "branches hit", which Medusa 1.5.1 does not print. Coverage-mode runs therefore ran to their timeout.
- Files changed outside the generated suite: `contracts/foundry.toml` only (`ignored_warnings_from`, `[profile.fuzz]`).

## CI Impact if the Suite Is Committed as It Is
Verified by running with and without `test/fizz`:
- `forge build --sizes` FAILS because of the suite. `FuzzTester` is 164,800 bytes. It passes without the suite.
- `forge test` and `forge snapshot --check` already fail without the suite, because of `Deploy.t.sol::test_registryNamesEveryContract`. That failure predates this work. The suite's tests would also add snapshot lines.
- `forge fmt --check` passes.
- `fizz_data` is 184 MB and is not gitignored.

## Next Steps
1. **Run a much longer campaign.** 20 minutes at about 187 calls per second is shallow. Run for hours with the full property set, and keep the corpus between runs. Treat today's clean result as weak evidence.
2. **Investigate the unexplained `escrow_finalize_clamped` flag.** Re-run longer and keep any `test_results` file it produces. Convert it to a `test_repro_*` at once if it recurs.
3. **Implement the missing properties**, in this order:
   - SP-36: add a `ReentrantActor` whose `receive()` re-enters withdraw, join, cancelMatch, finalize, claimRewards and depositRewards, used on the payout handlers.
   - SP-38, then SP-37.
   - SP-22: expect it to fail after `_stakedLms_setCooldown` lowers the cooldown. A review lead.
   - GL-17, SP-03, SP-31.
4. **Close the partial coverage** of SP-12, 14, 16, 20, 32, 33, 34. Reach `LmsGovernor.setQuorumFloor` through a proposal, and `Governor._cancel`.
5. **Close the environment gaps.** Add a real EIP-7702 delegated account for SessionKeyDelegate, the permit join and deposit paths, SpokeRouter if it is in scope, a timelock delay for trusted roles, and one run with `Deploy.s.sol`'s real windows.
6. **Run Echidna** once it is installed, as a second engine.
7. **Before committing the suite**, fix CI: exclude `test/fizz` from the size and snapshot checks, decide whether to gitignore `fizz_data`, and fix `Deploy.t.sol::test_registryNamesEveryContract`, which fails independently of this work.

## Commands for Manual Runs
From `contracts/`:
- `FOUNDRY_PROFILE=fuzz medusa fuzz`
- `FOUNDRY_PROFILE=fuzz echidna . --contract FuzzTester --config echidna.yaml` (Echidna is not installed and has not been run)
