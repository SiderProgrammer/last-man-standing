# 🔐 Security Review — last-man-standing

---

## Scope

|  |  |
| --- | --- |
| **Mode** | default |
| **Files reviewed** | `./contracts/script/AcrossBook.sol` · `./contracts/script/Deploy.s.sol` · `./contracts/script/DeploySpoke.s.sol`<br>`./contracts/script/Registry.sol` · `./contracts/src/Constants.sol` · `./contracts/src/Errors.sol`<br>`./contracts/src/ExpiringPause.sol` · `./contracts/src/GameEscrow.sol` · `./contracts/src/governance/FeeRouter.sol`<br>`./contracts/src/governance/LiquidityReserve.sol` · `./contracts/src/governance/LmsGovernor.sol` · `./contracts/src/governance/LmsToken.sol`<br>`./contracts/src/governance/MultisigPhase.sol` · `./contracts/src/governance/RewardsDistributor.sol` · `./contracts/src/governance/RewardVesting.sol`<br>`./contracts/src/governance/StakedLms.sol` · `./contracts/src/libraries/HashLib.sol` · `./contracts/src/libraries/SettlementLib.sol`<br>`./contracts/src/libraries/SignatureLib.sol` · `./contracts/src/oracles/ChainlinkVrfAdapter.sol` · `./contracts/src/periphery/BridgeJoinReceiver.sol`<br>`./contracts/src/periphery/SpokeRouter.sol` · `./contracts/src/periphery/ZapJoin.sol` · `./contracts/src/PlayerAvatars.sol`<br>`./contracts/src/ProtocolConfig.sol` · `./contracts/src/PullPayable.sol` · `./contracts/src/SessionKeyDelegate.sol`<br>`./contracts/src/vendor/across/AcrossMessageHandler.sol` · `./contracts/src/vendor/across/IAcrossSpokePool.sol` · `./contracts/src/vendor/across/IWETH9.sol`<br>`./contracts/src/vendor/chainlink/IVRFCoordinatorV2Plus.sol` · `./contracts/src/vendor/chainlink/VRFV2PlusClient.sol` |
| **Confidence threshold (1-100)** | 75 |

---

## Findings

[95] **1. Any caller can push the router fees into FeeRouter and lock them**

`FeeRouter.harvest` · Confidence: 95

**Description**
Any caller can call `withdrawFor(feeRouter)`, so the escrow sends the fees to FeeRouter outside `harvest`, and no function moves that ETH again.

**Fix (Option A — allow-and-handle)**

```diff
 function harvest() external nonReentrant returns (uint256 amount) {
-    amount = escrow.withdraw(address(this));
+    if (escrow.withdrawable(address(this)) != 0) escrow.withdraw(address(this));
+    amount = address(this).balance;
```

**Fix (Option B — restrict)**

```diff
+    bool private transient _harvesting;
     function harvest() external nonReentrant returns (uint256 amount) {
+        _harvesting = true;
         amount = escrow.withdraw(address(this));
+        _harvesting = false;
 ...
     receive() external payable {
-        if (msg.sender != address(escrow)) revert UnexpectedSender(msg.sender);
+        if (msg.sender != address(escrow) || !_harvesting) revert UnexpectedSender(msg.sender);
     }
```

---

[95] **2. FeeRouter accepts escrow ETH that harvest never splits**

`FeeRouter.receive` · Confidence: 95

**Description**
The `receive` function accepts every payment from the escrow, so a `withdrawFor(feeRouter)` payment lands in FeeRouter, and the stakers and the treasury never get it.

**Fix**

```diff
-    amount = escrow.withdraw(address(this));
+    if (escrow.withdrawable(address(this)) != 0) escrow.withdraw(address(this));
+    amount = address(this).balance;
```

---

[80] **3. The submitter of a signed withdrawal chooses the Across quote**

`BridgeJoinReceiver.withdrawToChainFor` · Confidence: 80

**Description**
The player signs only `maxFee`, so the submitter sets `outputAmount`, `exclusiveRelayer` and `fillDeadline`, keeps the fee allowance, or forces a WETH refund on the hub.

**Fix**

