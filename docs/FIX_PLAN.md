# Fix and change plan

How to work through every open **Fix**, **Cut** and **Defer** in
[PROTOCOL_REVIEW.md](PROTOCOL_REVIEW.md) (13 Oct 2026), in order. Where an item
is already tracked in [TODO.md](TODO.md), the section is named so the two stay
in step; tick it off in both.

Ordering principle: first close what could lose someone money the moment a
non-local deployment exists, then make the game fair, then let players get paid
reliably, then rebuild cross-chain, and only then start the large
trust-minimisation work — which has to port the *final* kernel to Solidity, so
it waits for the rules to stop moving.

Effort: **S** under a day · **M** a few days · **L** a week or more.

| Phase | Theme | Items | Effort | Gate |
| --- | --- | --- | --- | --- |
| 0 | Safe to deploy | 5 | S–M each | Before any non-local deployment |
| 1 | Fair game | 5 | S–M each | Before anyone plays for stakes |
| 2 | Players get paid, server survives | 4 | S–M each | Before a public testnet |
| 3 | Cross-chain rework | 4 | M–L total | Before any spoke is deployed |
| 4 | Trust minimisation | 2 | L | Before mainnet |
| 5 | Cleanup and product | 7 | S–M each | Any time after its dependency |

---

## Phase 0 — Safe to deploy

Contract-only, small, and each one independent. Nothing here changes the game.

### 0.1 Stop session keys from redirecting winnings · S

**Problem.** `SESSION_SCOPE` allows `GameEscrow.withdraw(address to)`. The
delegate's spend cap only meters native value leaving the account; `withdraw`
moves none and takes any recipient. The session key sits in localStorage.

**Change.**
- Add `withdrawFor(address account)` to `PullPayable`: permissionless, always
  pays `account` itself, never a caller-chosen address. Same CEI and
  `nonReentrant` as `withdraw`.
- Remove `withdraw` from `SESSION_SCOPE` in
  `packages/client/src/wallet/wallet.ts`. The relayer (or anyone) can now push a
  player's payout to the player with `withdrawFor`, so one-click play loses
  nothing and the key never needs a payout permission.
- Update the scope comment in `wallet.ts` and the `grantSession` JSDoc.

**Tests.** `withdrawFor` pays the account and not the caller; reverts on zero
balance; solvency invariant handler gets a `withdrawFor` action. Client test
that `SESSION_SCOPE` contains no payout selector.

**Note.** `withdrawFor` also removes most of the reason for `withdrawToChain`
(3.1): a keeper can push spoke players' payouts on the hub without them holding
hub gas.

### 0.2 Session allowlist that actually resets · S–M

**Problem.** `revokeSession` deletes the session but not its `permitted`
entries, so re-granting the same key with a narrower scope keeps every selector
granted before. Separately, the delegate uses plain storage slots 0–2 *inside
the player's EOA*: if the player ever delegates to a different 7702 wallet
implementation, the two layouts collide.

**Change.**
- Move all delegate state into an ERC-7201 namespaced struct
  (`lms.session.v1`).
- Give each grant an id: `Session` gains `uint32 epoch`; `permitted` is keyed
  `[sessionKey][epoch][target][selector]`; `grantSession` increments a
  per-key epoch, so a re-grant starts from an empty allowlist. `revokeSession`
  needs no loop.
- Regenerate `sessionKeyDelegateAbi` and re-pin the TS digest test in
  `packages/protocol/test/session.test.ts` if the typed data changes (it should
  not).

**Tests.** Grant A+B, revoke, re-grant A only → B reverts
`SessionNotPermitted`. Storage-slot test asserting nothing is written below
the namespace.

**Note.** No `SessionKeyDelegate` is deployed yet, so there are no live
accounts on the old layout to migrate.

### 0.3 Lock down the VRF adapter · S

**Problem.** `ChainlinkVrfAdapter.requestRandomness` is open to anyone and
bills the protocol's subscription.

**Change.** Owner-managed `consumers` allowlist (the escrow); revert
`NotConsumer` otherwise. While there, delete the `pending` / `vrfIdOf` entries
on fulfilment (TODO.md §2.2 notes the leak) and switch the adapter to
`Ownable2Step` (TODO.md §3.3).

