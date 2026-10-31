# What's left to do

Status as of the current tree. The protocol, engine, server, client and contracts are in
place, the full TypeScript and Solidity suites are green, and the practice loop plays
end-to-end in the browser. What remains is mostly integrations that are still mocks, the
trust-minimisation story, and operational work.

Items are ordered roughly by what blocks the next demo.

> **Closed on `fix/protocol-review`**:
> withdrawals and the result screen (§1.2), the VRF adapter's leaked `pending`
> entries (§2.2), the Redis decision — dropped (§2.3),
> unlimited practice rooms, a restart mid-match (now resumed from a journal, FIX_PLAN
> 7.11) and gateway rate limiting (§3.2),
> the stored ranking (§3.3), and the hardwired deploy mocks. Cross-chain joins
> moved from LayerZero to Across (§2.1, FIX_PLAN Phase 6); no two-testnet run has
> happened yet.

---

## 1. Blocking — nothing works end-to-end without these

### 1.1 Staked lobby flow against a live chain

The pieces exist and typecheck, but they have only run against mocks:

- `ChainBridge` (`packages/server/src/chain/bridge.ts`) polls `MatchCreated`, publishes a lobby
  directory, locks a full or expired lobby with the keeper key, and opens a room when the
  match goes `Live`. It has **never been run against a real RPC** — no integration test
  covers the poll loop.
- The client can `createMatch`, `join` and watch, but the flow has only been exercised in
  practice mode. Needs a run against a local Anvil fork with the deploy script.
- ~~**Reconnect on the staked path:** a player who joins on-chain before the room exists
  gets no feedback beyond a toast.~~ The server holds a `watch` for a lobby still filling
  or waiting on its seed, and tells every seat `live` when the room opens (FIX_PLAN 7.10).
- Reconcile the two id spaces: practice matches use `deriveMatchId(0, 0x0, nonce)`, staked
  matches use the escrow's nonce. They cannot currently collide, but nothing enforces it.
  Practice nonces now start at a random 64-bit offset per process, after the chaos tests
  showed ids repeating across restarts.

### 1.2 Client gaps

The client plays a full match, but these are missing:

- ~~**Withdrawals.**~~ Done: the Winnings panel and the result screen collect, through the
  server's `withdrawFor` push or the player's own `withdraw`.
- ~~**Result screen.**~~ Done: `screens/result.ts` shows the ranking, the browser's replay
  check, the settlement and the payout.
- **Spectator discovery.** `watch` works, but live matches are only listed if they came
  from the chain directory; practice rooms are invisible to everyone but their player.
- ~~**A relayed join can be double-submitted.**~~ Gone with relayed joins: the session
  key only signs logins, and every join is the player's own transaction.
- **Token joins cost two transactions the first time.** `approve`, then `joinWithToken`.
  Permit2, or EIP-2612 `permit` for USDC, would fold the approval into one signature.
  The slippage allowance is fixed at 0.5%; there is no control for it.

---

## 2. Integrations that are still mocks

### 2.1 Across

Spoke joins bridge the stake with Across: `SpokeRouter` on the spoke, `BridgeJoinReceiver`
on the hub. Hub and spoke run end to end in `npm run dev:fork` over mock SpokePools, and
the contracts run against Across's real pools in `test/fork/AcrossFork.t.sol`. What was
checked is in `docs/ACROSS.md`.

Still open:

- **A real testnet deposit.** Follow `docs/TESTNET.md` with a little testnet ETH. Across's
  testnet is unreliable and does not refund an unfilled deposit, so use small amounts.
- **Withdraw to a spoke has no screen.** `withdrawToChainFor` works on-chain and the typed
  data is in `@lms/protocol`; the client and the server's relay come with FIX_PLAN 8.5.
- **Matchmaking tickets.** The join message is `(matchId, player, origin)`; a queue ticket
  joins it with FIX_PLAN 7.9.

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

A proposed result waits out `challengeWindow` before it pays. A seated player whose
browser finds the transcript does not hold up can `dispute` it, which holds the payout 48
hours more, and the guardian can `veto` it in that time, refunding every stake, or
dismiss the dispute. That is the intended trust level for testnet and a low-stake early
mainnet. Still open:

- **The server still serves the transcripts.** `GET /transcripts/<hash>` is public and
  checked against the hash the escrow stores, so the server cannot alter one, but it can
  withhold one (players then dispute). Pinning each transcript (IPFS or similar) takes the
  server out of the path.