```diff
 struct Withdrawal {
     ...
     uint256 maxFee;
+    uint256 minOutputAmount;
+    address exclusiveRelayer;
+    uint32 fillDeadline;
     uint256 nonce;
     uint256 deadline;
 }
 ...
+        if (q.outputAmount < w.minOutputAmount) revert FeeTooHigh(amount - q.outputAmount, w.maxFee);
+        if (q.exclusiveRelayer != w.exclusiveRelayer || q.fillDeadline != w.fillDeadline) revert BadSignature();
```

---

[80] **4. The guardian can end a pause that governance set**

`ExpiringPause.unpause` · Confidence: 80

**Description**
The `unpause` function accepts the guardian for any pause, so a compromised guardian ends a pause that governance extended and play starts again.

**Fix**

```diff
+    bool public governancePause;
     function extendPause(uint64 until) external {
         ...
+        governancePause = true;
     }
     function unpause() external {
-        if (!_isGuardian(msg.sender) && !_isGovernance(msg.sender)) revert NotGovernance();
+        bool gov = _isGovernance(msg.sender);
+        if (!gov && !(_isGuardian(msg.sender) && !governancePause)) revert NotGovernance();
         if (!paused()) revert ExpectedPause();
         pausedUntil = uint64(block.timestamp);
+        governancePause = false;
```

---

[80] **5. The Safe can move the timelock LMS and keep votes after the phase**

`MultisigPhase._checkCall` · Confidence: 80

**Description**
The `_checkCall` function blocks only timelock targets and ownership selectors, so the Safe schedules a transfer of the timelock LMS and keeps the votes after `phaseEnd`.

**Fix**

```diff
     function _checkCall(address target, bytes calldata data) private view {
         bytes4 selector = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
         if (
             target == address(timelock) || selector == Ownable.transferOwnership.selector
                 || selector == Ownable.renounceOwnership.selector
+                || target == address(lmsToken) || target == address(stakedLms)
+                || selector == LiquidityReserve.setRecipient.selector
         ) revert ForbiddenCall(target, selector);
     }
```

---

[75] **6. An unset ATTESTOR makes the deployer key the only attestor**

`Deploy._attestors` · Confidence: 75

**Description**
The script uses the deployer as the attestor when `ATTESTOR` and `ATTESTORS` are unset, so the deployer key alone signs every match result on any chain.

**Fix**

```diff
     function _attestors(address deployer) private view returns (address[] memory attestors) {
         address[] memory fallbackAttestors = new address[](1);
-        fallbackAttestors[0] = vm.envOr("ATTESTOR", deployer);
+        fallbackAttestors[0] = vm.envOr("ATTESTOR", _local() ? deployer : address(0));
         attestors = vm.envOr("ATTESTORS", ",", fallbackAttestors);
         if (attestors.length == 0) attestors = fallbackAttestors;
+        for (uint256 i; i < attestors.length; ++i) {
+            if (attestors[i] == address(0) || (!_local() && attestors[i] == deployer)) revert("attestor not set");
+        }
     }
```

---

[75] **7. Any caller can lock refundable lobbies that bill the VRF subscription**

`GameEscrow.lockMatch` · Confidence: 75

**Description**
Any caller can fill and lock a cheap private lobby, so each lock bills one VRF request to the shared subscription, and `cancelMatch` returns every stake.

**Fix**

```diff
     function lockMatch(uint256 matchId) external whenNotPaused {
+        MatchInfo storage info = _matches[matchId];
+        if (!info.matchmade && msg.sender != info.creator) revert NotCreator();
```

---

[75] **8. The Safe can batch a stake of the timelock LMS for itself**

`MultisigPhase.scheduleBatch` · Confidence: 75

**Description**
The `scheduleBatch` function uses the same short denylist, so the Safe schedules an approve and a `depositFor` of the timelock LMS and keeps the sLMS votes.

**Fix**

```diff
         for (uint256 i; i < targets.length; ++i) {
+            if (values[i] != 0) revert ForbiddenCall(targets[i], bytes4(0));
             _checkCall(targets[i], payloads[i]);
         }
```

---

[75] **9. The Safe can schedule a spend of the timelock treasury**

`MultisigPhase.schedule` · Confidence: 75

**Description**
The `schedule` function passes any `value` and any token transfer, so the Safe spends the timelock LMS and ETH, and governance cannot cancel it in the delay.

**Fix**

