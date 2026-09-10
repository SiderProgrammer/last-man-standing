# What's left to do

Status as of the current tree. The protocol, engine, server and contracts are in place
and tested; the client does not exist yet, and several integrations are still mocks.
Items are ordered roughly by what blocks the next demo.

---

## 1. Blocking — nothing works end-to-end without these

### 1.1 The PixiJS client

`packages/client` currently contains only `package.json` and `tsconfig.json`. Nothing is
implemented. Needed:

- `index.html` + `vite.config.ts` with `@lms/protocol` aliased to source.
- **Wallet session:** connect an injected provider with viem, sign
  `Last Man Standing login\nnonce:<nonce>`, hold the account for the socket's lifetime.
- **Socket layer:** typed `ClientMessage` / `ServerMessage` transport, reconnect with
  re-auth, and a local salt store so a commitment can still be revealed after a refresh
  (losing the salt means losing the round).
- **Arena scene:** seats as HP rings, attack arrows on reveal, storm intensity by round,
  elimination animation.
- **History feed:** the `#7 → attacked #13` log, plus a per-opponent read panel
  (attack/defend/hide frequencies, favourite targets) — this is the core of the game and
  should not be a raw text dump.
- **Action bar:** three actions plus target picker, commit/reveal countdown driven by the
  `deadline` field, and a clear "revealed / waiting" indicator.
- **Betting panel:** chip stack, per-seat pot odds, one-click bet before the commit
  window closes.

### 1.2 Staked lobby flow

The server can only *adopt* a match that already exists on-chain (`chain.ts` watches
`MatchStarted`). There is no path for a player to discover or create one:

- Lobby directory over WebSocket or HTTP: open lobbies, seat counts, stake, join deadline.
- Client-side `createMatch` / `join` calls against `GameEscrow` with a viem wallet client.
- Anyone-can-call `lockMatch` trigger (a keeper loop in the server is the simplest option).
- Reconcile the two id spaces: practice matches use `deriveMatchId(0, 0x0, nonce)`, staked
  matches use the escrow's nonce. They cannot currently collide, but nothing enforces that.

### 1.3 Two failing Foundry tests

Both are test-harness problems, not contract bugs:

- `SettlementLibGasTest.test_yulIsCheaperThanReferenceOnEightSeats` — measures a
  calldata Yul path against a memory reference path through an external harness, so the
  call overhead dominates and the comparison is meaningless. Replace with a
  `forge snapshot` gas baseline committed to the repo.
- `GameEscrowTest.test_crossChainJoin_rejectsUntrustedMessengerAndPeer` — `vm.expectRevert`
  fires at the same call depth as the cheatcode. Route the call through a small external
  helper contract.

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
- Redis is in the stack list and in `config.ts` but is not used at all. Decide whether it
  is needed (presence, rate limiting, multi-instance room ownership) or drop it from the
  config surface.

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
- No reconnect/resume: a dropped socket loses the seat mapping until the next `state`.
- Commitments and reveals are held only in memory. A server restart mid-match loses the
  round and the match can only end via `cancelMatch` after the deadline. Persist the
  round log (Redis or Postgres) and restore on boot.
- The practice-room path lets any authenticated wallet create unlimited rooms.

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

- **CI:** nothing runs automatically. Add a workflow for `npm test`, `forge test`,
  `forge fmt --check`, and the deep fuzz profile on a schedule.
- **Static analysis:** Slither and Aderyn are available as MCP tooling but no run is
  committed. Add a baseline and fail CI on new findings.
- **Gas snapshots:** `npm run sol:snapshot` exists; no `.gas-snapshot` is committed, so
  regressions are invisible.
- **`.env.example`:** referenced by `.gitignore` but does not exist.
- **README:** there is no top-level README; `docs/ARCHITECTURE.md` currently carries
  everything.
- **Deployment record:** no addresses file, no verification step in `Deploy.s.sol`.
- **Nothing is committed yet.** Only `.gitmodules` and the OpenZeppelin submodule pointer
  are staged; the entire source tree — including `.gitignore` — is untracked. The repo
  needs an initial commit before any of the above can be reviewed as a diff.

---

## 5. Game design work

These are open questions, not bugs:

- **Lobby size.** The concept describes 10–50 players; `DEFAULT_RULES` caps a lobby at 8
  and the storm curve is tuned for that. Large lobbies need a re-tuned storm and probably
  multi-target rounds, plus a UI that stays readable at 50 seats.
- **Balance.** No simulation harness exists to answer "is Hide too strong at 60%?".
  The engine is pure and seeded, so a batch simulator over strategy pools is cheap to
  build and would turn balance into data.
- **Round-level on-chain betting.** Currently off-chain chips only. Moving it on-chain
  needs per-round elimination data in the escrow, which is a real protocol change.
- **Spectators.** The wire protocol supports `watch`, but there is no discovery, no
  spectator-only chip faucet policy, and no anti-collusion rule preventing a seated
  player from betting against themselves.