- **Evidence goes to the guardian by hand.** A dispute records the evidence bundle's
  hash; the player saves the bundle and sends it. An endpoint that accepts bundles by hash
  would save that step.
- **Nobody watches yet.** A veto needs someone to notice. A small watcher that audits
  every `ResultProposed` transcript and alerts the guardian, and watches `ResultDisputed`,
  would close that.
- **On-chain fraud proof, later.** A Solidity kernel, `MatchVerifier`, bonded and
  slashable attestors and cross-language vectors were built and then removed (they are in
  `fadf583`). Bring them back once the rules are frozen and stakes justify maintaining
  two engines.

### 3.2 Server-side hardening

- ~~No rate limiting, message size cap, or connection cap on the gateway.~~ Done: see
  `gateway/limits.ts`. Connection caps (global, per IP, connect rate), an origin
  allowlist, `ws` `maxPayload`, per-socket buckets with a separate one for moves, a
  per-IP login budget ahead of the ERC-1271 verifier, a per-connection payout-push cooldown, a strike
  bucket that disconnects persistent offenders, slow-consumer eviction, and a ping/pong
  heartbeat. Limits are per process: a second instance would need shared state.
- ~~Commitments and reveals are held only in memory.~~ A staked room journals every
  commit and reveal (FIX_PLAN 7.11), and a match live when the server restarts resumes
  where it was. Only one with no journal — `ARCHIVE=memory` — is aborted, refunding every
  seat at once, or cancelled at its settlement deadline when the abort cannot be sent.
- ~~The practice-room path lets any authenticated wallet create unlimited rooms.~~ One
  per wallet and a global ceiling (`MAX_PRACTICE_ROOMS`).
- ~~The login nonce is single-use per connection but never expires within it.~~ A socket
  that has not logged in within `LOGIN_TIMEOUT_MS` is closed, which expires its nonce.
- ~~The keeper key doubles as the attestor key by default.~~ Every job has its own key,
  and the attestor signs in a process of its own (FIX_PLAN 7.4).

### 3.3 Contract review items

- `GameEscrow.settle` stores the full ranking (`matchRanking`) on every settlement — one
  SSTORE per seat, and nothing on-chain reads it any more. Consider dropping it for the event.
- Token governance is in place (`LmsGovernor` over staked LMS, with a 1M-vote
  minimum quorum), with the fee keeper, streamed ETH rewards for stakers,
  on-chain play-mining for half the supply, a staking panel with both claims, and
  a governance screen. The deploy script splits the supply (play-mining, timelock,
  team vesting, Safe liquidity). Still open:
  - **The veto's removal is a rule, not code.** The plan — revoke it once players
    hold more sLMS than the team's 15%, or after twelve months — has to be carried
    out by a proposal. See FEATURES.md "The Safe's veto: when it goes".
  - **Governance is idle at launch** until players hold the quorum floor in sLMS:
    with the cap binding, 10 ETH of fees paid in settled matches (200 ETH of
    stakes), and never less than three weeks. At launch volumes that could be
    months. Decide whether that is acceptable, or whether a bootstrap stake or a
    lower floor is wanted.
  - **Play-mining parameters are guesses.** The 100k LMS per ETH cap and the
    yearly decay should be revisited against real volume before mainnet.
  - **Legal review** of the stakers' fee share (0% on mainnet by default) and of
    play-mining itself.
  - **No local test of `Deploy` with `SAFE` unset.** The suite shares process-wide
    env, so it always sets one; the case where the Safe is the deployer (the
    `dev:fork` setup) is covered only by an `assert` in `_distribute`.
- `ChainlinkVrfAdapter` is plain `Ownable`; it must be constructed with a timelock (fed
  by a Safe on that chain) as owner. Consider `Ownable2Step` for it too.

---

### 3.4 Known-wrong behaviour

The list that lived here moved to [FIX_PLAN.md](FIX_PLAN.md), where every item maps
to a step. Phase 1 fixed the mechanical ones (errors, constants, bare reverts, the
invariant fixtures and seed, the reads panel, `data-action`, `Net`, the port).

---

## 4. Tooling and process

- **CI:** `.github/workflows/ci.yml` runs typecheck, vitest and a 500-match `sim` on
  the TypeScript side, and `forge fmt --check`, `forge build` and `forge test` on the
  Solidity side, plus a coverage report and Slither. It also runs
  `sol:snapshot:check`, which is deterministic now that the fuzz seed is fixed. Still
  open: no linter for the TypeScript, and the deep fuzz profile on a schedule.