**Tests.** Non-consumer reverts; fulfilment clears both mappings.

### 0.4 Deploy refuses mocks off a local chain · S

**Problem.** `Deploy.s.sol` always deploys `MockRandomnessOracle` (whose
`fulfill` anyone may call — anyone picks the seed) and `MockMessenger`.

**Change.** Read `ORACLE` and `MESSENGER` from the environment. Deploy the
mocks only when `block.chainid == LOCAL_CHAIN_ID` (the fork dev script already
passes `--chain-id`); anywhere else, revert `MockOffLocal` unless both are set.
Also record deployed addresses to a JSON file (TODO.md §4, "Deployment
record").

**Tests.** `Deploy.t.sol`: run with a non-local chain id and no `ORACLE` →
reverts; with both set → wires them.

### 0.5 Config cannot be left unusable · S

**Problem.** `ProtocolConfig` deploys with a zero `rulesHash` and zero oracle,
and `setRulesHash(0)` is accepted.

**Change.** Reject zero in `setRulesHash` and `setRandomnessOracle`.
`GameEscrow.createMatch` reverts `ConfigIncomplete` if either is still zero —
cheaper and more robust than changing the constructor, and it protects every
deployment path, not just the script.

**Tests.** Both setters reject zero; `createMatch` on a fresh config reverts.

---

## Phase 1 — Fair game

These change the kernel and the frozen vectors. Do 1.1 and 1.2 in **one**
change so the TS/Solidity parity vectors are regenerated once, then build the
simulator, then tune 1.4 and 1.5 with it.

### 1.1 Round entropy from the revealed salts · M

**Problem.** `drawBps(seed, round, attackerSeat)` uses only public inputs; every
roll in a match is known before the first commit.

**Change.**
- `roundSeed = keccak256(abi.encode(matchSeed, round, salts))`, where `salts`
  is a `bytes32[]` in **seat order** with `0x0` for any living seat that did not
  reveal. Seat order, not sorted values: deterministic and cheap to port.
- `drawBps(roundSeed, attackerSeat)` replaces `drawBps(seed, round, nonce)`.
- The engine does not see salts today: `Match.reveal` checks them and drops
  them. Add `salt` to `DeclaredMove` (`packages/engine/src/kernel/resolve.ts`),
  compute the round seed in `Match` and in `replay.ts` **separately** (the
  duplication is deliberate — TODO.md §3.4), and add salts to the replay move
  log and the archived history.
- Mirror in `HashLib.sol` (`roundSeed`, new `drawBps`) and add frozen vectors to
  `packages/protocol/test/parity.test.ts` and `contracts/test/unit/HashLib.t.sol`.
- Assert in a test that the public snapshot never carries a salt before the
  round resolves — that is what keeps players from previewing the roll. (The
  server still sees reveals as they arrive; that is the same trust it already
  holds over the reveal window.)

**Cutover.** Old archived matches will not replay under the new kernel. Nothing
has settled on a live chain, so cut over without a version switch.

### 1.2 Cut the timeout evade bonus · S

Remove `timeoutEvadeBps` from `Rules`, the kernel's `Action.None` branch (a
no-show takes hits at 0% evade), `RULES_ABI` / `hashRules`, `HashLib.hashRules`
and the literal in `Deploy.s.sol`. The rule set shrinks from 11 parameters to
10, so `rulesHash` and its vectors change — which is why this rides with 1.1.

While here, stop hardcoding the rules literal in `Deploy.s.sol`: generate it
from `DEFAULT_RULES` (a small JSON the script reads with `vm.readFile`), so the
next rules change cannot drift between TS and the deployed config.

### 1.3 A balance simulator · M

The review defers "eleven governable parameters" because none was validated by
simulation. Build that first, then tune.

- `npm run sim`: plays N matches per lobby size (4–8) with mixed bot
  strategies from `packages/engine/src/bots/strategy.ts`, including a new
  **turtle** (always Defend) and **hider** (always Hide), and reports win rate
  and average finishing place per strategy, match length, and how often the
  1-HP rescue fires.
