# What's left to do

Open work only. What is done is in the code and its history; the decisions the
design rests on are in [adr/](adr/).

**Scope:** a portfolio project, on testnet first and then as an unpromoted mainnet demo
([ADR 0012](adr/0012-launch-scope.md)). Hosting is Render's free tier, whose risks are in
[HOSTING.md](HOSTING.md).

**Deferred on purpose, still planned:**

- the Privy integration (1.1);
- the dispute bond (3.1).

---

## 1. Checks that need a testnet

Nothing is deployed on a public chain yet: `contracts/deployments/` holds only local
nodes. Everything below waits on a hub on Base Sepolia, which needs the deploy roles
(Safe, guardian, team beneficiary, matchmaker, one attestor), a Chainlink VRF v2.5
subscription owned by the Safe and funded in ETH, and testnet ETH.
[TESTNET.md](TESTNET.md) has the steps.

### 1.1 The Privy check — deferred

**Deferred, still planned.** Neither the first testnet deployment nor the mainnet demo
waits on this: visitors use wallet-free practice (section 7) or the normal wallet flow.
Do not remove what it builds on: `SessionKeyDelegate`, the session relayer,
`Wallet.fromAccount`, `npm run check:one-click`, the one-click buttons, and ADR 0009.
Privy's docs describe signing an authorization for a contract you choose
(`useSign7702Authorization`), which is encouraging but not proof, and they do not say
whether a custom delegate needs allowlisting.

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
- **One-click buttons** in the client have not run against a node. Deferred with 1.1:
  the burner is for dev builds, so a production build has no wallet that can use them.

---

## 2. Client gaps

- **Spectator discovery.** `watch` works, but live matches are only listed if they came
  from the chain directory; practice rooms are invisible to everyone but their player.
- **Token joins cost two transactions the first time:** `approve`, then
  `joinWithToken`. Permit2, or EIP-2612 `permit` for USDC, would fold the approval into
  one signature. The slippage allowance is fixed at 0.5%, with no control for it.
- **The queue after a closed tab: check in a normal browser.** In the 11 Nov playtest,
  P2 was still queued 95 s after their only tab closed and was put on a table's roster.
  The gateway drops a wallet from the queue when its last socket closes, and scripted
  sockets were dropped correctly, so the in-app browser may be keeping closed tabs'
  sockets open.
