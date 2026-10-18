# What's left to do

Status as of the current tree. The protocol, engine, server, client and contracts are in
place, the full TypeScript and Solidity suites are green, and the practice loop plays
end-to-end in the browser. What remains is mostly integrations that are still mocks, the
trust-minimisation story, and operational work.

Items are ordered roughly by what blocks the next demo.

> **Closed on `fix/protocol-review`** (see the status table in `FIX_PLAN.md`):
> withdrawals and the result screen (§1.2), the VRF adapter's leaked `pending`
> entries (§2.2), the Redis decision — dropped (§2.3),
> unlimited practice rooms, a restart mid-match (now aborted and refunded rather
> than resumed) and gateway rate limiting (§3.2),
> the stored ranking (§3.3), and the hardwired deploy mocks (§3.4). The LayerZero
> adapter now builds per-message options and authenticates the originating app
> (§2.1), but the real `@layerzerolabs` interfaces are still not vendored and no
> two-testnet run has happened.

---

## 1. Blocking — nothing works end-to-end without these

### 1.1 Staked lobby flow against a live chain

The pieces exist and typecheck, but they have only run against mocks:

- `ChainBridge` (`packages/server/src/chain/bridge.ts`) polls `MatchCreated`, publishes a lobby
  directory, locks a full or expired lobby with the keeper key, and opens a room when the
  match goes `Live`. It has **never been run against a real RPC** — no integration test
  covers the poll loop, and the 5 000-block backfill window on restart is a guess.
- The client can `createMatch`, `join` and watch, but the flow has only been exercised in
  practice mode. Needs a run against a local Anvil fork with the deploy script.
- **Reconnect on the staked path:** the client re-sends `watch` after re-auth, but a
  player who joins on-chain before the room exists gets no feedback beyond a toast.
- Reconcile the two id spaces: practice matches use `deriveMatchId(0, 0x0, nonce)`, staked
  matches use the escrow's nonce. They cannot currently collide, but nothing enforces it.

### 1.2 Client gaps

The client plays a full match, but these are missing:

- **Withdrawals.** `Wallet.withdraw` and `withdrawable` exist and are unused — there is no
  UI for claiming a payout after settlement.
- **Result screen.** A finished match prints one line into the history feed. It should
  show the final ranking, the payout, and the settlement transaction hash.
- **Spectator discovery.** `watch` works, but live matches are only listed if they came
  from the chain directory; practice rooms are invisible to everyone but their player.
- **A relayed join can be double-submitted.** Joining through the session key sends the
  relay and returns at once, without disabling the Stake button, so a second click
  relays a second `join` that reverts `AlreadyJoined` on-chain — at the relayer's gas.
  The lobby row also keeps saying *Stake* until the next directory refresh.
- **Token joins cost two transactions the first time.** `approve`, then `joinWithToken`.
  Permit2, or EIP-2612 `permit` for USDC, would fold the approval into one signature.
  The slippage allowance is fixed at 0.5%; there is no control for it.

---

## 2. Integrations that are still mocks

### 2.1 LayerZero

`LayerZeroMessenger` is written against a local minimal interface and exercised with
`MockLayerZeroEndpoint`. Before a testnet run:

- Vendor the real `@layerzerolabs` endpoint interfaces and reconcile the ABI.
- Implement the native-drop options encoding — value-carrying joins currently assume
  `defaultOptions` already encodes a drop equal to the stake, which is not enforced
  anywhere. Add a quote-and-verify path so a join cannot be sent with insufficient drop.
- Wire peer configuration on both ends and test hub↔spoke against two live testnets.
- Handle delivery failure: a stake that leaves the spoke but never seats on the hub is
  currently unrecoverable. It is now *detected*: `chain/crossChain.ts` pairs every
  `JoinForwarded` with the hub's `PlayerJoined`/`JoinRefunded` and pages on one that
  stays unanswered (`lms_crosschain_stuck`, see `docs/OBSERVABILITY.md`). Recovery
  still needs an on-chain path.

### 2.2 Chainlink VRF