- Acceptance targets, to write into the script: no pure strategy beats
  `1/N` win rate by more than a set margin; median match ends well before
  `maxRounds`.

### 1.4 Defend parries one attacker · S (+ tuning)

**Change.** When several players attack a defender, exactly one is parried and
takes the riposte; the rest connect. Choose the parried attacker with the round
seed from 1.1 (`drawBps(roundSeed, 1000 + defenderSeat) % attackers`), **not**
the lowest seat — seat order is public, so "lowest seat" would let the others
coordinate around it.

Re-tune `riposteDamage` with the simulator. Kernel change, so new vectors —
batch with 1.5 if they land together.

### 1.5 Fix the solved opening · S (+ tuning)

Mutual Defend is free while the storm is zero. Candidates, to choose with the
simulator rather than by hand: `stormGraceRounds` 2 → 0 or 1; a flat round-one
storm; or relying on 1.4 alone (focus fire may already break the turtle). Pick
the smallest change that meets the 1.3 targets.

---

## Phase 2 — Players get paid, the server survives a restart

### 2.1 Withdrawal and result screen · S–M

Closes "No withdrawal UI" and TODO.md §1.2. After settlement show the final
ranking, the payout, the settlement tx, and a **Collect** button that calls
`withdraw(self)` from the wallet, or asks the relayer to call `withdrawFor`
(0.1) when the player is on a session key. Show `withdrawable` in the lobby
header so a payout from a previous session is never forgotten.

### 2.2 Cap practice rooms · S

Closes "Unlimited practice rooms" and part of TODO.md §3.2. In
`Lobby.createPractice` (`packages/server/src/lobby/lobby.ts`): at most one live practice room per wallet (a new
request ends the old one) and a global ceiling from config. Add per-connection
message rate and size limits in the gateway at the same time.

### 2.3 Persist round state · M

Closes "Round state held only in memory" and TODO.md §3.2. Depends on getting
the Postgres archive running (TODO.md §2.3: install `pg`, add a migration and a
docker-compose service).

- Append each commitment and reveal to a `round_events` table as it is
  accepted; on boot, rebuild live rooms by replaying events through `Match`.
