# What's left to do

Open work only. What is done is in the code and its history; the decisions the
design rests on are in [adr/](adr/).

---

## 1. Checks that need a testnet

Nothing is deployed on a public chain yet: `contracts/deployments/` holds only local
nodes. Everything below waits on a hub on Base Sepolia, which needs the deploy roles
(Safe, guardian, team beneficiary, matchmaker, three attestors), a Chainlink VRF v2.5
subscription owned by the Safe and funded in ETH, and testnet ETH.
[TESTNET.md](TESTNET.md) has the steps.

### 1.1 The Privy check

One-click play for embedded wallets assumes Privy's wallet can sign an EIP-7702
authorization for *our* `SessionKeyDelegate`, not only for its own account. On Base
Sepolia:

- Privy signs the authorization for the delegate;
- the relayer submits a `join` the session key signed;
- the caps hold;
- a revoked session fails.

Privy is not in the client and not configured for any chain. It would plug in at
`Wallet.fromAccount`, which takes Privy's wallet once viem's `toAccount` wraps it.
`npm run check:one-click` runs the same checklist on a local Prague anvil, with a
local account standing in for the embedded wallet. If Privy cannot sign it, try
Turnkey; if neither can, embedded wallets use the normal flow, like injected ones.
The contracts are the same either way. The README's wallet matrix marks the Privy row
as waiting on this.

### 1.2 A real Across testnet deposit

A join from a spoke and a withdrawal back to one, over Across's real testnet
relayers. The contracts already run against Across's mainnet pools in
`test/fork/AcrossFork.t.sol`, so this is a demo more than a check. Across's testnet is
unreliable and does not refund an unfilled deposit, so use small amounts.
[ACROSS.md](ACROSS.md) and [TESTNET.md](TESTNET.md) have the steps.

### 1.3 The staked flow on a public chain

`ChainBridge`, the keeper, the session relayer, the withdrawals and the client's
staked screens have run against anvil in `npm run dev:fork` and against a fake RPC in
the unit tests, never against a public RPC.

Features that have only run against mocks, or once by hand:

- **Avatars.** `AvatarRegistry` is unit-tested including every failure path, and the
  arena rendering was checked against stubbed entries. No `PlayerAvatars` has been
  deployed, so the read → IPFS → texture path has never run against a real token.
- **Play-mining end to end** ran once by hand on `dev:fork`: a four-seat match played to
  settlement, the clock moved past the week's end, and **Claim LMS** granted the
  reward. There is no script for it. Releasing vested LMS has not run against a chain:
  it needs an ended epoch with claims. The view and the reads are unit-tested.
- **Lobby chain chips.** The per-chain chips in the lobby list are typed and fed by
  `ChainBridge`, but only the in-arena badges have been seen rendered.
- **One-click buttons** in the client have not run against a node (see 1.1).

---

## 2. Client gaps

- **Spectator discovery.** `watch` works, but live matches are only listed if they came
  from the chain directory; practice rooms are invisible to everyone but their player.
- **Token joins cost two transactions the first time:** `approve`, then
  `joinWithToken`. Permit2, or EIP-2612 `permit` for USDC, would fold the approval into
  one signature. The slippage allowance is fixed at 0.5%, with no control for it.

---

## 3. Trust and security

### 3.1 Disputes are decided by the guardian, not on-chain

A proposed result waits out `challengeWindow` before it pays. A seated player whose
browser finds the transcript does not hold up can `dispute` it, which holds the payout
48 hours more, and the guardian can `veto` it in that time, refunding every stake, or
dismiss the dispute. That is the intended trust level for testnet and a low-stake early
mainnet. Still open:

- **The server still serves the transcripts.** `GET /transcripts/<hash>` is public and
  checked against the hash the escrow stores, so the server cannot alter one, but it can
  withhold one (players then dispute). Pinning each transcript (IPFS or similar) takes
  the server out of the path.
- **Evidence goes to the guardian by hand.** A dispute records the evidence bundle's
  hash; the player saves the bundle and sends it. An endpoint that accepts bundles by
  hash would save that step.
- **Nobody watches yet.** A veto needs someone to notice. A small watcher that audits
  every `ResultProposed` transcript and alerts the guardian, and watches
  `ResultDisputed`, would close that.