- **The 12 Nov playtest fixes (`4df6056`) are not replayed on the fork.** They are
  covered by unit tests only. Also never played there: one-click play, the LMS fee
  discount and a successful LMS stake (all blocked by the fork's warped clock), a server
  restart mid-match, and the analyst (no key on the server).

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
- **Deferred: a dispute costs only gas.** Any seated player can hold a payout back 48
  hours, so a loser can delay every match they lose, and the guardian has to answer each
  one. The plan is a bond: returned on a veto or if the guardian never answers, forfeited
  on a dismissal. It is accepted as a known limitation for testnet and the mainnet demo,
  and it is required before real stakes. The contracts cannot be upgraded, so adding it
  later means a new escrow (3.3), and `GameEscrow` has only about 830 bytes left under
  the EIP-170 limit.
- **The attestors are not independent.** The attestor signs in a child process of the
  server, which reads `ATTESTOR_PK` from its own environment to hand it over. Moving the
  attestor to another host is the same IPC over a socket, not done. The server also
  submits only one signature, so a threshold above one cannot settle until it collects
  a quorum.
- **On-chain fraud proof, later.** A Solidity kernel, `MatchVerifier`, bonded and
  slashable attestors and cross-language vectors were built and then removed (they are
  in `fadf583`). Bring them back once the rules are frozen and stakes justify
  maintaining two engines.

### 3.2 Governance and the token

- **Governance is idle at launch** until players hold the quorum floor in sLMS: with the
  10,000 LMS per ETH cap binding, 100 ETH of fees paid in settled matches (2,000 ETH of
  stakes at the 5% fee), and rewards vest for six months first. Until then the Safe
  proposes through `MultisigPhase`. Decide whether a bootstrap stake or a lower floor is
  wanted.
- **Play-mining parameters are guesses.** The per-ETH cap and the yearly decay should be
  revisited against real volume before mainnet.
- **No local test of `Deploy` with `SAFE` unset.** The suite shares process-wide env, so
  it always sets one; the case where the Safe is the deployer (the `dev:fork` setup) is
  covered only by an `assert` in `_distribute`.
- **"Protocol fee per match" resends the whole `setParams` struct** (seats, join window,
  stakes, treasury) as read when the proposal form was opened. If another proposal
  changes one of those first, this one quietly sets it back. The form's help says so;
  only per-field setters in `ProtocolConfig` would stop it.

### 3.3 Incidents and migration

The contracts cannot be upgraded, so a fix means a config change or a new deployment.
[MIGRATION.md](MIGRATION.md) is the runbook. What it found missing:

- **A pause can lapse after the multisig phase.** The guardian's pause lasts 7 days and
  cannot be renewed for 7 more, and a governor proposal takes about 9 days (1 day voting
  delay, 5 days voting, 3 days timelock). So play resumes from about day 7 to day 9
  unless the exploit is already fixed. Until `phaseEnd`, the Safe's 3-day route covers it.
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

- **Fuzz campaign, before the first deploy.** The Medusa suite in `contracts/test/fizz`
  last passed 134 of 134, but in a 20-minute run of 2,884 sequences, which
  [its report](../contracts/fizz_data/report.md) calls a weak clean result. Still open:
  the 7 unimplemented properties (GL-17, SP-03, SP-22, SP-31, SP-36, SP-37, SP-38), with
  SP-36 needing a hostile-recipient actor; and an overnight run that keeps any
  `test_results` file, because the `escrow_finalize_clamped` flag from the first campaign
  is unexplained. Its trace has no panic, a Foundry replay passes, and the sequence was
  not kept.
- **CI:** no linter for the TypeScript, and the deep fuzz profile
  (`FOUNDRY_PROFILE=deep`) does not run on a schedule. Aderyn is not wired in.
- **Slither locally:** CI's pinned 0.11.3 does not install on Python 3.12.0, because
  `crytic-compile` excludes that exact version. Use a newer Python, or a throwaway venv
  with `pip install --ignore-requires-python slither-analyzer==0.11.3`.
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
- **A real-money launch:** independent signers for the Safe, an independent audit and
  paid hosting. The mainnet demo in section 8 is not this, and the README says so.

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
- **Idle players.** In a staked match one idle seat makes every round run the full 60 s,
  with no penalty: 4 idle rounds in practice left the idle seat at 100 HP. A missed
  timer means "no action" and a match ends after 30 rounds, so one idle seat can stretch
  a staked match to about 30 minutes. Auto-guard, or drop a seat after N missed rounds?
- **No way out of a lobby that does not fill.** Once staked, a player gets the stake
  back only through `cancelMatch` after the join window (`GameEscrow.sol:824`). Should
  players be able to leave an unfilled lobby?

---

## 7. Before it goes on a CV

A reviewer gives the repo a few minutes and will not run `npm run dev:fork`. Roughly in
order, with the testnet deployment from section 1 before the hosting:

- **Host it on Render's free tier.** The client and server run only on a developer's
  machine today. Serve the client and a server pointed at Base Sepolia from a public URL,
  with Neon for the database and an external ping. [HOSTING.md](HOSTING.md) has the setup
  and the risks. Test its two possible blockers first: redeploys against the instance
  lock, and the lock through Neon's pooled connection string. Then run a small load test
  on the deployed server, because the numbers in LOAD_TESTING.md do not apply there.
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
- **Say what is live at the top of the README:** testnet for playing, mainnet only as an
  unpromoted demo that is not for real use. Today this first appears at line 272.
- **Link the audit work from the README:** `contracts/x-ray/` and
  `.solidity-auditor/runs/`, described as AI-assisted reviews, not an independent audit.
- **Clear out the working notes.** Finish `TO_CHECK.md` and `TODO_IDEAS.md`, then delete
  them or fold what is left into this file.
- **Add a root `LICENSE`.** The repo has none.
- **Set the GitHub repo up:** public, with a description, topics and the live link.
- **Freeze features.** The leaderboard, the prediction market, Yul and the Guard damage
  change in `TODO_IDEAS.md` can wait until this list is done.

---

## 8. Mainnet demo

After testnet works end to end, deploy the same contracts to Base to show it can be done
on a real chain, with no promotion and no money meant to go in. This is not a launch.

- **Limit the stakes.** Once deployed, anyone can call the escrow directly and stake real
  ETH, promoted or not. `Deploy.s.sol` fixes the range at 0.001 to 1 ETH in code. Lower
  `maxStake` for this deployment, because 1 ETH is too much for contracts with no
  independent audit and one person holding every key.
- **Decide whether it stays open.** After the demo matches, the timelock can call
  `extendPause` so no new match can start, while withdrawals and refunds keep working.
  That still shows the deployment without leaving an open game running.
- **Budget real ETH** for the deployer, the VRF subscription, and the keeper and relayer.
  Measure the amounts on testnet first.
- **Hosting.** Only one server can stay awake on the free hours, and mainnet needs its own
  server and database. See [HOSTING.md](HOSTING.md).
- **Call `retire` when the phase ends.** Until someone does, a call the Safe left ready
  can still be executed.
- **State the limits in the README:** one person holds every Safe key and the reviews are
  AI-assisted. Never describe it as production-ready.

The fuzz campaign in section 4 comes before this, as it does for testnet.