```diff
     ) external onlySafe {
+        if (value != 0) revert ForbiddenCall(target, bytes4(0));
         _checkCall(target, data);
         timelock.schedule(target, value, data, predecessor, salt, delay);
```

---

[75] **10. Any caller can block a signed bridge withdrawal with withdrawFor**

`PullPayable.withdrawFor` · Confidence: 75

**Description**
Any caller can call `withdrawFor(player)` first, so the signed `withdrawToChainFor` reverts with `NothingToWithdraw` and the player gets the ETH on the hub.

**Fix**

```diff
     function withdrawFor(address account) external nonReentrant returns (uint256 amount) {
+        if (msg.sender != account) revert NotAccount();
         uint256 owed = withdrawable[account];
```

---

[75] **11. A leaked session key can seat the account in a hostile lobby**

`SessionKeyDelegate.executeWithSession` · Confidence: 75

**Description**
The session scope allows `join` for any match, so a person with a leaked key seats the account in a lobby that the person filled, and wins the stake.

**Fix**

```diff
         if (target == address(escrow) && data.length == 36) {
-            if (selector == GameEscrow.join.selector) return selector;
+            if (selector == GameEscrow.join.selector) {
+                uint256 matchId = abi.decode(data[4:], (uint256));
+                if (escrow.getMatch(matchId).matchmade && escrow.rostered(matchId, address(this))) return selector;
+            }
```

---

[75] **12. A voter can transfer sLMS after the vote and skip the cooldown**

`StakedLms._update` · Confidence: 75

**Description**
The sLMS token transfers freely, so a voter sells the sLMS after the snapshot and has no exposure when the proposal executes.

**Fix**

```diff
     function _update(address from, address to, uint256 value) internal override {
+        if (from != address(0) && to != address(0)) revert TransfersDisabled();
         _accrue();
```

---

Findings List

| # | Confidence | Title |
|---|---|---|
| 1 | [95] | Any caller can push the router fees into FeeRouter and lock them |
| 2 | [95] | FeeRouter accepts escrow ETH that harvest never splits |
| 3 | [80] | The submitter of a signed withdrawal chooses the Across quote |
| 4 | [80] | The guardian can end a pause that governance set |
| 5 | [80] | The Safe can move the timelock LMS and keep votes after the phase |
| 6 | [75] | An unset ATTESTOR makes the deployer key the only attestor |
| 7 | [75] | Any caller can lock refundable lobbies that bill the VRF subscription |
| 8 | [75] | The Safe can batch a stake of the timelock LMS for itself |
| 9 | [75] | The Safe can schedule a spend of the timelock treasury |
| 10 | [75] | Any caller can block a signed bridge withdrawal with withdrawFor |
| 11 | [75] | A leaked session key can seat the account in a hostile lobby |
| 12 | [75] | A voter can transfer sLMS after the vote and skip the cooldown |

---

## Leads

_Vulnerability trails with concrete code smells where the full exploit path could not be completed in one analysis pass. These are not false positives — they are high-signal leads for manual review. Not scored._

