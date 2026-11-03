# Entry Point Map

> Last Man Standing | 77 entry points | 29 permissionless | 23 role-gated | 25 admin-only

Inherited OpenZeppelin entry points are not counted:
- `Ownable2Step.transferOwnership`, `acceptOwnership` and `renounceOwnership` on every owned contract.
- `Governor.propose`, `castVote*`, `queue`, `execute` and `cancel` on `LmsGovernor`.
- ERC-20, ERC-721 and Votes transfers, delegation and `permit`.

---

## Protocol Flow Paths

### Setup (Timelock / Deploy)

`ProtocolConfig` constructor → `setRulesHash()` → `setRandomnessOracle()` → `setAttestorSet()` → `setChallengeWindow()`  ◄── `isComplete()` gates every lobby
`ChainlinkVrfAdapter.setConsumer(escrow)`  ◄── the Safe adds the adapter to its VRF subscription off-chain
`setLmsToken()` → `setLmsPerEthDiscount()` (optional) · `setBridgeReceiver()` (optional) · `setMatchmaker()` (optional)

### Match Lifecycle (Player / Keeper / Attestors)

`[setup above]` → `GameEscrow.createMatch()` | `createMatchmade()` (Matchmaker)
  → `join()` | `joinWithLms()` | `joinFor()` (via `ZapJoin`, `SessionKeyDelegate`) | `bridgeJoin()` (via `BridgeJoinReceiver`)
  → `lockMatch()`  ◄── lobby full, or join window over with ≥ minSeats
  → `fulfillRandomness()` (oracle)  ◄── VRF answer; `ChainlinkVrfAdapter.deliver()` retries
  → `settle()`  ◄── attestor quorum signature, before the settle deadline
  → [challenge window, plus 48 h per open dispute] ├─→ `dispute()` (seated) ─→ `dismissDispute()` / `veto()` (guardian)
                                                   └─→ `finalize()`  ◄── sequencer up for ≥ 1 h
  → `withdraw()` | `withdrawFor()` | `BridgeJoinReceiver.withdrawToChainFor()`  ◄── player's EIP-712 signature

Exits to Cancelled: `cancelMatch()` (Open/Pending/Live past their deadline) · `abortMatch()` (Live, quorum) · `veto()` (Proposed) → `withdraw()`

### Fees & Rewards

`[finalize above]` → `FeeRouter.harvest()` → `StakedLms.depositRewards()` → [stream over `rewardDuration`] → `StakedLms.claimRewards()`
`[finalize of a matchmade match above]` → [fee epoch ends] → `RewardsDistributor.claim()` → `RewardVesting.grant()` → [26-week vest] → `RewardVesting.release()` → `StakedLms.deposit()`

### Staking & Governance

`StakedLms.deposit()` → [snapshot] → `LmsGovernor.propose/castVote/queue` → [timelock delay] → `execute`
`StakedLms.requestUnstake()` → [cooldown] → `StakedLms.claim()`
`MultisigPhase.schedule()/cancel()` (Safe, before `phaseEnd`) → [phaseEnd] → `MultisigPhase.retire()`

---

## Permissionless

### `GameEscrow.join()` / `joinFor()`

| Aspect | Detail |
|--------|--------|
| Visibility | external payable, `whenNotPaused` |
| Caller | Player, or periphery paying for `player` (`joinFor`) |
| Parameters | matchId (user-controlled), player (user-controlled, `joinFor`), msg.value (user-controlled, must equal stake) |
| Call chain | `→ GameEscrow._joinWithStake() → _open() → _seat()` |
| State modified | `seatNumber`, `seatOrigin`, `matchSeats`, `info.seatCount`, `totalEscrowed` |
| Value flow | ETH: caller → escrow |
| Reentrancy guard | no |

### `GameEscrow.joinWithLms()` / `joinWithLmsPermit()`

| Aspect | Detail |
|--------|--------|
| Visibility | external payable, `whenNotPaused` |
| Caller | Player |
| Parameters | matchId, lmsIn (user-controlled); deadline, v, r, s (user-signed permit, attempted not required) |
| Call chain | `→ LmsToken.permit() (try) → GameEscrow.quoteLmsDiscount() → _seat() → LmsToken.safeTransferFrom()` |
| State modified | seat state as `join`, `seatDiscount`, `matchDiscount`, `totalLmsEscrowed`, `totalEscrowed` (+stake − discount) |
| Value flow | ETH and LMS: player → escrow |
| Reentrancy guard | no |