`ChainlinkVrfAdapter` targets a minimal local coordinator interface.

- Confirm against the real VRF v2.5 coordinator ABI and subscription flow.
- Fund and register the subscription in the deploy script; add the adapter as a consumer.
- Handle the "request never fulfilled" path — the escrow already refunds after
  `joinWindow + settleWindow`, but the adapter leaks a `pending` entry per dead request.

### 2.3 Postgres and Redis

- `PostgresArchive` is written but never exercised: `pg` is not installed and there is no
  migration, integration test, or docker-compose service.
- Redis is in the stack list but is not used at all. Decide whether it is needed
  (presence, rate limiting, multi-instance room ownership) or drop it from the stack.

---

## 3. Protocol and security gaps

### 3.1 Disputes are guardian-decided, not on-chain

A proposed result waits out `challengeWindow` before it pays, and the guardian Safe can
`veto` it in that time, refunding every stake. Detection is the off-chain replay every
browser already runs. That is the intended trust level for testnet and a low-stake early
mainnet. Still open:

- **The rounds are not public yet.** They are broadcast to the match's own players and
  archived in the server's database, but nothing serves the archive, so the Safe can only
  replay a disputed match from a player's copy. A read-only archive endpoint is the
  minimum; pinning each match's log (IPFS or similar) removes the server from the path.
- **Nobody watches yet.** A veto needs someone to notice. A small watcher that replays
  every `ResultProposed` against the archive and alerts the Safe signers would close that.
- **On-chain fraud proof, later.** A Solidity kernel, `MatchVerifier`, bonded and
  slashable attestors and cross-language vectors were built and then removed (they are in
  `fadf583`). Bring them back once the rules are frozen and stakes justify maintaining
  two engines.

### 3.2 Server-side hardening

- ~~No rate limiting, message size cap, or connection cap on the gateway.~~ Done: see
  `gateway/limits.ts`. Connection caps (global, per IP, connect rate), an origin
  allowlist, `ws` `maxPayload`, per-socket buckets with a separate one for moves, a
  per-IP login budget ahead of the ERC-1271 verifier, a per-wallet relay budget, a strike
  bucket that disconnects persistent offenders, slow-consumer eviction, and a ping/pong
  heartbeat. Limits are per process: a second instance would need shared state.
- Commitments and reveals are held only in memory, deliberately. A match that was live
  when the server restarts is not resumed: `ChainBridge` has the attestor quorum call
  `GameEscrow.abortMatch`, which refunds every seat at once, and falls back to the
  permissionless `cancelMatch` at the settlement deadline when it cannot.
- ~~The practice-room path lets any authenticated wallet create unlimited rooms.~~ One
  per wallet and a global ceiling (`MAX_PRACTICE_ROOMS`).
- ~~The login nonce is single-use per connection but never expires within it.~~ A socket
  that has not logged in within `LOGIN_TIMEOUT_MS` is closed, which expires its nonce.
- The keeper key doubles as the attestor key by default. Splitting them would mean a
  compromised keeper cannot also sign results.

### 3.3 Contract review items

- `GameEscrow.settle` stores the full ranking (`matchRanking`) on every settlement — one
  SSTORE per seat, and nothing on-chain reads it any more. Consider dropping it for the event.
- `SpokeEscrow.join` trusts the caller's `stake` argument for the event only; the hub is
  the authority, but a mismatch produces a confusing failure. Quote the hub's stake instead.
- Token governance is in place (`LmsGovernor` over staked LMS), with the
  fee keeper, ETH rewards for stakers, a staking panel and a governance screen.
  Still open: the Safe's veto over the timelock has no planned removal, and the
  whole LMS supply sits with the Safe — until it is distributed, the Safe's own
  stake decides every vote. See FEATURES.md "Token governance and staking".
- No deploy script for spokes. `SpokeEscrow`, `LayerZeroMessenger` and
  `ChainlinkVrfAdapter` are plain `Ownable`; each must be constructed with a timelock
  (fed by a Safe on that chain) as owner. Consider `Ownable2Step` for them too.

---