- **A low relayer gas limit may send a valid join to Unroutable** — `BridgeJoinReceiver.handleV3AcrossMessage` — Code smells: try/catch around `escrow.bridgeJoin` with no gas floor, relayer-chosen gas, funds held until timelock `recover` — A relayer may give too little gas, so `bridgeJoin` fails and the stake stays in the receiver. We did not prove a gas value that makes the catch path succeed.
- **A new bridge receiver strands fills sent to the old one** — `BridgeJoinReceiver.handleV3AcrossMessage` — Code smells: `bridgeJoin` reads `config.bridgeReceiver()` live, the revert is caught as `Unroutable`, the player has no claim path — Governance can replace the receiver while fills are in flight, so the old receiver holds those stakes until a proposal returns them. We did not measure fill times against the delay.
- **An out-of-gas delivery may roll back the stored VRF word** — `ChainlinkVrfAdapter.rawFulfillRandomWords` — Code smells: try/catch in `_deliver` forwards 63/64 of gas, the catch emits a revert reason, VRF does not retry — If delivery runs out of gas, the whole callback may revert and the match waits one hour for a refund. We estimated 100k to 120k gas against a 200k limit and did not prove it.
- **The role check does not compare roles with the deployer** — `Deploy._assertSeparateRoles` — Code smells: the comment says the deployer is checked, the code compares only safe, guardian, timelock and matchmaker — A `SAFE` or `GUARDIAN` equal to the deployer passes the check. We did not find a default that sets them equal.
- **A zero startedAt from the uptime feed skips the grace period** — `GameEscrow._checkSequencer` — Code smells: `startedAt == 0` is accepted, `until = 0 + SEQUENCER_GRACE_PERIOD` is always in the past — The function does not reject a zero `startedAt`, so `finalize` skips the grace period. We did not confirm that the Base feed returns zero.
- **The finalize caller picks the epoch that counts the fees** — `GameEscrow._recordFees` — Code smells: the epoch is `block.timestamp` at finalize, anyone can finalize after the deadline — A player can delay finalize into a quiet epoch with a higher reward rate. The per-ETH and per-wallet caps limit the gain, and we found no profit above them.
- **Each dismissal lets another seat extend the deadline again** — `GameEscrow.dismissDispute` — Code smells: the deadline is restored after a dismissal, a new seat can dispute, the delay invariant counts one extension — Seated players can dispute in turn, so a payout waits several extensions. We did not find a config change that harms such a match.
- **A losing player can delay every payout with a free dispute** — `GameEscrow.dispute` — Code smells: no bond on `dispute`, each dispute adds 48 hours, another seat can dispute after each dismissal, `matchLifetime` counts one extension — A seated player delays the winners by 48 hours or more, until the guardian dismisses each dispute. We did not prove a loss of funds.
- **A quorate lobby can be locked long after its join deadline** — `GameEscrow.lockMatch` — Code smells: no upper time limit on `lockMatch`, the oracle and attestor set are read at lock time — Any caller can lock an old lobby, so a queued oracle or attestor change reaches a match that was already open. We found no value transfer from this.
- **Settle does not check the settle deadline** — `GameEscrow.settle` — Code smells: no `block.timestamp` check against `info.deadline` for a Live match, `cancelMatch` opens at the same deadline — Attestors can settle a match after its deadline, and a losing player can cancel first to block a late result. We did not build a path that takes funds.
- **A bridge receiver set by the Safe can take every player balance** — `GameEscrow.withdrawToBridge` — Code smells: the Safe can schedule `setBridgeReceiver`, `withdrawToBridge` pays any balance to the receiver, governance cannot cancel a Safe operation in time — The Safe can name a receiver it controls and take player balances after the delay. We did not confirm the intended trust in the Safe.
- **The Safe can approve its own address as a reserve recipient** — `LiquidityReserve.setRecipient` — Code smells: `setRecipient` blocks only vault, safe, self and zero, `MultisigPhase` allows the call — The Safe can approve an address it controls and release the liquidity share to stake and vote. The docs may accept this as Safe power.
- **The stored quorum floor can rise above its cap as LMS burns** — `LmsGovernor.maxQuorumFloor` — Code smells: the cap is 10% of the current supply, `finalize` burns LMS, the stored floor is never checked again — Settlement burns LMS, so the floor can rise above 10% of the supply. We did not find a supply level that blocks governance.
- **A one-percent holder can pass proposals that move player balances** — `LmsGovernor.quorum` — Code smells: a quorum floor of 1% of supply, the Safe veto ends after one year, proposals can call `setBridgeReceiver` and `setAttestorSet` — After the multisig phase, a holder of about 1% of LMS can pass a proposal that takes player balances. The honest staked share at that time is unknown.
- **A caller with no code yet becomes the hub player** — `SpokeRouter.join` — Code smells: the check `msg.sender.code.length != 0` passes for a contract in its constructor or not yet deployed — Another party that controls that address on the hub gets the stake. This is self-harm, so the impact is low.
- **Forced accruals strand reward dust in StakedLms** — `StakedLms._accrue` — Code smells: `rewardPerShareStored` is floored on each accrual, a 1-wei transfer forces an accrual, no ETH sweep — Any caller can force an accrual every block, and each one strands less than one wei per share. We found no input that makes the loss material.

---

> ⚠️ This review was performed by an AI assistant. AI analysis can never verify the complete absence of vulnerabilities and no guarantee of security is given. Team security reviews, bug bounty programs, and on-chain monitoring are strongly recommended. For a consultation regarding your projects' security, visit [https://www.pashov.com](https://www.pashov.com)