### `GameEscrow.createMatch()`

| Aspect | Detail |
|--------|--------|
| Visibility | external, `whenNotPaused` |
| Caller | Anyone (private lobby) |
| Parameters | stake, maxSeats (user-controlled, bounded by config) |
| Call chain | `→ ProtocolConfig.isComplete/getParams/rulesHash/challengeWindow/getPayoutSchedule → _currentTerms()` |
| State modified | `matchNonce`, `matchInfo`, `terms`, `termsIdOf`, `termsCount` |
| Value flow | None |
| Reentrancy guard | no |

### `GameEscrow.lockMatch()`

| Aspect | Detail |
|--------|--------|
| Visibility | external, `whenNotPaused` |
| Caller | Keeper or anyone |
| Parameters | matchId (user-controlled) |
| Call chain | `→ ProtocolConfig.randomnessOracle/attestorSetVersion → ChainlinkVrfAdapter.requestRandomness() → VRFCoordinator.requestRandomWords()` |
| State modified | `info.status = Pending`, `info.oracle`, `info.attestorSetVersion`, `info.deadline` |
| Value flow | None (VRF billed to the Safe subscription) |
| Reentrancy guard | no |

### `GameEscrow.finalize()`

| Aspect | Detail |
|--------|--------|
| Visibility | external, `nonReentrant`, not paused |
| Caller | Keeper or anyone |
| Parameters | matchId, ranking (user-controlled, must hash to `rankingHash`) |
| Call chain | `→ _checkSequencer() → SequencerFeed.latestRoundData() → _distribute() → _credit() → _recordFees() (matchmade) → LmsToken.burn()` |
| State modified | `info.status = Settled`, `totalEscrowed`, `withdrawable`, `totalOwed`, `feesPaid`, `epochFees`, `totalLmsEscrowed` |
| Value flow | Internal credits; LMS burned |
| Reentrancy guard | yes |

### `GameEscrow.cancelMatch()`

| Aspect | Detail |
|--------|--------|
| Visibility | external, `nonReentrant`, not paused |
| Caller | Anyone, past the phase deadline |
| Parameters | matchId (user-controlled) |
| Call chain | `→ _refundAll() → _credit() → LmsToken.safeTransfer()` |
| State modified | `info.status = Cancelled`, `totalEscrowed`, `withdrawable`, `totalOwed`, `totalLmsEscrowed` |
| Value flow | Internal credits; LMS escrow → seats |
| Reentrancy guard | yes |

### `GameEscrow.withdraw()` / `withdrawFor()` (PullPayable)

| Aspect | Detail |
|--------|--------|
| Visibility | external, `nonReentrant`, not paused |
| Caller | Owner of balance (`withdraw`), anyone for `account` (`withdrawFor`, ≥ 0.0001 ETH) |
| Parameters | to (user-controlled) / account (user-controlled; pays only `account`) |
| Call chain | `→ PullPayable._payOut() → to.call{value}` |
| State modified | `withdrawable[account] = 0`, `totalOwed` |
| Value flow | ETH: escrow → `to` / `account` |
| Reentrancy guard | yes |

### `BridgeJoinReceiver.withdrawToChainFor()`

| Aspect | Detail |
|--------|--------|
| Visibility | external, `nonReentrant` |
| Caller | Session relayer or anyone |
| Parameters | w (user-signed: player, hubChainId, destinationChainId, recipient, outputToken, maxFee, nonce, deadline); q (submitter-controlled, not signed: outputAmount, quoteTimestamp, fillDeadline, exclusiveRelayer, exclusivityParameter); signature |
| Call chain | `→ SignatureChecker.isValidSignatureNow() → GameEscrow.withdrawToBridge() → PullPayable._payOut() → AcrossSpokePool.depositV3{value}` |
| State modified | `nonces[player]`; escrow `withdrawable[player]`, `totalOwed` |
| Value flow | ETH: escrow → receiver → Across SpokePool |
| Reentrancy guard | yes |

### `SessionKeyDelegate.executeWithSession()`

| Aspect | Detail |
|--------|--------|
| Visibility | external (runs as the 7702-delegated EOA) |
| Caller | Session relayer or anyone |
| Parameters | target, value, data, nonce (user-signed by session key); signature |
| Call chain | `→ ECDSA.recover() → _checkCall() → _spend() → GameEscrow.join{value}() / withdrawFor(self)` |
| State modified | `sessions[key].spent`, `Layout.nonce` (in the account) |
| Value flow | ETH: account → escrow (join) / escrow → account (withdrawFor) |
| Reentrancy guard | no (nonce bumped before the call) |