### 3.4 Known-wrong, deliberately preserved

Found during the staged refactor. Every one was left exactly as it was, because that
refactor was strictly behaviour-preserving. Nothing here is a design choice, and nothing
here is a bug report against the refactor — these all predate it.

Where a test pins the current behaviour, it is named. Those tests exist so that fixing
any of this is a deliberate, visible change rather than a silent one.

**Server and protocol**

- **`loadConfig` validates nothing.** `Number(env.X ?? default)` yields `NaN` for any
  non-numeric value and nothing rejects it. A `NaN` `COMMIT_MS` makes `Room`'s
  `now < deadlineAt` false forever, so every round resolves on the first tick and the
  match ends instantly, with nothing logged. `ESCROW_ADDRESS` and `SESSION_DELEGATE` are
  unchecked casts, so a typo reaches viem instead of failing at boot — note
  `parseCollections` already regex-checks addresses, so the validation exists and is
  applied to the least important setting. Pinned by `packages/server/test/config.test.ts`.
- **One key silently takes three roles.** `KEEPER_PK` falls back to `ATTESTOR_PK`, and
  `main.ts` then uses `keeperPk` as the session relayer's gas key. Result attestor,
  lobby keeper and session relayer end up the same account with nothing logged. Splitting
  them is already noted in §3.2; this records the exact path.
- **`MemoryArchive` and `PostgresArchive` disagree on matchId case.** Memory keys on
  `toLowerCase()`; Postgres stores and queries the id verbatim. One port, two behaviours.
  Dormant, because nothing calls `load`. Pinned by `packages/server/test/store.test.ts`.
- ~~**Client frames are cast, not validated.**~~ Fixed: `parseClientMessage` checks every
  field of every message (addresses, bytes32, hex, uint256 decimals, uint8 targets,
  actions) and rebuilds the message from the checked fields only.
- **The wire's `code` field is decorative.** `wire.ts` reserves a machine-readable code,
  `errorFrame` always sends `REJECTED`, and the client never reads it — while the
  engine's `MatchError` carries a real code that is discarded at the boundary. Either
  forward it or drop the field; both are wire changes. It is funnelled through one
  function now, so either is a single edit.
- **Three error conventions coexist.** Typed `MatchError` in the engine, bare
  `new Error(string)` in the server, swallow-and-log at the edges. Server tests assert on
  message *substrings*, so the prose is currently part of the API — which is why the
  messages were not touched.
- **`replay.ts` duplicates `match.ts` on purpose.** The initial state, the per-round fold
  and the ranking rule are written out twice. **This must not be de-duplicated**: sharing
  them would make `verifyResult` a tautology, since a wrong ranking rule would produce a
  wrong result and a wrong replay that agree perfectly. Guarded by the replay differential
  in `packages/engine/test/properties.test.ts`, which now covers both bot strategies and
  a lobby with silent seats.

**Client**

- **A network send still happens during a render pass.** `phasePlan` decides
  `shouldReveal` and `screens/match.ts` acts on it at the same point in the same order as before.
  The send is no longer hidden inside a predicate, but rendering and acting are still
  coupled; a second render in the reveal phase is prevented only by the `revealedRound`
  guard.
- **`Arena` never removes seats.** `this.seats` only grows, so switching from an 8-seat
  match to a 4-seat one leaves orphan views at stale positions, and `destroy()` exists
  but is never called. A long session leaks views and Pixi textures.
- **`reads.ts:tellFor` has an unreachable branch.** The outer guard admits
  `attacks >= 3 || revealed >= 5`, then the inner one re-requires `attacks >= 3`, so
  `revealed >= 5` can never fire alone. Fixing it changes which tell is shown. Pinned by
  `packages/client/test/reads.test.ts`.
- **`hpLeaders` is O(n²)** — `state.history.indexOf(record)` inside a loop over
  `state.history`. Bounded by `maxRounds: 30`, so currently harmless; the caller already
  has the index.