- Make the Redis call here: if one server instance is the plan, Postgres alone
  covers persistence and Redis leaves the stack (update the review's Cut). Adopt
  it only for multi-instance room ownership or presence.

**Tests.** Kill and restart a room mid-reveal in a test loop with the injected
clock; the round resolves with the same hash as an uninterrupted run.

### 2.4 In-browser verifier · S

Idea 06. Depends on 1.1 (salts must be in the published log). After settlement
the client fetches the move log, runs `replayMatch`, compares the recomputed
history root with the one in the settlement event, and shows a "verified
against chain" badge — or a loud mismatch.

---

## Phase 3 — Cross-chain rework

Do all four together; they change `ICrossChainMessenger`, `SpokeEscrow` and the
escrow's receive path at once. Folds in TODO.md §2.1.

### 3.1 Cut `withdrawToChain` and the spoke payout path · S

Delete `GameEscrow.withdrawToChain`, `SpokeEscrow.receiveMessage`, the spoke's
pull balance and `PayoutCredited`, and `withdrawToChain` from
`packages/protocol/src/chain/escrow.ts`. Spoke players collect on the hub; with
`withdrawFor` (0.1) a keeper can push it to them, so they need no hub gas.

### 3.2 Messenger that authenticates the originating app · M

Rebuild `LayerZeroMessenger` as a minimal OApp:
- `sendMessage` callable only by its local app (`receiver`).
- `lzReceive` checks `srcSender` against `peers[srcEid]` (the remote
  *messenger*), then passes the decoded **original sender** — the remote
  escrow — to the receiver as `srcSender`. The escrow's `peerFor` check then
  means what the review says it means.
- Translate LayerZero endpoint ids to chain ids inside the messenger
  (`eidOf[chainId]`, `chainIdOf[eid]`), so the escrow, the seat records and the
  client's chain chips stay in chain ids.
- Vendor the real `@layerzerolabs` interfaces (TODO.md §2.1).

### 3.3 Carry the actual stake per message · M

Add the delivered value to the interface: `quote(dst, receiver, payload,
deliverValue)` and `sendMessage(..., deliverValue)`. The messenger builds
options per call with an `lzReceive` option whose value is the stake, so every
lobby's stake arrives exactly. `SpokeEscrow.join` reads the stake from the
caller and quotes with it; drop `defaultOptions` except for the gas limit.

### 3.4 The hub never reverts a funded join · M

Closes "Stake value carried with the join message". Once a message is
authenticated, `GameEscrow.receiveMessage` must not revert because seating
failed — LayerZero would hold the message and the stake would strand. Split
`_seat` into checks that return a reason; on any seating failure (not open,
full, already seated, wrong amount, paused) credit `msg.value` to the player as
`withdrawable` and emit `JoinRefunded(matchId, player, amount, reason)`. Keep
reverting for authentication failures.

**Tests.** Each failure reason refunds; the solvency invariant gets a
cross-chain-join handler that sometimes targets full or closed lobbies.

---

## Phase 4 — Trust minimisation

Starts after Phase 1 is frozen: the fraud proof ports `resolveRound` to
Solidity, and porting it twice is the expensive mistake to avoid.

### 4.1 Bond the attestors · M–L

Idea 05; closes "Attestor quorum… no bond".
- An attestor registry (in `ProtocolConfig` or beside it): `bond()`,
  `requestUnbond()`, `unbond()` after a delay longer than the challenge window.
  Only bonded attestors count towards the threshold.
- Decide the asset: ETH is simplest and cannot be pumped by the attestors
  themselves; sLMS ties into the new governance token but makes the bond's
  value depend on the token price.
- Slashing is a governance call until 4.2 exists, then the challenge contract's.

### 4.2 Fraud proof · L

Idea 04; TODO.md §3.1.
- `settle` publishes the move log and salts (calldata, or a blob with its hash
  committed) alongside the root.
- Payouts unlock only after a challenge window. This changes `settle`'s
  accounting: credit to a pending state, finalise after the window. The
  solvency invariant needs a third bucket.
- `challenge(matchId, round, …)` re-derives one round with a Solidity port of
  `resolveRound` and the round-hash chain, and slashes every signer of a
  mismatching root.
- Differential fuzz the Solidity kernel against the TS one through generated
  vectors, the same way the Yul libraries are tested against a reference.

---

## Phase 5 — Cleanup and product

| Item | Effort | Depends on | Notes |
| --- | --- | --- | --- |
| Stop storing the full ranking on settle | S | — | Emit it in the event only. Removing `getRanking` is an ABI change; only the shared ABI references it, no caller. Also in TODO.md §3.3. |
| Avatars: auto-equip on mint only | S | — | A transfer to a wallet with no avatar should not dress it without consent. |
| Avatars: gate the free mint | S | — | Only if scarcity matters: require one settled match per minter. One-per-wallet stops nothing against a sybil. |
| Stream buybacks into the vault | M | Real fee volume | The review's Defer. Release each buyback into `totalAssets` over a period, so a deposit timed around it captures almost nothing. |
| Persist the read book across matches | M | 2.3 | Idea 07. |
| Server holds the sealed move | S | 1.1 | Idea 09. With round entropy from salts, the server must not open a held move early — same trust it already has. |
| Brackets for 10–50 players | M | Phase 1 | Idea 10. |

---

## Dependencies at a glance

- 0.1 → 2.1 (`withdrawFor` for session-key players) and 3.1 (keeper-pushed spoke payouts)
- 1.1 + 1.2 → 1.3 → 1.4, 1.5 → Phase 4
- 1.1 → 2.4, idea 09
- TODO.md §2.3 (Postgres running) → 2.3 → idea 07
- Phase 3 is internally one change; 3.4 depends on 3.2's authentication

## Decisions to make before starting

1. **0.1:** `withdrawFor` (recommended) or simply dropping `withdraw` from the
   session scope and always asking for a wallet signature to collect.
2. **1.4:** which attacker a defender parries. Round-seed choice is recommended
   over lowest seat or first-declared.
3. **2.3:** single server instance with Postgres only, or adopt Redis.
4. **4.1:** bond asset — ETH or sLMS.