### `ZapJoin.joinWithToken()`

| Aspect | Detail |
|--------|--------|
| Visibility | external, `nonReentrant` |
| Caller | Player |
| Parameters | matchId, path (user-controlled, arbitrary pools and hooks), maxAmountIn, deadline (user-controlled) |
| Call chain | `→ GameEscrow.getMatch() → PoolManager.unlock() → ZapJoin.unlockCallback() → PoolManager.swap()* → IERC20.safeTransferFrom(player → PoolManager) → PoolManager.take() → GameEscrow.joinFor{value: stake}()` |
| State modified | None locally; escrow seat state |
| Value flow | ERC-20: player → PoolManager; ETH: PoolManager → ZapJoin → escrow |
| Reentrancy guard | yes |

### `SpokeRouter.join()` (deployed on spokes)

| Aspect | Detail |
|--------|--------|
| Visibility | external payable |
| Caller | Player on a spoke chain |
| Parameters | matchId, hubRecipient (user-controlled), quote (user-controlled) |
| Call chain | `→ AcrossSpokePool.depositV3{value: msg.value}(depositor = msg.sender, recipient = hubReceiver, message)` |
| State modified | None |
| Value flow | ETH: player → Across (spoke) |
| Reentrancy guard | no |

### `FeeRouter.harvest()`

| Aspect | Detail |
|--------|--------|
| Visibility | external, `nonReentrant` |
| Caller | Keeper or anyone |
| Parameters | none |
| Call chain | `→ GameEscrow.withdraw(FeeRouter) → StakedLms.depositRewards{value}() → treasury.call{value}` |
| State modified | Escrow `withdrawable[FeeRouter]`, `totalOwed`; StakedLms stream state |
| Value flow | ETH: escrow → FeeRouter → StakedLms / treasury |
| Reentrancy guard | yes |

### `StakedLms.deposit()` / `depositFor()` / `depositWithPermit()`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | LMS holder |
| Parameters | amount, account (user-controlled); permit sig (user-signed, attempted) |
| Call chain | `→ LmsToken.safeTransferFrom() → _mint() → _update() → _accrue() → _settle() → _delegate()` |
| State modified | sLMS balances, `totalSupply`, votes checkpoints, `rewardPerShareStored`, `settledAt`, `owed` |
| Value flow | LMS: holder → StakedLms |
| Reentrancy guard | no |

### `StakedLms.depositRewards()`

| Aspect | Detail |
|--------|--------|
| Visibility | external payable |
| Caller | FeeRouter, or anyone donating |
| Parameters | msg.value (user-controlled) |
| Call chain | `→ _accrue()` |
| State modified | `rewardRate`, `periodFinish`, `lastAccrual`, `rewardPerShareStored` |
| Value flow | ETH: caller → StakedLms |
| Reentrancy guard | no |

### `StakedLms.claimRewards()` / `requestUnstake()` / `claim()`

| Aspect | Detail |
|--------|--------|
| Visibility | external (`claimRewards` is `nonReentrant`) |
| Caller | Staker (self-scoped) |
| Parameters | to / amount / receiver (user-controlled) |
| Call chain | `claimRewards → _accrue() → _settle() → to.call{value}` · `requestUnstake → _burn()` · `claim → LmsToken.safeTransfer()` |
| State modified | `owed`, `settledAt` · balances, `totalUnstaking`, `unstakeOf` · `unstakeOf`, `totalUnstaking` |
| Value flow | ETH: StakedLms → to · none · LMS: StakedLms → receiver |
| Reentrancy guard | `claimRewards` yes, others no |

### `RewardsDistributor.claim()`

| Aspect | Detail |
|--------|--------|
| Visibility | external, `nonReentrant` |
| Caller | Anyone, for any `player` |
| Parameters | player, epochs (user-controlled) |
| Call chain | `→ GameEscrow.feesPaid() → _fixRate() → GameEscrow.epochFees() → LmsToken.safeTransfer(vesting) → RewardVesting.grant()` |
| State modified | `claimedBits[player]`, `rates[epoch]`; vesting `trancheOf`, `totalGranted` |
| Value flow | LMS: distributor → vesting |
| Reentrancy guard | yes |