- **`data-action` is unvalidated.** `index.html` hardcodes `1|2|3` and `screens/match.ts` does
  `Number(dataset.action) as ActionValue`, though `isActionValue` exists in
  `@lms/protocol` and is used server-side. Malformed markup sends a garbage action rather
  than failing.
- **`io/net.ts` has no `off()`,** `connect()` has no re-entrancy guard, and `close()` is
  never called. One handler is ever registered, so nothing leaks in practice.
- **Port `8787` is hardcoded in three places** — `app.ts`, `packages/client/vite.config.ts`
  and `.claude/launch.json`. Two are JSON and cannot import a TS constant.

**Contracts**

- **`UntrustedMessenger` has two incompatible signatures for one failure:**
  `(uint32,address)` in `GameEscrow`, `(address)` in `SpokeEscrow`. Different selectors,
  both asserted on in tests. Unifying is an ABI break, so only the signature-*identical*
  errors were hoisted into `src/Errors.sol`. Same reasoning leaves `UnknownRequest`
  (declared four times with three different argument types), `UntrustedPeer` and
  `UnknownMatch` alone.
- **`BPS_DENOMINATOR = 10_000` is declared three times with two types** — `uint16` in
  `GameEscrow` and `ProtocolConfig`, `uint256` in `HashLib`. Retyping changes promotion
  behaviour in the payout-schedule validation for no reader benefit.
- **`Deploy.s.sol` deploys `MockMessenger` but never calls `setRemoteChain`,** so
  `receiveMessage` rejects every cross-chain join on a fresh deployment and
  `withdrawToChain` reverts with `NoMessengerForChain`.
- **`Deploy.s.sol` hardwires the mocks** with no env switch, and no deployed addresses
  are recorded anywhere. (The timelock now accepts config ownership during the deploy.)
- **`GameEscrow` re-implements pausing** rather than using OpenZeppelin `Pausable`,
  which emits different events and reverts a different error. The modifier was renamed
  `whenNotPaused`; adopting OZ would be an ABI break.
- **Five tests use bare `vm.expectRevert()`** — `GameEscrow.t.sol` (×2),
  `SpokeEscrow.t.sol`, `ProtocolConfig.t.sol`, `SessionKeyDelegate.t.sol`. They pass on
  *any* revert, including one from an unrelated cause. Every other test pins the selector.
- **`EscrowInvariant.t.sol` re-implements `Fixtures.setUp`** with materially different
  parameters (1h vs 2h settle window, 2 vs 3 attestors, 6 actors vs 8). Unifying would
  change what the invariant explores, so only the attestor-signing routine was extracted.
- **The invariant's recorded revert counts are noise.** The campaign is unseeded: three
  consecutive runs of identical code gave 8099, 8064 and 7975. Those `.gas-snapshot`
  lines cannot be used to detect a changed revert surface. Seeding the campaign would
  make them meaningful.
- **`forge fmt --check` does not pass, and did not before this work.** Fifteen files
  under `contracts/src` disagree with the configured formatting. Running `forge fmt`
  would fix it in one mechanical, behaviour-preserving commit — deliberately not done
  here, because it would have buried the review diff of every contract stage.
- **Two Foundry naming conventions coexist:** `test_snake_camel` everywhere except
  `PlayerAvatars.t.sol` and `SessionKeyDelegate.t.sol`, which use
  `test_PascalCaseSentence`. Renaming changes `.gas-snapshot` keys.

---

## 4. Tooling and process

- **CI:** nothing runs automatically. Add a workflow for `npm test`, `npm run typecheck`
  (which now also typechecks `test/**`, via a `tsconfig.test.json` per package),
  `forge test`, `npm run sol:snapshot:check`, and the deep fuzz profile on a schedule.
  `forge fmt --check` cannot be part of it until the formatting in §3.4 is fixed.
- **Static analysis:** Slither and Aderyn are available as MCP tooling but no run is
  committed. Add a baseline and fail CI on new findings.
- **Client tests:** done. The pure modules — `game/phase.ts`, `game/reads.ts`,
  `ui/views.ts`, `ui/format.ts`, `arena/layout.ts`, `arena/choreography.ts` — are covered
  by `packages/client/test`. What is still untested is the DOM applier layer in
  `screens/` and `wallet/flows.ts`, and `arena/`'s rendering, all of which would need a
  browser rather than node.
