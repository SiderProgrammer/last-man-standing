# What's left to do

Status as of the current tree. The protocol, engine, server, client and contracts are in
place, the full TypeScript and Solidity suites are green, and the practice loop plays
end-to-end in the browser. What remains is mostly integrations that are still mocks, the
trust-minimisation story, and operational work.

Items are ordered roughly by what blocks the next demo.

---

## 1. Blocking — nothing works end-to-end without these

### 1.1 Staked lobby flow against a live chain

The pieces exist and typecheck, but they have only run against mocks:

- `ChainBridge` (`packages/server/src/chain.ts`) polls `MatchCreated`, publishes a lobby
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
- **`MatchMarket`.** The on-chain Winner / Top 3 market has no client surface at all; only
  the off-chain chip book is wired up.
- **Result screen.** A finished match prints one line into the history feed. It should
  show the final ranking, the payout, and the settlement transaction hash.
- **Spectator discovery.** `watch` works, but live matches are only listed if they came
  from the chain directory; practice rooms are invisible to everyone but their player.

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
  currently unrecoverable.

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

### 3.1 No fraud proof

This is the biggest conceptual gap. Attestors are trusted for ordering; the history root
makes a fabricated result *provable* off-chain, but nothing on-chain acts on that proof.
Needed for a real trust-minimised deployment:

- Publish the move log and salts (IPFS or calldata) so anyone can replay.
- A challenge window before payouts unlock.
- An on-chain verifier that can re-derive at least one round hash and slash a quorum that
  signed a root inconsistent with the published log.

Until then, document honestly that settlement is quorum-trusted.

### 3.2 Server-side hardening

- No rate limiting, message size cap, or connection cap on the gateway.
- Commitments and reveals are held only in memory. A server restart mid-match loses the
  round and the match can only end via `cancelMatch` after the deadline. Persist the round
  log (Redis or Postgres) and restore on boot.
- The practice-room path lets any authenticated wallet create unlimited rooms.
- The login nonce is single-use per connection but never expires within it.
- The keeper key doubles as the attestor key by default. Splitting them would mean a
  compromised keeper cannot also sign results.

### 3.3 Contract review items

- `MatchMarket.claim` marks `claimed[msg.sender]` for the whole book, so a better who
  passes an incomplete `outcomes` array forfeits the rest. Either track per-outcome claims
  or enumerate the caller's outcomes on-chain.
- `MatchMarket` has no fee and no minimum bet; dust bets are economically free spam.
- `GameEscrow.settle` stores the full ranking (`matchRanking`) on every settlement — one
  SSTORE per seat. Consider storing only the top 3 that the market actually reads.
- `SpokeEscrow.join` trusts the caller's `stake` argument for the event only; the hub is
  the authority, but a mismatch produces a confusing failure. Quote the hub's stake instead.
- Governance is a bare `TimelockController` in the deploy script. A real DAO needs a
  Governor contract, a voting token, and a documented proposal flow.

---

## 4. Tooling and process

- **CI:** nothing runs automatically. Add a workflow for `npm test`, `npm run typecheck`,
  `forge test`, `forge fmt --check`, `npm run sol:snapshot:check`, and the deep fuzz
  profile on a schedule.
- **Static analysis:** Slither and Aderyn are available as MCP tooling but no run is
  committed. Add a baseline and fail CI on new findings.
- **Client tests:** `packages/client` has no test of its own. `reads.ts` is pure and
  deserves unit tests; the commit/reveal state machine in `main.ts` should be extracted
  from the DOM wiring so it can be tested headlessly.
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
- **Reads.** The tells in `packages/client/src/reads.ts` are hand-tuned thresholds
  ("attacks ≥ 70% of revealed moves"). They are readable but arbitrary; worth validating
  against simulated play so the panel does not confidently mislabel a bot.
- **Round-level on-chain betting.** Currently off-chain chips only. Moving it on-chain
  needs per-round elimination data in the escrow, which is a real protocol change.
- **Anti-collusion.** Nothing prevents a seated player from betting against themselves in
  the elimination book, or two players from splitting a lobby.