### `RewardVesting.release()`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | Anyone, for any `player` |
| Parameters | player, epochs (user-controlled) |
| Call chain | `→ releasable() → LmsToken.safeTransfer(player)` |
| State modified | `trancheOf[player][epoch].released`, `totalReleased` |
| Value flow | LMS: vesting → player |
| Reentrancy guard | no |

### `ChainlinkVrfAdapter.deliver()`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | Anyone |
| Parameters | vrfId (user-controlled; must be answered) |
| Call chain | `→ GameEscrow.fulfillRandomness() (try) ` |
| State modified | `requests[vrfId]` deleted on success; escrow `info.seed/deadline/status` |
| Value flow | None |
| Reentrancy guard | no |

### `MultisigPhase.retire()`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | Anyone, after `phaseEnd` |
| Parameters | none |
| Call chain | `→ TimelockController.renounceRole(PROPOSER) → renounceRole(CANCELLER)` |
| State modified | Timelock role membership |
| Value flow | None |
| Reentrancy guard | no |

### `PlayerAvatars.mint()` / `equip()` / `unequip()`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | Any wallet (self-scoped; `equip` needs token ownership) |
| Parameters | tokenId (user-controlled) |
| Call chain | `mint → _safeMint() → onERC721Received (caller, if contract) → _update()` |
| State modified | `hasMinted`, `totalMinted`, ERC-721 ownership, `equipped` |
| Value flow | None |
| Reentrancy guard | no |

---

## Role-Gated

| Role | Contract | Function | Gate | Parameters | State Modified |
|------|----------|----------|------|------------|----------------|
| Matchmaker | GameEscrow | `createMatchmade()` | `msg.sender == config.matchmaker()` (`:318`) | stake, maxSeats, roster (keeper-provided) | match state, `rostered`, `matchmade` |
| Bridge receiver | GameEscrow | `bridgeJoin()` | `msg.sender == config.bridgeReceiver()` (`:490`) | matchId, player, originChainId (from an untrusted Across message) | seat state or `withdrawable[player]` |
| Bridge receiver | GameEscrow | `withdrawToBridge()` | same (`:510`), `nonReentrant` | account (protocol-derived from signature) | `withdrawable[account]`, `totalOwed` |
| Snapshotted oracle | GameEscrow | `fulfillRandomness()` | `msg.sender == info.oracle` (`:547`) | matchId, randomness (keeper-provided) | `seed`, `deadline`, `status = Live` |
| Attestor quorum | GameEscrow | `settle()` | `checkQuorum(version, digest, sigs)`; `nonReentrant`, `whenNotPaused` | rounds, historyRoot, transcriptHash, ranking (user-signed by attestors) | `status = Proposed`, `historyRoot`, `rounds`, `deadline`, `rankingHash`, `transcriptHash` |
| Attestor quorum | GameEscrow | `abortMatch()` | `checkQuorum(...MatchAbort)`; `nonReentrant` | matchId, signatures | `_refundAll` state |
| Seated player | GameEscrow | `dispute()` | `seatNumber[matchId][msg.sender] != 0` (`:719`) | evidenceHash (user-controlled) | `disputedSeats`, `disputed`, `deadline` |
| Guardian / governance | GameEscrow | `veto()` | `_onlyGuardianOrGovernance` (`:891`); `nonReentrant` | matchId | `_refundAll` state |
| Guardian / governance | GameEscrow | `dismissDispute()` | same | matchId | `disputed`, `deadline` |
| Guardian | GameEscrow | `pause()` (ExpiringPause) | `_isGuardian` + cooldown (`:55-57`) | none | `pausedUntil` |
| Guardian / governance | GameEscrow | `unpause()` (ExpiringPause) | `_isGuardian \|\| _isGovernance` (`:76`) | none | `pausedUntil = now` |
| Across SpokePool | BridgeJoinReceiver | `handleV3AcrossMessage()` | `msg.sender == spokePool` (`:129`); `nonReentrant` | tokenSent, amount (trusted from the pool), message (untrusted) | none locally; escrow seat/credit |
| Uniswap PoolManager | ZapJoin | `unlockCallback()` | `msg.sender == poolManager` (`:131`) | data (protocol-derived from `joinWithToken`) | none; token pull + swaps |
| Registered consumer | ChainlinkVrfAdapter | `requestRandomness()` | `isConsumer[msg.sender]` (`:87`) | context (matchId) | `requests[vrfId]` |
| VRF coordinator | ChainlinkVrfAdapter | `rawFulfillRandomWords()` | `msg.sender == coordinator` (`:108`) | vrfId, randomWords | `requests[vrfId]` answered/word, then delivery |
| Distributor | RewardVesting | `grant()` | `msg.sender == distributor` (`:69`) | player, epochs, amounts (protocol-derived) | `trancheOf`, `totalGranted` |
| Safe or owner | LiquidityReserve | `release()` | `msg.sender == safe \|\| owner()` (`:60`) | to (approved only), amount | LMS balance |
| Safe (before phaseEnd) | MultisigPhase | `schedule()` / `scheduleBatch()` / `cancel()` | `onlySafeInPhase` + `_checkCall` | target(s), value(s), data, predecessor, salt, delay / id | Timelock operations |
| Account itself (7702) | SessionKeyDelegate | `grantSession()` / `revokeSession()` | `onlySelf` (`:127`) | sessionKey, validUntil, valueCap, spendCap | `sessions[key]` |
| Governance (executor) | LmsGovernor | `setQuorumFloor()` | `onlyGovernance` | newQuorumFloor (≤ 10% of supply) | `_quorumFloorHistory` |