- **Load testing:** `npm run load` (see `docs/LOAD_TESTING.md`). One process tops out
  around 440 rounds/s (~1,000–1,500 practice players); past that it collapses into a
  reconnect storm. Open: load shedding, cheaper house-bot hashing, sharding by `matchId`,
  and a run from separate generator hosts at 10k.
- **Observability:** structured logs, Prometheus metrics on `METRICS_PORT`, optional
  OTLP tracing, alert rules and a Grafana dashboard under `ops/observability/`. See
  `docs/OBSERVABILITY.md`. Logs are not yet shipped anywhere; pick a collector per
  deployment.
- **Deployment record:** no addresses file, no verification step in `Deploy.s.sol`.
- **Bundle size:** the client ships one 565 kB chunk because Pixi and viem are not split.
  Fine for a testnet demo, worth code-splitting before anything public.

### Not yet exercised against a chain

Three features landed with unit coverage but have only run against mocks, for the same
reason as §1.1: no deployment has been driven end to end.

- **Avatars.** `AvatarRegistry` is unit-tested including every failure path, and the arena
  rendering was verified against stubbed entries. No `PlayerAvatars` has been deployed, so
  the read → IPFS → texture path has never run against a real token.
- **Session keys.** `SessionKeyDelegate` is covered by 22 Foundry tests over real
  `vm.signAndAttachDelegation` delegations, and the digest is pinned to the TypeScript
  side by frozen vectors. What has *not* been exercised is the browser half: viem's
  `signAuthorization` against a real wallet, and the relay round trip through the gateway.
  Needs an Anvil run with `--hardfork prague` or a Pectra testnet.
- **Lobby chain chips.** The per-chain chips in the lobby list are typed and fed by
  `ChainBridge`, but only the in-arena badges have been seen rendered — the lobby list
  needs a staked lobby to appear at all.

### Done since the last revision

- **Origin chains are visible.** Seats carry the chain they staked from all the way to a
  coloured badge in the arena and chips in the lobby list. Fixed a real defect on the way:
  `seatOrigin` stores the *messenger's* id space (LayerZero endpoint ids), which
  `ChainBridge` was assigning straight into `Seat.chainId` — a seat staked from Base
  Sepolia would have rendered as "chain 40245".
- **NFT avatars**, per chain, cosmetic, resolved off the match's critical path.
- **EIP-7702 session keys**, so reconnecting no longer costs a wallet signature.
- `.env.example` and a top-level `README.md` now exist.
- `contracts/.gas-snapshot` is committed; `npm run sol:snapshot:check` fails on drift.
- Both previously failing Foundry tests are fixed. The gas test now warms the harness
  before measuring (the first external call was paying 2 600 gas of cold-account access,
  which swamped the difference) and asserts the Yul path is never worse — currently 451
  gas cheaper on eight seats, growing with lobby size. The cross-chain revert test funds
  the caller so the call reaches the escrow instead of failing in the caller's frame.

---

## 5. Game design work

These are open questions, not bugs:

- **Lobby size.** The concept describes 10–50 players; `DEFAULT_RULES` caps a lobby at 8
  and the storm curve is tuned for that. Large lobbies need a re-tuned storm and probably
  multi-target rounds, plus a UI that stays readable at 50 seats. The arena already lays
  seats out on a circle of any size, but the labels will collide past ~16.
- **Balance.** No simulation harness exists to answer "is Hide too strong at 60%?".
  The engine is pure and seeded, so a batch simulator over strategy pools is cheap to
  build and would turn balance into data.
- **Reads.** The tells in `packages/client/src/game/reads.ts` are hand-tuned thresholds
  ("attacks ≥ 70% of revealed moves"). They are readable but arbitrary; worth validating
  against simulated play so the panel does not confidently mislabel a bot.
- **Anti-collusion.** Nothing prevents two players from splitting a lobby.