- **A dispute costs only gas.** Any seated player can hold a payout back 48 hours, so a
  loser can delay every match they lose, and the guardian has to answer each one. Add a
  bond: returned on a veto or if the guardian never answers, forfeited on a dismissal.
- **The attestors are not independent.** The attestor signs in a child process of the
  server, which reads `ATTESTOR_PK` from its own environment to hand it over. Moving the
  attestor to another host is the same IPC over a socket, not done.
- **On-chain fraud proof, later.** A Solidity kernel, `MatchVerifier`, bonded and
  slashable attestors and cross-language vectors were built and then removed (they are
  in `fadf583`). Bring them back once the rules are frozen and stakes justify
  maintaining two engines.

### 3.2 Governance and the token

- **The Safe can schedule past `phaseEnd`.** `MultisigPhase` forwards `delay` unchecked,
  so a call scheduled late in the phase, or with a long delay, still runs after `retire`.
  `setBridgeReceiver` is one such call, and the receiver it names can take any player's
  balance. Stopping it takes a proposal that grants the timelock the canceller role and
  then cancels the call, which needs the quorum floor and more time than a call scheduled
  near the end leaves. Require `block.timestamp + delay <= phaseEnd` in `schedule` and
  `scheduleBatch`.
- **Governance is idle at launch** until players hold the quorum floor in sLMS: with the
  10,000 LMS per ETH cap binding, 100 ETH of fees paid in settled matches (2,000 ETH of
  stakes at the 5% fee), and rewards vest for six months first. Until then the Safe
  proposes through `MultisigPhase`. Decide whether a bootstrap stake or a lower floor is
  wanted.
- **Play-mining parameters are guesses.** The per-ETH cap and the yearly decay should be
  revisited against real volume before mainnet.
- **Legal review** of the stakers' fee share (0% on Base mainnet by default) and of
  play-mining itself.
- **No local test of `Deploy` with `SAFE` unset.** The suite shares process-wide env, so
  it always sets one; the case where the Safe is the deployer (the `dev:fork` setup) is
  covered only by an `assert` in `_distribute`.

### 3.3 Incidents and migration

The contracts cannot be upgraded, so a fix means a config change or a new deployment.
[MIGRATION.md](MIGRATION.md) is the runbook. What it found missing:

- **A pause can lapse after the multisig phase.** The guardian's pause lasts 7 days and
  cannot be renewed for 7 more, and a governor proposal takes about 9 days (1 day voting
  delay, 5 days voting, 3 days timelock). So play resumes from about day 7 to day 9
  unless the exploit is already fixed. Until `phaseEnd`, the Safe's 3-day route covers it.
- **Nothing stops bridged withdrawals quickly.** `withdrawToBridge` is not paused, and
  the bridge receiver can withdraw any account's balance, so a signature bug in
  `BridgeJoinReceiver` could drain every balance. Removing the receiver takes the
  timelock delay.
- **Payout bugs need a veto per match.** `finalize` is not paused, on purpose, so if the
  bug is in the payout maths the guardian has to veto every `Proposed` match by hand
  inside its challenge window, 1 hour by default.
- **No script to replace the escrow.** `Deploy.s.sol` redeploys the whole protocol, LMS
  and governance included, and overwrites `deployments/<chainId>.json`. A
  `DeployEscrow.s.sol` would take the existing timelock, Safe, LMS and `StakedLms`, and
  its Foundry test would prove the steps in MIGRATION.md §4.3.
- **No way to withdraw from an old escrow in the app.** The server and client know one
  escrow, so after a cut-over, balances left in the old one can only be withdrawn from
  an explorer. Add a withdraw page, or relay `withdrawFor` for every address with a
  balance.
- **No incident tooling.** Nothing lists open `Proposed` matches for the guardian, or
  pauses and vetoes in one go. The watcher in 3.1 would be the natural place for the
  list.

---

## 4. Tooling and process

- **CI:** no linter for the TypeScript, and the deep fuzz profile
  (`FOUNDRY_PROFILE=deep`) does not run on a schedule. Aderyn is not wired in.
- **Slither locally:** CI's pinned 0.11.3 does not install on Python 3.12.0, so the
  code since the server phase has only been analysed in CI.
- **Client tests:** the DOM applier layer in `screens/`, `wallet/flows.ts` and `arena/`'s
  rendering are untested; all of them need a browser rather than node.
