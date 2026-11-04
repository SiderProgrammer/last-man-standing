# Invariant context (Last Man Standing)

Read this before anything else. Project root: `C:\programowanie\blockchain\gambling\contracts`. All paths below are relative to it.

## Sources of understanding

- `x-ray/x-ray.md`, `x-ray/invariants.md` (46 guards, 54 inferred invariants), `x-ray/entry-points.md`.
- `../docs/ARCHITECTURE.md`, `../docs/MIGRATION.md` (section 7 lists known, accepted gaps), `../docs/adr/`, `../README.md`.
- `../docs/` also holds a recent audit report. Read what is relevant; do not re-report what it already fixed.

## THE X-RAY IS STALE: THE CODE WINS

The x-ray was taken at commit 90efcbe, before the audit-fix commits. Where it disagrees with `src/`, trust `src/`. Known differences:

- I-14 / G-30: `ExpiringPause.unpause` now refuses a guardian ending a governance pause (`pausedByGovernance`, `GovernancePause`). The invariant "the guardian can never lift a governance pause" is now enforced, so it is a SHOULD-HOLD property, not a known gap.
- G-46 and the "unsigned Across quote" surface: `BridgeJoinReceiver.withdrawToChainFor` now has the player sign the `Quote` too. The submitter chooses nothing.
- `PullPayable.withdrawFor` now requires `msg.sender == account`. The x-ray's "anyone, for account" is gone.
- `MultisigPhase._checkCall` now also refuses anything that moves LMS: any call to the token, `sweep`, `sweepStray`, `setRecipient`, and `recover` of LMS.

Check other x-ray claims against the source before relying on them. Line numbers in the x-ray are stale.

## In-scope contracts

`src/GameEscrow.sol` (inherits `src/PullPayable.sol`, `src/ExpiringPause.sol`), `src/ProtocolConfig.sol`, `src/SessionKeyDelegate.sol`, `src/governance/StakedLms.sol`, `src/governance/FeeRouter.sol`, `src/governance/RewardsDistributor.sol`, `src/governance/RewardVesting.sol`, `src/governance/LmsToken.sol`, `src/governance/LmsGovernor.sol`, `src/governance/MultisigPhase.sol`, `src/governance/LiquidityReserve.sol`, `src/periphery/BridgeJoinReceiver.sol`, `src/periphery/ZapJoin.sol`, `src/oracles/ChainlinkVrfAdapter.sol`, `src/libraries/SignatureLib.sol`, `src/libraries/SettlementLib.sol`, `src/Constants.sol`.

Out of scope: `SpokeRouter`, `PlayerAvatars`, mocks, vendor interfaces.

## Extracted starting points

**Aggregates**: `GameEscrow.totalEscrowed`, `totalLmsEscrowed`, `matchDiscount`, `epochFees`, `feesPaid`; `PullPayable.totalOwed`, `withdrawable`; `StakedLms.totalUnstaking`, `totalSupply`, `rewardPerShareStored`, `owed`, `settledAt`; `RewardVesting.totalGranted`, `totalReleased`, `trancheOf`.

**Paired operations**: join / refund; settle / veto; dispute / dismissDispute; pause / unpause; deposit / requestUnstake + claim; depositRewards / claimRewards; grant / release; schedule / cancel; grantSession / revokeSession; bridgeJoin / withdrawToBridge.

**Conversions**: `quoteLmsDiscount` (LMS to ETH at `lmsPerEthDiscount`, floor one way and ceil the other), `_fee`, `_distribute` (bps of the pool with remainder to the treasury), `rewardPerShare` and `earned` (1e27 scale), `_reward` (rate at 1e18 scale), `vested` (linear over 26 weeks), `epochBudget` (3/4 decay per year).

**Access control**: `onlyOwner` (timelock), `_onlyGuardianOrGovernance`, `_isGuardian`, `_isGovernance`, `msg.sender == config.matchmaker()`, `config.bridgeReceiver()`, `info.oracle`, `spokePool`, `poolManager`, `coordinator`, `distributor`, `safe`, `onlySelf`, attestor quorum through `checkQuorum`, `onlyGovernance`.

**Declared solvency invariant**: `address(escrow).balance == totalOwed + totalEscrowed` (`>=` once ETH is forced in).

