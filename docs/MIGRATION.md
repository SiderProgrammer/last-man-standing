# Incident response and migration

What to do when a contract has a bug, a key leaks, or the protocol is being
exploited: which levers exist, who pulls them, how fast they act, and how to
move to fixed contracts.

Nothing in the protocol is upgradeable. There are no proxies, and every link
between contracts is `immutable` ([ADR 0010](adr/0010-break-freely-one-instance.md)).
So you can't fix a contract in place. A fix is either a
parameter change through `ProtocolConfig`, or a new deployment that players
move to once the old one has wound down. This document is the runbook for both.

## 1. Levers

| Lever | Who | Delay | Effect |
|---|---|---|---|
| `GameEscrow.pause()` | Guardian | Immediate | Stops `createMatch`, `createMatchmade`, every `join*`, `lockMatch`, `settle` and `withdrawToBridge` for `GUARDIAN_PAUSE` (7 days). Not again for `GUARDIAN_COOLDOWN` (7 days) after it ends. |
| `GameEscrow.extendPause(until)` | Governance (timelock) | Timelock delay | Pauses, or keeps the pause on, until `until`. No cooldown. |
| `GameEscrow.unpause()` | Guardian or governance | Immediate for the guardian | Ends a pause. The guardian ends only its own, never one governance extended or started. |
| `GameEscrow.veto(matchId)` | Guardian or governance | Immediate for the guardian | Throws out a `Proposed` result inside its challenge window and refunds every seat. Works while paused. |
| `GameEscrow.dismissDispute(matchId)` | Guardian or governance | Immediate for the guardian | Puts a disputed result back on its own deadline. |
| `GameEscrow.abortMatch(matchId, sigs)` | Attestor quorum | Immediate | Refunds a `Live` match at once. Works while paused. |
| `GameEscrow.cancelMatch(matchId)` | Anyone | Once the match's deadline passes | Refunds an `Open`, `Pending` or `Live` match that can no longer finish. Works while paused. |
| `withdraw`, `withdrawFor` | Players (a session's `withdrawFor` relayed) | Immediate | Never paused. |
| `withdrawToBridge` | `BridgeJoinReceiver` | Immediate | Stops while paused, because a bug in the receiver could reach every balance. Players still withdraw on the hub. |
| `finalize(matchId, ranking)` | Anyone | After the challenge window | **Never paused.** A `Proposed` result pays out at its deadline unless it is vetoed first. |
| `ProtocolConfig` setters | Governance (timelock) | Timelock delay | Replace the oracle, the attestor set, the guardian, the bridge receiver, the matchmaker, the fee, the windows, the rules hash or the payout schedule. |
| `FeeRouter`, `BridgeJoinReceiver`, `ChainlinkVrfAdapter`, `RewardsDistributor`, `StakedLms`, `PlayerAvatars` owner calls | Governance (timelock) | Timelock delay | Their own settings; `BridgeJoinReceiver.recover` frees value it could not route. |

### How long governance takes

With `Deploy.s.sol`'s defaults:

| Route | Time to execute |
|---|---|
| Safe → `MultisigPhase.schedule` → timelock, until `phaseEnd` | `TIMELOCK_DELAY`, 3 days |
| `LmsGovernor` proposal → timelock | `VOTING_DELAY` 1 day + `VOTING_PERIOD` 5 days + `TIMELOCK_DELAY` 3 days ≈ **9 days** |

`MultisigPhase` refuses calls to the timelock itself and any
`transferOwnership`/`renounceOwnership`, and anything that moves LMS: any
call on the token, `sweep`, `sweepStray`, `LiquidityReserve.setRecipient` and
`recover` of LMS. Everything else this runbook needs is outside that list;
LMS funding goes through a governor proposal.

The timelock delay is always longer than `ProtocolConfig.matchLifetime()`
(10 min join + 10 min lock grace + 1 h seed + 1 h settle + 1 h challenge + 48 h
dispute ≈ 51 h 20 min). So a config change never reaches a match that was
already open when the change was queued. It also means **governance can't
act on a match that is already running**: only the guardian, the attestors and
the deadlines can.

## 2. First hour, whatever the incident

1. **Guardian pauses the hub escrow.** `cast send $ESCROW "pause()" --account guardian --rpc-url $RPC`.
   Do it as soon as there is reasonable suspicion: a pause can't take or
   redirect anything, and the guardian can lift it again.
2. **Veto every suspect `Proposed` result.** The challenge window is 1 hour by
   default, and `finalize` is not paused. List them from `ResultProposed` events
   with no `MatchSettled`/`MatchCancelled` after them. If the bug is in payout
   maths itself, veto *every* `Proposed` match, not just the suspicious ones.
3. **Have the attestors abort `Live` matches** they can't vouch for
   (`abortMatch`), so players don't wait out the settle window.
4. **Stop the server's own transactions if they're part of the problem.** Unset
   `KEEPER_PK` / `SESSION_RELAYER_PK` / `MATCHMAKER_PK` and restart. The keeper
   only calls permissionless functions, so anyone can still `cancelMatch` and
   `finalize` from a shell.
5. **Queue the governance fix through the Safe right away** (`extendPause`,
   `setAttestorSet`, `setGuardian`, …). It takes 3 days and the guardian's pause
   lasts 7. Queuing on day 0 keeps play paused without a gap. After the
   multisig phase, see §7.
6. **Tell players:** what is paused, that funds can be withdrawn on the hub the
   whole time, that bridged withdrawals to a spoke wait for the pause to end, and
   when the next update comes.

Record each tx hash in the incident log as you go.

## 3. Playbooks

### 3.1 Attestor key leaked, or the server signs bad results

Results need a quorum, and `settle` checks that the ranking is exactly the
seated players. So a rogue quorum can reorder who wins inside a match, not pay
an outsider.

1. Pause (blocks `settle`). Veto every `Proposed` result signed during the
   suspect period.
2. Governance: `ProtocolConfig.setAttestorSet(newKeys, threshold)`. A match
   keeps the set it locked under, so the pause and vetoes are what protect
   matches already locked under the old set.
3. Once it has executed, let every match locked under the old version wind down
   (§4.2), then unpause.

### 3.2 Guardian key leaked

A rogue guardian can pause, end its own pause, veto (refund) and dismiss
disputes. It can't take funds, or lift a pause governance put in place.

1. Safe queues `setGuardian(newGuardian)` at once.
2. Until it executes, watch for `ResultVetoed` and `Unpaused`. To keep play
   stopped past the rogue key's reach, governance `extendPause`s: the old
   guardian cannot lift that.
3. If the rogue key dismisses honest disputes, the result still waits out its
   own challenge deadline. Players re-dispute if the window is still open.

### 3.3 Oracle compromised or down

1. Pause, so no lobby locks against it.
2. Governance: `setRandomnessOracle(newOracle)`. Matches already `Pending` keep
   the oracle they asked and cancel after `RANDOMNESS_TIMEOUT` (1 h) if no seed
   comes.
3. For VRF: deploy a new `ChainlinkVrfAdapter`, `setConsumer(escrow, true)` on it
   while the deployer still owns it, transfer it to the timelock, and have the
   Safe add it to the subscription. The Safe owns the subscription directly, so
   that part takes no delay.

### 3.4 Bridge bug (`BridgeJoinReceiver` or `SpokeRouter`)

`config.bridgeReceiver` can call `withdrawToBridge` for **any** account, so pause
first: that stops bridged withdrawals at once, without the timelock delay.

1. Governance: `setBridgeReceiver(address(0))`, queued before the guardian's pause
   runs out. That stops cross-chain joins and bridged withdrawals for good. Hub-side
   `withdraw`/`withdrawFor` keep working throughout.
2. Spoke routers are ownerless and can't be stopped. A spoke join that arrives
   after step 1 makes `bridgeJoin` revert, the receiver keeps the ETH and emits
   `Unroutable`, and the timelock pays it back with `recover`. One that arrives
   while the escrow is paused is credited to the player in the escrow
   (`JoinRefunded`, reason `Paused`).
3. Remove the spokes from the server's `SPOKES` so the client stops offering
   them.
4. Fixed receiver: deploy it against the same escrow, then `setBridgeReceiver`.
   Fixed spoke routers point their immutable `hubReceiver` at it, so every spoke
   is redeployed (`DeploySpoke.s.sol`) and `SPOKES` updated.

### 3.5 `ZapJoin` bug

Ownerless and holds nothing between calls. Unset `ZAP_JOIN` on the server so
the client stops offering it, then deploy a fixed one. Because `joinFor` is
paused with everything else, a pause also stops zaps.

### 3.6 `SessionKeyDelegate` bug

The delegate's code runs inside each player's own EOA, so a pause does not
cover it, and only the player can remove it.

1. Unset `SESSION_RELAYER_PK` so the server relays nothing.
2. Ask delegated players to call `revokeSession` on themselves, or to sign an
   EIP-7702 authorization to `address(0)` to clear the delegation.
3. Deploy a fixed delegate, set `SESSION_DELEGATE`, and players re-delegate the
   next time they log in.

### 3.7 Governance, staking or rewards bug (`LmsGovernor`, `StakedLms`, `RewardsDistributor`, `FeeRouter`)

None of these hold player stakes. During the multisig phase the Safe can
cancel a malicious queued proposal (`MultisigPhase.cancel`). For `FeeRouter`,
governance can point `ProtocolConfig.params.treasury` at a fixed router. The
old one can still `harvest` fees already credited to it. `RewardsDistributor`'s
LMS can only be swept after `claimsCloseAt()` (end of the four-year program),
so a fixed distributor has to be funded from the timelock's treasury.

### 3.8 Bug in `GameEscrow` itself

If no config change fixes it, the escrow has to be replaced: §4.

## 4. Replacing the escrow

### 4.1 What a new escrow drags with it

Everything that stores the escrow as `immutable` has to be redeployed with it:

| Contract | Why | Replacement |
|---|---|---|
| `ProtocolConfig` | Not immutable in the escrow's direction, but deploy a **new** one (below) | New, handed to the existing timelock |
| `BridgeJoinReceiver` | `escrow` immutable | New, owned by the timelock |
| `SpokeRouter` (each spoke) | `hubReceiver` immutable | `DeploySpoke.s.sol` per spoke |
| `ZapJoin` | `escrow` immutable | New, ownerless |
| `SessionKeyDelegate` | `escrow` immutable | New; players re-delegate |
| `FeeRouter` | `escrow` immutable | New, owned by the timelock, named as the new config's treasury |
| `RewardsDistributor` (+ its `RewardVesting`) | reads fees from one escrow | New, funded from the timelock |
| `ChainlinkVrfAdapter` | `setConsumer` is owner-only (3 days) | New adapter, or a proposal adding the escrow as consumer |

These stay as they are: `TimelockController`, `MultisigPhase`, `LmsToken`,
`StakedLms`, `LmsGovernor`, `VestingWallet`, `LiquidityReserve`,
`PlayerAvatars`.

**Why a new config rather than sharing the old one.** The old escrow keeps
reading its own config while it winds down: guardian, owner, bridge receiver,
attestor sets. If the new escrow shared it, pointing `bridgeReceiver` at the new
receiver would cut the old escrow off from `withdrawToBridge`. Spoke players
would then need hub gas to get their old balances out. A separate config leaves
the old escrow working exactly as before.

**Do not run `Deploy.s.sol` for this.** It deploys the whole protocol, LMS and
governance included, and overwrites `deployments/<chainId>.json`. A
replacement needs its own script that takes the existing timelock, Safe, LMS
and `StakedLms` as inputs (see §6).

### 4.2 Wind down the old escrow

Funds never get stuck: refunds, `finalize` and withdrawals aren't paused. What
you wait for is every match reaching `Settled` or `Cancelled`. Under a pause:

| Status | What happens | Worst case (defaults) |
|---|---|---|
| `Open` | No more joins; `lockMatch` is paused, so it can only be cancelled | join deadline + `LOCK_GRACE`: 20 min |
| `Pending` | The seed may still arrive (`fulfillRandomness` isn't paused) and make it `Live`; otherwise cancel | `RANDOMNESS_TIMEOUT`: 1 h |
| `Live` | `settle` is paused: `abortMatch` now, or `cancelMatch` at the settle deadline | `settleWindow`: 1 h after the seed |
| `Proposed` | Finalises at its deadline unless vetoed | challenge window 1 h, + 48 h if disputed |

Each match uses the windows in its own `Terms` (snapshotted when its lobby
opened). All of it ends within `matchLifetime()`, inside one guardian pause.

Steps:

1. Guardian pauses the old escrow. The Safe queues `extendPause(far future)` on
   it the same day: the old escrow is never meant to reopen.
2. Keep the server pointed at the old escrow while it winds down. Its keeper
   calls `cancelMatch` and `finalize` as deadlines pass. If the server is down,
   call them yourself from a shell. Both are permissionless.
3. Done when `totalEscrowed() == 0` and `totalLmsEscrowed() == 0`. Every
   `MatchCreated` now has a `MatchSettled` or `MatchCancelled`.
4. What's left is `totalOwed()`: player balances, plus the treasury's
   (`FeeRouter`) fees. Call `FeeRouter.harvest()` on the old router. Player
   balances stay withdrawable from the old escrow indefinitely (§4.4).

### 4.3 Deploy and cut over

Do this in parallel with §4.2:

1. Deploy, from a fresh deployer key: `ProtocolConfig` (owned by the deployer),
   `GameEscrow(newConfig)`, `BridgeJoinReceiver`, `ZapJoin`, `SessionKeyDelegate`,
   `FeeRouter`, `RewardsDistributor`, and a VRF adapter with the new escrow as
   consumer.
2. Configure the new config as `Deploy._configure` does: oracle, attestor set,
   rules hash, guardian, challenge window, sequencer feed, params with the new
   `FeeRouter` as treasury, `setLmsToken`, the discount rate, bridge receiver,
   matchmaker.
3. **The guardian pauses the new escrow** before anything else talks to it. The
   deployer still owns the new config until the timelock accepts it.
4. `newConfig.transferOwnership(timelock)` and the same for the VRF adapter.
   They're `Ownable2Step`, so the Safe queues `acceptOwnership()` on each.
   `MultisigPhase` allows it. The LMS funding of the new `RewardsDistributor`
   is not the Safe's to queue — `MultisigPhase` refuses any LMS move — so it
   goes through a governor proposal (about 9 days), started early.
5. Safe adds the new VRF adapter to the subscription.
6. Redeploy each spoke with `DeploySpoke.s.sol` against the new receiver.
7. After the delay, execute the batch. Check `newConfig.owner() == timelock`,
   then drop the deployer key.
8. Run the checks in §5 against the new escrow, then the guardian unpauses it.
9. Point the server at the new addresses: `ESCROW_ADDRESS`, `SESSION_DELEGATE`,
   `ZAP_JOIN`, `SPOKES`, `FEE_ROUTER`, `REWARDS_DISTRIBUTOR`, plus the new
   `deployments/<chainId>.json`. The client gets the escrow from the server, so
   it follows the restart.

Expect about 3 days with no staked play (the acceptance delay). Practice play
still works the whole time.

### 4.4 After cut-over

- **Old balances.** After the restart, the server and client only know the new
  escrow. Players with a balance left in the old one need either a "withdraw
  from the old escrow" link (`withdraw(to)` on the old address, from the
  explorer or a small page), or, for an account with one-click play, its
  relayed session `withdrawFor`. Nobody can push it to them: `withdrawFor` is
  the account's own. Get the list from `PayoutCredited`, `MatchCancelled` and
  `JoinRefunded` minus `Withdrawn`, or just read `withdrawable(addr)`.
- **Stray bridge joins.** Old spoke routers stay live and can't be stopped. A
  join sent through one lands in the old escrow and is credited to the player
  (paused → `JoinRefunded`). Keep the old receiver named in the old config so
  those players can still bridge out.
- **Fees and rewards.** The old `RewardsDistributor` still pays for epochs
  already recorded in the old escrow, but records nothing new. The epoch you cut
  over in is split between the two ledgers.
- **Match history** is per escrow address (`matchId` hashes the escrow
  address), so old and new ids never collide in the archive.

## 5. Checks

Run them before unpausing, and after any incident:

```bash
cast balance $ESCROW --rpc-url $RPC
cast call $ESCROW "totalOwed()(uint256)" --rpc-url $RPC
cast call $ESCROW "totalEscrowed()(uint256)" --rpc-url $RPC
cast call $ESCROW "totalLmsEscrowed()(uint256)" --rpc-url $RPC
cast call $ESCROW "pausedUntil()(uint64)" --rpc-url $RPC
cast call $CONFIG "owner()(address)" --rpc-url $RPC
cast call $CONFIG "guardian()(address)" --rpc-url $RPC
cast call $CONFIG "bridgeReceiver()(address)" --rpc-url $RPC
cast call $CONFIG "isComplete()(bool)" --rpc-url $RPC
```

- Solvency: `balance == totalOwed + totalEscrowed`. Same invariant as the
  Foundry suite. Anything less means ETH left without a matching debit.
- LMS: `lms.balanceOf(escrow) >= totalLmsEscrowed`.
- Roles: config owner is the timelock; guardian, Safe and timelock are three
  different addresses (`Deploy._assertSeparateRoles`).
- For a new deployment, run one staked match end to end on it before
  unpausing: join, lock, seed, settle, finalize, withdraw.

## 6. Missing pieces

These are what this runbook leans on that doesn't exist yet. Each needs a
decision before it's built:

1. **No replacement-escrow script.** §4.3 is manual today. A
   `DeployEscrow.s.sol` taking the existing timelock, Safe, LMS and `StakedLms`
   would make it one command, and its Foundry test would prove the steps.
2. **No old-escrow withdraw path in the client or server** (§4.4).
3. **No incident tooling.** Nothing lists open `Proposed` matches for the
   guardian, or pauses and vetoes in one go.

## 7. Known gaps in the levers

Found while writing this. None are fixed yet:

- **After the multisig phase there's a gap in pause coverage.** The guardian's
  pause lasts 7 days and then can't be renewed for 7 more. A governor proposal
  takes about 9 days. So from day 7 to about day 9, play resumes unless the
  exploit is fixed. During the multisig phase the Safe's 3-day route covers it.
- **Results finalise during a pause.** That's deliberate, but if the bug is in the
  payout maths, the guardian has to veto every `Proposed` match by hand within
  its window (1 hour by default).