- **Chaos testing** ([CHAOS_TESTING.md](CHAOS_TESTING.md)): no chain-side chaos (RPC
  faults, reorgs), and no Across fills that come late or never.
- **Load testing** ([LOAD_TESTING.md](LOAD_TESTING.md)): one process tops out around
  440 rounds/s (~1,000–1,500 practice players); past that it collapses into a reconnect
  storm. Open: load shedding, cheaper house-bot hashing, sharding by `matchId`, and a run
  from separate generator hosts at 10k.

---

## 5. Out of scope for now

- **One-click play on spokes:** a `chainId = 0` authorization, the delegate at the same
  address on every chain, and a relayer per spoke.
- **Stretch goals for sessions:** ERC-4337 `validateUserOp`, ERC-7739 nested typed data
  in `isValidSignature`, and P-256 session keys through RIP-7212.
- **Mainnet:** independent signers for the Safe and a gambling licence. The README says
  so.

---

## 6. Game design

These are open questions, not bugs:

- **Lobby size.** The concept describes 10–50 players; `DEFAULT_RULES` caps a lobby at 8
  and Strike / Guard / Charge was validated at 4–8 seats only (the skill gap grows with
  lobby size). Large lobbies need re-validated numbers and probably multi-target rounds,
  plus a UI that stays readable at 50 seats. The arena already lays seats out on a circle
  of any size, but the labels will collide past ~16.
- **Skill versus luck.** With the current rules a hard bot wins about 2× its share
  (`npm run sim`), well above the old rules. That suits a skill game, but in a staked one
  new players lose to strong ones more often; worth deciding deliberately.
- **Reads.** The tells in `packages/client/src/game/reads.ts` are hand-tuned thresholds
  ("strikes ≥ 70% of revealed moves"). They are readable but arbitrary; worth validating
  against simulated play so the panel does not confidently mislabel a bot.
- **Anti-collusion.** Nothing prevents two players from splitting a lobby, and with the
  current rules it pays: two colluding hard bots won 1.74× as often as two honest ones
  in validation (1.09× under the old storm rules). See "Known risk: collusion" in
  `ARCHITECTURE.md`. Matchmaking now assigns the lobbies that earn play-mining, though
  wallets with one owner queueing together in a quiet tier can still be matched with
  each other. Candidates still open: flagging seat pairs that never strike each other
  from the public history, and a payout schedule that pays a pact less.

---

## 7. Before it goes on a CV

A reviewer gives the repo a few minutes and will not run `npm run dev:fork`. Roughly in
order, with the testnet deployment from section 1 before the hosting:

- **Host it.** The client and server run only on a developer's machine: there is no
  Dockerfile, compose file or hosting config. Serve the client and a server pointed at
  Base Sepolia from a public URL.
- **Practice without a wallet.** A production build has no way in without a wallet
  extension: the burner in `wallet/flows.ts` is for dev builds, and Privy is not wired
  in. Practice needs only a login signature, so a key generated in the browser and
  limited to practice would let a visitor play within seconds.
- **Run every feature on a local mainnet fork**, cross-chain joins and withdrawals
  included, then play with a few real people: locally, then with testnet wallets.
- **Record a walkthrough:** 2–3 minutes, after the playtests so it does not show bugs
  they would have caught. Add a GIF and screenshots; the README has no image yet.
- **A short front section in the README,** above the rules: a one-line pitch, the live
  link, the video, the stack, about six engineering highlights and the main limitations.
  The threat and trust models stay, further down.
- **Say "testnet only" at the top of the README.** Today it first appears at line 264.
- **Fix the README's clone URL.** It points at `SiderProgrammer/gambling-project`; the
  remote is `SiderProgrammer/last-man-standing`.
- **Link the audit work from the README:** `contracts/x-ray/` and
  `.solidity-auditor/runs/`, described as AI-assisted reviews, not an independent audit.
- **Clear out the working notes.** Finish `TO_CHECK.md` and `TODO_IDEAS.md`, then delete
  them or fold what is left into this file.
- **Add a root `LICENSE`.** Only `packages/client/public/fx/` has one.
- **Set the GitHub repo up:** public, with a description, topics and the live link.
- **Freeze features.** The leaderboard, the prediction market, Yul and the Guard damage
  change in `TODO_IDEAS.md` can wait until this list is done.
