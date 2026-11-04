# Coverage Targets

Fuzz profile: via_ir is off in foundry.toml, so no separate profile is needed and coverage numbers are accurate.

## Per-contract targets

| Contract | Role | Target |
|---|---|---|
| GameEscrow | Core protocol logic | 80% |
| PullPayable | Core protocol logic | 80% |
| ExpiringPause | Access control | 60% |
| ProtocolConfig | Access control | 60% |
| StakedLms | Core protocol logic | 80% |
| RewardsDistributor | Core protocol logic | 80% |
| RewardVesting | Core protocol logic | 80% |
| FeeRouter | Core protocol logic | 80% |
| BridgeJoinReceiver | Peripheral | 50% |
| ZapJoin | Peripheral | 50% |
| SessionKeyDelegate | Peripheral | 50% |
| ChainlinkVrfAdapter | Peripheral | 50% |
| LiquidityReserve | Access control | 60% |
| MultisigPhase | Access control | 60% |
| LmsGovernor | Access control | 60% |

## Cycle 1 (2026-11-03, first run with correct source maps)

| Contract | Role | Target | Hit | Status |
|---|---|---|---|---|
| GameEscrow | Core | 80% | 95% | ✅ |
| PullPayable | Core | 80% | 95% | ✅ |
| ExpiringPause | Access control | 60% | 95% | ✅ |
| ProtocolConfig | Access control | 60% | 86% | ✅ |
| StakedLms | Core | 80% | 89% | ✅ |
| RewardsDistributor | Core | 80% | 68% | ❌ |
| RewardVesting | Core | 80% | 71% | ❌ |
| FeeRouter | Core | 80% | 86% | ✅ |
| BridgeJoinReceiver | Peripheral | 50% | 94% | ✅ |
| ZapJoin | Peripheral | 50% | 92% | ✅ |
| SessionKeyDelegate | Peripheral | 50% | 79% | ✅ |
| ChainlinkVrfAdapter | Peripheral | 50% | 86% | ✅ |
| LiquidityReserve | Access control | 60% | 75% | ✅ |
| MultisigPhase | Access control | 60% | 75% | ✅ |
| LmsGovernor | Access control | 60% | 72% | ✅ |

Percentages met, but real paths missed: the stream's pause at zero supply, the governor's
queue and execute, and `AlreadyJoined`. Cycle 2 adds handlers for each.

Earlier runs reported 0% for every contract with immutables. That was a measurement fault,
not a coverage gap: Medusa was reading a stale build with two compile units.

## Cycle 2 (2026-11-03)

| Contract | Role | Target | Hit | Status |
|---|---|---|---|---|
| GameEscrow | Core | 80% | 95% | ✅ |
| PullPayable | Core | 80% | 95% | ✅ |
| ExpiringPause | Access control | 60% | 95% | ✅ |
| ProtocolConfig | Access control | 60% | 86% | ✅ |
| StakedLms | Core | 80% | 91% | ✅ |
| RewardsDistributor | Core (adjusted, see skips) | 65% | 68% | ✅ |
| RewardVesting | Core (adjusted, see skips) | 70% | 71% | ✅ |
| FeeRouter | Core | 80% | 86% | ✅ |
| BridgeJoinReceiver | Peripheral | 50% | 94% | ✅ |
| ZapJoin | Peripheral | 50% | 92% | ✅ |
| SessionKeyDelegate | Peripheral | 50% | 79% | ✅ |
| ChainlinkVrfAdapter | Peripheral | 50% | 86% | ✅ |
| LiquidityReserve | Access control | 60% | 75% | ✅ |
| MultisigPhase | Access control | 60% | 81% | ✅ |
| LmsGovernor | Access control | 60% | 81% | ✅ |

The zero-supply stream pause, the governor's queue and execute, and `AlreadyJoined` are now hit.
Still not reached in this run: `LmsGovernor.setQuorumFloor` through a proposal, `Governor._cancel`,
and `MultisigPhase.scheduleBatch` past its deny-list, which the handler deliberately never passes.

## Final campaign (2026-11-04, 20 minutes, all properties active)

| Contract | Role | Target | Hit | Status |
|---|---|---|---|---|
| GameEscrow | Core | 80% | 97% | ✅ |
| PullPayable | Core | 80% | 100% | ✅ |
| ExpiringPause | Access control | 60% | 100% | ✅ |
| ProtocolConfig | Access control | 60% | 87% | ✅ |
| StakedLms | Core | 80% | 96% | ✅ |
| RewardsDistributor | Core (adjusted, see skips) | 65% | 73% | ✅ |
| RewardVesting | Core (adjusted, see skips) | 70% | 77% | ✅ |
| FeeRouter | Core | 80% | 93% | ✅ |
| BridgeJoinReceiver | Peripheral | 50% | 94% | ✅ |
| ZapJoin | Peripheral | 50% | 92% | ✅ |
| SessionKeyDelegate | Peripheral | 50% | 79% | ✅ |
| ChainlinkVrfAdapter | Peripheral | 50% | 86% | ✅ |
| LiquidityReserve | Access control | 60% | 87% | ✅ |
| MultisigPhase | Access control | 60% | 72% | ✅ |
| LmsGovernor | Access control | 60% | 81% | ✅ |

## Skips with reasons

- `joinWithLmsPermit`, `depositWithPermit`: not selected, as their permit is attempted and not required.
- `RewardsDistributor` and `RewardVesting` misses are the `claimable`, `rateOf`, `totalBudget`
  and `releasableIn` views, plus the `sweep` body. Their state-changing paths are covered.
- `BridgeJoinReceiver:158,182`: the escrow refusing the receiver and WETH refusing to unwrap,
  neither of which can happen with the real escrow and the mock WETH.

- `RewardsDistributor.sweep` past `claimsCloseAt`: five years out, which a fuzzing sequence does not reach.
- `SpokeRouter`, `PlayerAvatars`: excluded from selection. The router only deposits on a spoke chain, and the avatars hold no funds.