---

## Admin-Only

Owner is the `TimelockController` (per spec). Every action waits out the timelock delay, but takes effect immediately when it executes.

| Contract | Function | Parameters | State Modified |
|----------|----------|------------|----------------|
| ProtocolConfig | `setParams()` | Params (fee ≤ 10%, seats 2–256, stakes, windows ≤ 30 d, treasury) | `params`; `_checkDelay` |
| ProtocolConfig | `setRulesHash()` | bytes32 ≠ 0 | `rulesHash` |
| ProtocolConfig | `setPayoutSchedule()` | uint16[] summing to 10,000, length ≤ minSeats | `payoutBps` |
| ProtocolConfig | `setRandomnessOracle()` | address ≠ 0 | `randomnessOracle` |
| ProtocolConfig | `setAttestorSet()` | attestors, threshold | new version: `attestorIn`, `attestorsOf`, `thresholdOf`, `attestorSetVersion` |
| ProtocolConfig | `setGuardian()` | address (0 removes) | `guardian` |
| ProtocolConfig | `setChallengeWindow()` | 1 s – 7 d | `challengeWindow`; `_checkDelay` |
| ProtocolConfig | `setSequencerUptimeFeed()` | address (0 disables) | `sequencerUptimeFeed` |
| ProtocolConfig | `setLmsToken()` | address, once | `lmsToken` |
| ProtocolConfig | `setLmsPerEthDiscount()` | uint256 (0 disables) | `lmsPerEthDiscount` |
| ProtocolConfig | `setBridgeReceiver()` | address (0 disables) | `bridgeReceiver` |
| ProtocolConfig | `setMatchmaker()` | address (0 disables) | `matchmaker` |
| GameEscrow | `extendPause()` (ExpiringPause) | until > now, > pausedUntil | `pausedUntil` |
| FeeRouter | `setTreasury()` | address ≠ 0 | `treasury` |
| FeeRouter | `setStakerBps()` | ≤ 10,000 | `stakerBps` |
| LiquidityReserve | `setRecipient()` | recipient (not vault/safe/self/0), approved | `isApproved` |
| StakedLms | `setCooldown()` | 1 d – 30 d | `cooldown` |
| StakedLms | `sweepStray()` | to | LMS balance above `totalSupply + totalUnstaking` |
| RewardsDistributor | `setMaxRewardPerEth()` | ≤ uint120 max | `maxRewardPerEth` (unfixed epochs only) |
| RewardsDistributor | `setMaxRewardPerWalletPerEpoch()` | ≤ uint128 max | `maxRewardPerWalletPerEpoch` |
| RewardsDistributor | `sweep()` | to; after `claimsCloseAt()` | LMS balance |
| ChainlinkVrfAdapter | `setCoordinator()` | coordinator, keyHash, subId, confirmations, gas limit | coordinator config |
| ChainlinkVrfAdapter | `setConsumer()` | consumer, allowed | `isConsumer` |
| BridgeJoinReceiver | `recover()` | token, to, amount | ETH / token balance |
| PlayerAvatars | `setBaseUri()` | string | `baseUri` |

---

## Initialization

No proxies or `initialize()` functions. Every contract is configured in its constructor:
- `RewardVesting` is created by `RewardsDistributor`.
- `MultisigPhase` takes an immutable `phaseEnd`, at most 2 years out.
- `ProtocolConfig` deploys incomplete. Lobbies stay blocked until `isComplete()` is true.