**Existing Foundry invariants**: `test/invariant/EscrowInvariant.t.sol`, `RewardsInvariant.t.sol`, `StakedLmsInvariant.t.sol`. Do not spend effort only restating them; go beyond them. The x-ray flags that nothing covers `BridgeJoinReceiver`, `SessionKeyDelegate` or `MultisigPhase`.

## The harness (read these files)

`test/fizz/Base.sol` (deployment, actors, registries, helpers), `test/fizz/Snapshots.sol`, `test/fizz/Properties.sol`, `test/fizz/handlers/*.sol`.

Inheritance: `Base -> Snapshots -> Properties -> <Contract>Handler -> Handlers -> FuzzTester / FoundryTester`.

Facts a property must respect:

1. **Time**. Medusa moves time only by random between-call delays of up to 12 hours. Never rely on `vm.warp` persisting between calls. A property must read `block.timestamp`, never assume a value.
2. **Who pays**. Under Medusa, a pranked payable call spends the harness's ETH, not the pranked actor's. Under Foundry it spends the actor's. NEVER assert on an actor's ETH balance change around a payable call. Assert on the protocol's side (escrow balance, `totalEscrowed`, `withdrawable`). ETH an actor RECEIVES (a withdrawal) is safe to assert on.
3. **Forced ETH**. `escrow_donateETH`, `stakedLms_donateETH`, `feeRouter_donateETH` selfdestruct ETH in, and `stakedLms_donateLms` transfers LMS in. Equalities on contract balances must be `>=`, or must track donations in a ghost.
4. **Trusted roles are pranked**. `config_secondary`, `escrow_secondary`, `feeRouter_secondary` and others call as the timelock, standing in for an executed proposal, with no delay. So config can change under a running match, as a queued change eventually would. This is deliberate. A property must not treat a trusted role's legal action as a bug. `Terms` snapshotted into a match must still hold.
5. **Registries**, in `Base.sol`: `matchIds`, `vrfRequestIds`, `proposedRanking[matchId]`, `feeEpochs`, `proposals`, `scheduledOps`, `actors` (8), `signerActors` (3 EOAs with keys in `signerKeyOf`), `sessionAccounts` (2), `sessionKeys` (3). Iterate these for sum-of-parts checks. Loops are fine at this size, but `matchIds` grows: keep global properties cheap.
6. **Handlers that must fail**: `escrow_settle_badRanking_clamped`, `escrow_join_alreadySeated_clamped`, `rewards_claim_duplicateEpoch_clamped`, the forbidden modes of `multisig_secondary`, `session_execute_clamped`, and `bridge_withdrawToChainFor_clamped`. A reverted handler is invisible to the fuzzer, so "this must be refused" needs a try/catch and an assertion in the success branch.
7. **`bridge_handleOnHeldEth_clamped`** has the pool report WETH that never arrived, spending ETH the receiver already holds. The SpokePool is a trusted external. `docs/` and NatSpec should decide whether this matters. Treat any property on it as EXPLORATORY.
8. **Parameters** (`Base.sol` constants): windows are longer than `Deploy.s.sol`'s, with the same fee (5%), seats (4 to 8), stake range (0.001 to 1 ETH), and payouts (60/25/15). `config_secondary` can move them to boundaries: fee 0 or 10%, minimum stake 1 wei, seats 2 to 8, a discount rate of 0, 1 or 1e30.
9. **Pre-program epochs**. The harness starts before `rewards.firstEpoch()`. Epochs before it have zero budget.

## Rules for every property

- Global properties: `public`, prefix `property_`, no arguments, return `bool`, must not revert for any reachable state (a revert is reported as a failure). Wrap reads that can revert.
- Specific properties: `internal`, called from the handler after the protocol call, asserting with `t`, `eq`, `gte`, `lte` from `utils/PropertiesAsserts.sol`.
- Guarantee tag on every property. **SHOULD-HOLD** only with evidence you cite: NatSpec, docs, a standard, or an exact mathematical identity. **EXPLORATORY** for anything inferred.
- A trust assumption the docs accept (`docs/MIGRATION.md` section 7, or an x-ray On-chain=No that the docs own) is EXPLORATORY at most, and is not a bug if violated.
- Prefer a precise property about money, or about a state machine, over many weak ones. A property that cannot fail is worthless.