- **Static analysis:** Slither runs in CI against `contracts/slither-baseline.json`.
  Every accepted finding carries a triage note, and
  `scripts/slither-baseline.mjs` fails on a new finding or one without a note.
  Aderyn is not wired in.
- **Client tests:** done. The pure modules — `game/phase.ts`, `game/reads.ts`,
  `ui/views.ts`, `ui/format.ts`, `arena/layout.ts`, `arena/choreography.ts` — are covered
  by `packages/client/test`. What is still untested is the DOM applier layer in
  `screens/` and `wallet/flows.ts`, and `arena/`'s rendering, all of which would need a
  browser rather than node.
- **Chaos testing:** `packages/server/test/chaos.test.ts` (see `docs/CHAOS_TESTING.md`):
  seeded, reproducible runs with drops, stalls, latency, refused connects, server restarts
  and a failing relayer. Open: chain-side chaos (RPC faults, reorgs) and Across fills that
  come late or never.
- **Load testing:** `npm run load` (see `docs/LOAD_TESTING.md`). One process tops out
  around 440 rounds/s (~1,000–1,500 practice players); past that it collapses into a
  reconnect storm. Open: load shedding, cheaper house-bot hashing, sharding by `matchId`,
  and a run from separate generator hosts at 10k.
- **Deployment record:** done. Both deploy scripts write `contracts/deployments/<chainId>.json`
  on a broadcast, the server reads it for defaults, and `--verify` verifies on the explorer.
- **Bundle size:** the client ships one 565 kB chunk because Pixi and viem are not split.
  Fine for a testnet demo, worth code-splitting before anything public.

### Not yet exercised against a chain

Three features landed with unit coverage but have only run against mocks, for the same
reason as §1.1: no deployment has been driven end to end.

- **Avatars.** `AvatarRegistry` is unit-tested including every failure path, and the arena
  rendering was verified against stubbed entries. No `PlayerAvatars` has been deployed, so
  the read → IPFS → texture path has never run against a real token.
- **One-click play.** `SessionKeyDelegate` is covered by 33 Foundry tests over real
  `vm.signAndAttachDelegation` delegations, and `npm run check:one-click` runs viem's
  `signAuthorization`, the grant and a relayed join through the server's relay port on a
  Prague anvil. What has *not* run is Privy's embedded wallet signing the authorization,
  on Base Sepolia (FIX_PLAN 5.1), and the client's one-click buttons against a node.
- **Play-mining end to end** has run once by hand on `dev:fork`: a four-seat match
  played to settlement from anvil's dev accounts, the clock moved past the week's
  end, and the browser's **Claim LMS** paid the burner 50 sLMS (0.0005 ETH of fees
  at the cap). There is no script for it, and nothing has run on a testnet.
- **Lobby chain chips.** The per-chain chips in the lobby list are typed and fed by
  `ChainBridge`, but only the in-arena badges have been seen rendered — the lobby list
  needs a staked lobby to appear at all.

### Done since the last revision

- **Origin chains are visible.** Seats carry the chain they staked from all the way to a
  coloured badge in the arena and chips in the lobby list.
- **NFT avatars**, per chain, cosmetic, resolved off the match's critical path.
- **EIP-7702 one-click play** for burner and embedded wallets: relayed joins and
  withdrawals under caps, with the server paying the gas.
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
  and Strike / Guard / Charge was validated at 4–8 seats only (the skill gap grows with
  lobby size). Large lobbies need re-validated numbers and probably multi-target rounds,
  plus a UI that stays readable at 50 seats. The arena already lays seats out on a circle
  of any size, but the labels will collide past ~16.
- **Skill versus luck.** With the current rules a hard bot wins about 2× its share
  (`npm run sim`), well above the old rules. That suits a skill game, but in a staked one
  new players lose to strong ones more often; worth deciding deliberately.
- **Reads.** The tells in `packages/protocol/src/game/reads.ts` are hand-tuned thresholds
  ("strikes ≥ 70% of revealed moves"). They are readable but arbitrary; worth validating
  against simulated play so the panel does not confidently mislabel a bot.
- **Anti-collusion.** Nothing prevents two players from splitting a lobby, and with the
  current rules it pays: two colluding hard bots won 1.74× as often as two honest ones
  in validation (1.09× under the old storm rules). See "Known risk: collusion" in
  `ARCHITECTURE.md`. Matchmaking (FIX_PLAN 7.9) now assigns the lobbies that earn
  play-mining, though wallets with one owner queueing together in a quiet tier can still
  be matched with each other. Candidates still open: flagging seat pairs that never
  strike each other from the public history, and a payout schedule that pays a pact less.
