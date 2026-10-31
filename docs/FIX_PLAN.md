# Fix plan: review findings and design answers

This plan covers every finding from the architecture review (C1–C4, H1–H13, N1–N9, M1–M27,
L1–L4, and the test gaps). It also builds in the design answers given on 2026-10-28 and
2026-10-29. A
coverage table at the end maps each finding to its step.

Phase 1 is implemented on the `design-rework-phase-1-foundations` branch, Phase 2 on
`design-rework-phase-2-core-contracts`, Phase 3 on
`design-rework-phase-3-governance-and-token`, Phase 4 on `design-rework-phase-4-verifiability`,
Phase 5 on `design-rework-phase-5-sessions`, and Phase 6 on
`design-rework-phase-6-cross-chain`, each building on the last. Nothing after that is,
except the Privy check in 5.1 and the live Across testnet deposit in 6.1.

---

## 0. Decisions this plan is built on

| # | Decision |
|---|---|
| Q0 | Portfolio piece, but built to the bar of a real product that holds money. |
| Q1–Q3 | **Verifiable, not enforced:**<ul><li>players sign commits and reveals;</li><li>the browser checks everything it can from chain data;</li><li>any seated player can dispute a result during the challenge window, and the guardian decides;</li><li>`hold` stays.</li></ul> |
| Q4–Q7 | **Play-mining stays, to distribute the token:**<ul><li>no market price inside the protocol;</li><li>rewards vest linearly over 6 months and give no votes while vesting;</li><li>votes need vested LMS staked in `StakedLms`;</li><li>a per-ETH cap plus a per-wallet cap per epoch;</li><li>liquid LMS can buy up to 50% off the match fee at a governance-set rate, and that LMS is burned;</li><li>the emission schedule can change.</li></ul> |
| Q8–Q12 | **Multisig phase:**<ul><li>a 2-of-3 Safe, with all three keys held by the owner on separate devices;</li><li>guardian, treasury and Safe are separate addresses;</li><li>the Safe's veto and powers end on a fixed date written into the contract;</li><li>a guardian pause expires after 7 days unless governance extends it;</li><li>vesting rewards can't vote;</li><li>every role is documented in the README.</li></ul> |
| Q13 | Hub on **Base**, minimum stake 0.001 ETH. |
| Q14 | **Mixed-chain matches over a real value bridge.** No LayerZero executor value. |
| Q17 | The Safe owns the VRF subscription. |
| Q20 | **Sessions:**<ul><li>login is an off-chain EIP-712 session grant, checked by the server;</li><li>`SessionKeyDelegate` stays, without the session-key branch in `isValidSignature`;</li><li>`executeWithSession` becomes the real one-click `join`/`withdrawFor` feature, with caps and relayer-paid gas;</li><li>burner and embedded wallets get one-click play, and injected wallets keep the normal flow.</li></ul> |
| Wallets | **Privy as the embedded wallet** (decided 2026-10-29):<ul><li>one EVM wallet, the same address on Base, Arbitrum, Optimism and L1;</li><li>injected wallets and Coinbase Smart Wallet can also connect, using the normal flow;</li><li>one-click play on Base only; spoke joins stay normal transactions through `SpokeRouter`;</li><li>Turnkey is the fallback if Privy can't sign a 7702 authorisation for our delegate.</li></ul> |
| Q22–Q24 | Wire protocol, storage layout and database schema can all break. The "behaviour-preserving" rule is dropped. One server instance. |

### Defaults where no answer was given (accepted on 2026-10-29)

| Topic | Default |
|---|---|
| Q15 spoke chains | **Arbitrum, Optimism and Ethereum L1** (Arbitrum Sepolia, OP Sepolia and Sepolia on testnet). All three use ETH for gas, so there is no price risk on stakes. L1 is where most ETH is held, and a join from L1 is one transaction, so the high L1 gas is paid once per join. |
| Q16 stake asset | **Native ETH only.** |
| VRF payment | **Native ETH** (VRF v2.5 `nativePayment: true`), so nobody has to keep LINK topped up. |
| Q21 migration | Nothing is deployed with real users, so there's no migration path. Fresh deploys only. |
| Treasury | The **timelock**, so spending fees always goes through governance. During the multisig phase that means the Safe proposing through the timelock. |
| Guardian | A **separate hardware-wallet EOA**, not the Safe. |
| Dispute when the guardian is silent | The dispute extends finalisation by 48 h. If the guardian neither vetoes nor dismisses by then, the result finalises. This is the liveness assumption, and the README states it. |
| Guardian re-pause | After a pause ends, the guardian can't pause again for 7 days. Only governance can. This stops a pause being renewed forever. |
| M22 (`Match` / `replay` duplication) | Keep two implementations, but pin both with frozen golden transcripts. TODO §3.4 argues for keeping them on purpose; the transcripts make that cheaper to live with. |

---

## 1. Problems in the answers to resolve first

1. **The per-wallet cap doesn't stop sybils.** A farmer just uses more wallets. The real bound
   is the per-ETH cap, together with:
   - mining only in public, matchmade games (H7 below);
   - vesting.

   The README should say so plainly. **Decided:** lower `maxRewardPerEth` from 100k to
   10k LMS/ETH. That raises farming break-even from 1e‑5 to 1e‑4 ETH per LMS. Honest players
   earn 10× less per match, and governance can raise the cap later.

2. **"Real product" vs. "one person holds all 3 Safe keys".** That's fine on testnet. The
   README must say that mainnet needs independent signers. Real-money gambling also needs a
   licence, which is out of scope; the README should mention that in one line.

3. **The Safe's 5M liquidity LMS after the phase ends.** If the Safe stakes it, it can still
   clear the 1M quorum alone. **Decided:** keep it in a `LiquidityReserve` contract that:
   - can't stake or delegate;
   - can only send LMS to an address the timelock approves (the future pool).

4. **Bridge: Across (decided).** Across lists SpokePools on Base Sepolia, Arbitrum Sepolia, OP
   Sepolia and Sepolia. Stargate v2 has no Base Sepolia deployment, so it can't reach the hub.
   Across's own docs describe testnet as unreliable:
   - fills take about a minute;
   - relayers have no incentives;
   - unfilled deposits are **not** refunded.

   So the main testnet flow uses a mock bridge, and the real integration is proven with fork
   tests against the mainnet SpokePools. A real Across testnet join is an optional demo with
   small amounts.

5. **Relayer-paid gas is a subsidy someone can drain**, just like M11. Session calls need a
   per-wallet daily quota and a minimum amount on `withdrawFor`.

6. **Embedded wallets and 7702.** One-click play assumes Privy can sign a 7702
   authorisation for *our* delegate, not only for its own account. Check this in step 5.1
   before relying on it. If Privy can't, try Turnkey; if neither works, embedded wallets fall
   back to the normal flow, like injected ones. The contracts don't change either way.

   One-click play on spokes (a `chainId = 0` authorisation, the delegate at the same address
   on every chain, and a relayer per spoke) is out of scope for now.

---

## Phase 1: Foundations and cleanup (do first; everything else builds on it)

Mechanical work, so later diffs stay readable.

**Done**, one commit per step (1.4 in two). Where it differs from the table:
- 1.2 has no TypeScript linter yet; typecheck is the gate. CI also checks the gas
  snapshot (deterministic now that 1.4 fixed the fuzz seed) and the generated ABIs.
- 1.3: the convention is `test_camelCase`, which most tests already used.
- 1.7: production without `DATABASE_URL` is refused unless `ARCHIVE=memory`, the switch 7.1
  asks for.
- 1.8 also made `hello.spokes` required, and removed `MatchSummary.reviewable`.
- 1.10 writes `contracts/deployments/<chainId>.json`; the client gets addresses through
  the server's `hello`, so the server is the only reader.

| Step | Work | Findings |
|---|---|---|
| 1.1 | Add `forge-std` as a submodule and stop ignoring `contracts/lib/` for submodules. A fresh clone must pass `forge test`. | M27 |
| 1.2 | **GitHub Actions CI:**<ul><li>`npm ci`, typecheck, lint, vitest;</li><li>`forge build`, `forge test`, `forge fmt --check`;</li><li>coverage report;</li><li>Slither with a triaged baseline file, so only new findings fail the build;</li><li>Aderyn (optional).</li></ul> | M27 |
| 1.3 | Run `forge fmt` once. Replace the deprecated `deny_warnings`. Rename tests to one convention (`test_camelCase`, which most tests already use). | M24, M27 |
| 1.4 | **Remove the TODO §3.4 known bugs:**<ul><li>one `Errors.sol` with one signature each for `UntrustedMessenger`, `UnknownRequest`, `UntrustedPeer` and `UnknownMatch`;</li><li>one `BPS_DENOMINATOR` constant;</li><li>pin the selector in the five bare `vm.expectRevert()` calls;</li><li>`EscrowInvariant` uses the shared `Fixtures`;</li><li>seed the invariant campaign;</li><li>fix `tellFor`, `hpLeaders` O(n²), the `data-action` check, `net.ts off()` and connect re-entrancy;</li><li>put the port number in one config.</li></ul>Then delete §3.4 from the TODO. | M24, L4 (part) |
| 1.5 | **Reorder `MatchStatus`:** Open, Pending, Live, Proposed, Settled, Cancelled. | M15 |
| 1.6 | **Generate ABIs from `contracts/out`** (wagmi CLI or an abitype build step). Delete the hand-written `parseAbi` mirrors. | M14 |
| 1.7 | **One zod schema for the whole server config**, checked at boot. The server refuses to start on `NaN` values, bad addresses or a missing `DATABASE_URL` in production. Reuse zod for frame parsing. | M9, M24 |
| 1.8 | **Delete the backward-compat shims:**<ul><li>optional `MoveAim`;</li><li>`analyst?`;</li><li>`normaliseOriginChainId`;</li><li>nullable archive columns.</li></ul> | M26 |
| 1.9 | **Error codes end to end:**<ul><li>forward `MatchError.code` over the wire;</li><li>the client switches on the code;</li><li>tests assert on codes, not message text.</li></ul> | L4 |
| 1.10 | **Deployment registry:**<ul><li>`deployments/<chainId>.json` with every address and its deploy block, written by the deploy script;</li><li>the server, client and indexer read it;</li><li>verify contracts on Basescan;</li><li>an env switch between mocks and real VRF and bridge.</li></ul> | M17, M27, TODO §3.4 deploy items |

---

## Phase 2: Core contracts on Base

**Done**, one commit per step (2.6 and 2.9 in one, since the cancel rules use the new
`deadline` field). Where it differs from the table:
- 2.1 also deploys the VRF adapter for a `VRF_SUBSCRIPTION_ID` and hands it to the
  timelock. The default timelock delay goes to 3 days and the unstake cooldown to
  10 days, to satisfy 2.4's check. The server defaults to chain 84532.
- 2.2: the feed address lives in `ProtocolConfig`; zero turns the check off, because
  Base Sepolia has no feed. The grace period is 1 h.
- 2.3: the adapter's request id is the VRF id. A failed delivery keeps the word, and
  anyone can retry it with `deliver`.
- 2.4: `setAttestorSet(list, threshold)` replaces `setAttestor` / `setAttestorThreshold`.
  The delay check covers the whole match: join window, `LOCK_GRACE`,
  `RANDOMNESS_TIMEOUT`, settle window, challenge window and `DISPUTE_EXTENSION`. It
  asks the owner for `getMinDelay()`; an owner that does not answer (an EOA, including
  one with a 7702 delegation) is not checked. The join and settle windows are capped
  at 30 days.
- 2.6: `LOCK_GRACE` is 10 min and the randomness timeout is 1 h, both constants.
- 2.7: the oracle answers `fulfillRandomness(matchId, randomness)`, so the escrow
  keeps no request map at all.
- 2.9: `MatchInfo` is 5 slots, with one `deadline` field for the current phase.
  `createMatch` on stored terms went from 183k to 36k gas; lock, fulfil and settle
  each cost 2–5k more. About 137k less per match.
- 2.10: the Yul cost about 1k gas less per settlement (0.1%).
- 2.11: the minimum (0.0001 ETH) is on `withdrawFor` only; `withdraw` has none, so
  dust is never stuck.
- 2.12: on spokes the avatars belong to `SPOKE_OWNER`, the spoke's timelock.

| Step | Work | Findings |
|---|---|---|
| 2.1 | **Retarget the deploy to Base and Base Sepolia:**<ul><li>min stake 0.001 ETH;</li><li>windows suited to 2 s blocks;</li><li>drop the "fee doesn't cover L1 gas" comment.</li></ul> | H3 |
| 2.2 | **L2 sequencer uptime check:** `finalize` reverts if the Base sequencer came back up less than a grace period ago. Read this from the Chainlink sequencer uptime feed. Otherwise an outage could quietly shorten the challenge or dispute window. | new (from H3) |
| 2.3 | **Real VRF v2.5:**<ul><li>vendor `IVRFCoordinatorV2Plus` and `VRFV2PlusClient`;</li><li>build the request struct with `extraArgs({nativePayment: true})`;</li><li>the fulfil callback must never revert (store the result, then process);</li><li>the Safe owns the subscription and the adapter is a consumer;</li><li>add a Base Sepolia fork test.</li></ul> | H5 |
| 2.4 | **Snapshot trust parameters per match:**<ul><li>`ProtocolConfig` keeps versioned attestor sets (`attestorSetVersion`, plus `isAttestor` and `threshold` by version);</li><li>the match stores the version and the oracle address at `lockMatch`;</li><li>`settle`, `abortMatch` and `fulfillRandomness` use the snapshot. That also fixes "callback after an oracle change reverts".</li></ul>`_setParams` enforces `timelock.getMinDelay() > joinWindow + settleWindow + disputeExtension` on-chain. | H2, L2 |
| 2.5 | **Threshold sanity:** `isComplete()` requires `attestorThreshold > 0`. The setter requires `1 ≤ threshold ≤ attestorCount`, and `_checkQuorum` reverts on 0. | N5 |
| 2.6 | **Cancel race:**<ul><li>an Open lobby past `joinDeadline` can be cancelled only if `seatCount < minSeats`, or once `joinDeadline + LOCK_GRACE` has passed;</li><li>a Pending lobby can be cancelled after the VRF timeout.</li></ul> | N4 |
| 2.7 | **CEI in `lockMatch`:** write `randomnessRequest` before the oracle call. Each oracle request carries the matchId, so this needs no extra storage. | L2 |
| 2.8 | **Expiring pause** (`ExpiringPause` abstract, OZ-style events):<ul><li>`pausedUntil`;</li><li>a guardian pause lasts 7 days;</li><li>the guardian has a 7-day cooldown before pausing again;</li><li>governance `extendPause(until)` and `unpause()`;</li><li>the guardian can also unpause early.</li></ul>`finalize`, `veto`, cancel and withdrawals stay unpausable. Replaces the hand-rolled pause. | H1, Q11, M24 |
| 2.9 | **Storage:**<ul><li>terms (fee, payout schedule, windows) go into an immutable `termsId` record shared by every lobby with the same terms;</li><li>`MatchInfo` packs into fewer slots.</li></ul>Gas snapshots before and after. | M16 |
| 2.10 | **Drop hand-written Yul:**<ul><li>use OZ `ECDSA` and `MessageHashUtils`, and a plain loop for the seat set;</li><li>delete unused `HashLib` Yul (`chainHistory`, `draw`);</li><li>record the gas difference.</li></ul>Attestors stay EOA-only, and the README says so. | M12, H6 |
| 2.11 | **Payouts are pull-only:**<ul><li>no server push;</li><li>gasless withdrawal moves to `withdrawFor` via a session (step 5.3) or an EIP-712 signed withdrawal (step 6.4);</li><li>a minimum withdrawal amount.</li></ul> | M11 |
| 2.12 | **`PlayerAvatars`:** `Ownable2Step` owned by the timelock. The README states the "one free mint per wallet" limit, or minting requires one finished match. | L2 |

---

## Phase 3: Governance and token (H1, C4)

**Done**, one commit per step (3.5 and 3.6 in one, since the caps live in the same claim),
plus three for CI. Where it differs from the table:
- 3.1: `phaseEnd` is at most two years out, and a year by default (`MULTISIG_PHASE_END`).
  `MultisigPhase` also refuses to schedule a call on the timelock itself or a
  `transferOwnership`/`renounceOwnership` anywhere, the two ways a call scheduled during the
  phase could keep the Safe in charge after it.
- 3.2: `TREASURY` is gone; `GUARDIAN` is required off a local node (anvil's tenth account
  there). The guardian is in the deployment registry.
- 3.3: the timelock or the Safe releases to an approved recipient. The vault, the Safe and
  the reserve itself can never be approved.
- 3.4: `deposit(amount)`, `depositFor(account, amount)`, `depositWithPermit(amount, …)`,
  `requestUnstake(amount)`, `claim(receiver)`, and `underlying()` for the token. No
  `totalStaked`: the backing is `totalSupply`.
- 3.5: tranches vest over 26 weeks. `RewardsDistributor` creates the `RewardVesting` and is
  its only granter, so there is no setter. `release(player, epochs[])` is open to anyone and
  pays only the player.
- 3.6: the wallet cap defaults to 20,000 LMS a week (`MAX_REWARD_PER_WALLET`) and, like the
  rate, is fixed per epoch by its first claim. Counting only public, matchmade lobbies needs
  7.9's join tickets: without them every lobby is join-by-id, so that rule lands with 7.9.
- 3.7: `joinWithLms(matchId, lmsIn)` and `joinWithLmsPermit`, not an overloaded `join`. The
  seat stakes the stake less the discount (`quoteLmsDiscount`); the prize pool is computed
  from the full stakes, so the discount comes out of the treasury's cut. Default rate
  20,000 LMS per ETH, off on Base mainnet. LMS refunds are pushed: the token has no hooks.
  GameEscrow was already 136 bytes over EIP-170, which failed master's CI; it now compiles
  alone at 200 optimizer runs (23.7 KB, under 1% more gas). Coverage runs under a profile
  without that restriction.
- 3.8: the escrow invariant also joins with LMS and checks the LMS held and burned. Master's
  Slither job was failing on untriaged findings; the baseline is regenerated with a note for
  every one.

| Step | Work | Findings |
|---|---|---|
| 3.1 | **`MultisigPhase` contract**, holding the Safe's timelock powers until `PHASE_END`, a fixed constructor timestamp:<ul><li>it holds PROPOSER and CANCELLER on the timelock, and forwards `schedule`/`cancel` only from the Safe and only before `PHASE_END`;</li><li>after `PHASE_END`, anyone calls `retire()`, which renounces both roles.</li></ul>The Safe never holds timelock roles directly. The veto therefore ends on a date in code, and the Safe can't cancel its own removal. | H1, N7, Q9, Q10 |
| 3.2 | **Separate roles in `Deploy.s.sol`:**<ul><li>Safe (2-of-3): proposes and cancels through `MultisigPhase`, owns the VRF subscription;</li><li>guardian: an EOA that can pause, veto and dismiss disputes;</li><li>treasury: the timelock;</li><li>owner of the avatar and fee router: the timelock.</li></ul>The deploy script asserts that no address holds two roles. | H1, Q8 |
| 3.3 | **`LiquidityReserve` for the Safe's 5M LMS:** can't stake or delegate, and pays out only to addresses the timelock approves (problem 3). | H1 |
| 3.4 | **Reshape `StakedLms`:** drop ERC‑4626 and use an `ERC20Wrapper`-style 1:1 stake + `ERC20Votes` + cooldown + streamed ETH rewards. Plain `deposit` / `requestUnstake` / `claim`, with no misleading 4626 surface. | M13 |
| 3.5 | **`RewardVesting`:**<ul><li>`RewardsDistributor.claim` no longer deposits sLMS; it adds the epoch's reward as a tranche;</li><li>each tranche vests linearly over 6 months from that epoch's `claimableFrom`;</li><li>`release(epochs[])` pays out liquid LMS, and the player stakes it to vote;</li><li>tranches are per epoch, so gas stays bounded (at most about 208 epochs).</li></ul> | C4, Q12 |
| 3.6 | **Caps:**<ul><li>keep `maxRewardPerEth`, lowered from 100k to 10k LMS/ETH (problem 1);</li><li>add `maxRewardPerWalletPerEpoch`, set by governance;</li><li>mining counts only **net fees from public, matchmade lobbies** (step 7.9). Private join-by-id lobbies earn nothing.</li></ul> | C4, H7 |
| 3.7 | **LMS fee discount:**<ul><li>`LmsToken` becomes `ERC20Burnable`;</li><li>`ProtocolConfig.lmsPerEthDiscount` is set by governance, with `MAX_DISCOUNT_BPS = 5000`;</li><li>`join(matchId, lmsIn)` pulls LMS (permit supported) and **holds it in escrow**;</li><li>at `finalize` it is burned, and on cancel, veto or abort it is refunded with the stake;</li><li>the seat's fee drops by the discount;</li><li>mining uses the net fee.</li></ul> | Q5 |
| 3.8 | **Invariant suites for `StakedLms` and `RewardsDistributor`/`RewardVesting`:**<ul><li>votes ≤ staked supply;</li><li>ETH rewards stay solvent;</li><li>Σ vested ≤ Σ granted ≤ budget;</li><li>nothing votes before it vests.</li></ul> | Tests |

---

## Phase 4: Verifiability (C3, H6)

**Done**, one commit per step. Where it differs from the table:
- 4.1 needed 5.1's grant, so the grant landed here: the `SessionGrant` type as 5.1
  describes it, signed by the wallet, and a login whose nonce the granted key signs.
  The grant's EIP-712 domain has no chain id (wallets refuse typed data for a chain
  they are not on, and a spoke player must still log in); `chainId` is a field the
  server checks, with expiry, a one-week cap, the origin against `ALLOWED_ORIGINS` when
  set, and the wallet's signature (ERC-1271 over RPC as the fallback). A login without a
  grant can watch but not play. Move signatures are checked on the verify pool, which
  now recovers typed data. The browser keeps the grant for a day, which is also what
  makes reconnects prompt-free, so the 7702 "prompt-free login" panel now shows the
  grant instead; the delegate stays for 5.3. Left of 5.1: `ALLOWED_ORIGINS` required in
  production, and the Privy check.
- 4.2: receipts are signed by the attestor key, or by a per-process key on a server
  without one; `hello` names the signer. The browser checks each receipt against its
  own sealed move and keeps it with the salt, plus whether it revealed. The commitment
  set is broadcast once the window closes and only then (4.4's rolls come from it).
- 4.3: the hashed `RoundRecord` gains each seat's commitment. The commit and reveal
  signatures and each commit's receive time sit beside it, in the transcript round's
  `proofs`, not in the hashed record: each signs data the hash already covers. A
  receipt's hash is derivable from the commitment and receive time, so it is not stored
  separately.
- 4.4: the commitment set is seat-ordered, `NO_COMMITMENT` for a seat that sealed none.
- 4.5: the transcript hash is keccak256 of the transcript's canonical JSON (keys
  sorted), and part of the EIP-712 `MatchResult`, so the quorum signs it. The archive
  write retries with the settlement backoff; if it still fails the match is aborted
  rather than left to its deadline. No IPFS pin. The two new Postgres columns need a
  fresh database (no migration tool until 7.2).
- 4.6: one extension per open dispute; later disputes are recorded, not extended.
  `dismissDispute` puts the deadline back, or to now if that has passed, and another
  seat may then dispute. To fit under EIP-170, `MatchCancelled` carries a `CancelReason`
  enum instead of a string (GameEscrow: 24,327 bytes, 249 under the limit). The escrow
  invariant handler disputes and dismisses too.
- 4.7: the seed is read with the rest of the match from `getMatch`, which stores what
  `MatchStarted` announced. Transcripts are served at `GET /transcripts/<hash>`, staked
  matches only. The audit is `auditTranscript` in the engine, so a guardian's tooling
  can use the same code. The evidence bundle is saved to a file for the player to send
  to the guardian; nothing uploads it yet.
- 4.8: two transcripts (four and eight seats, with a silent seat and a missed commit),
  written by `npm run golden`. The Solidity test cannot run the engine; it rebuilds
  every round hash and the root from seat-indexed arrays in the same file.
- 4.9: the README gets a Trust model section, and the roles table the operator and the
  seated player.

| Step | Work | Findings |
|---|---|---|
| 4.1 | **Signed moves:**<ul><li>commits are signed by the player's session key as EIP-712 `Commit{matchId, round, seat, commitment}`;</li><li>reveals are signed as `Reveal{matchId, round, seat, move, salt}`;</li><li>the session grant (step 5.1) links the key to the wallet, and the server checks both.</li></ul> | C3 |
| 4.2 | **Commit receipts:**<ul><li>the server answers each commit with a signed receipt `{matchId, round, seat, commitment, receivedAt}`;</li><li>at commit close it broadcasts the full commitment set, not just seat numbers.</li></ul>A dropped reveal for a receipted commit is then provable. | C3 |
| 4.3 | **`RoundRecord`** now holds every signed commitment, every reveal and the receipt hashes. `hashRound` covers the commitments. Update the frozen vectors in both TS and Solidity. | C3 |
| 4.4 | **No entropy grinding:**<ul><li>round entropy is `roundSeed(seed, round, hash(sorted commitment set))`, fixed when the commit phase closes;</li><li>censoring a reveal can no longer change the dice;</li><li>`hold` seats are the one case where the server knows a move at commit time. The README says so.</li></ul> | C3, Q3 |
| 4.5 | **Archive first:**<ul><li>the full transcript goes to Postgres, and optionally an IPFS pin, *before* `settle`;</li><li>`settle` carries `transcriptHash`, stored and emitted;</li><li>a failed archive write means no settle.</li></ul> | C3, H12 |
| 4.6 | **On-chain dispute:**<ul><li>`dispute(matchId, evidenceHash)` can be called by any seated player, once each, inside the challenge window;</li><li>it pushes `finalize` back by `DISPUTE_EXTENSION` (48 h);</li><li>the guardian calls `veto` or `dismissDispute`;</li><li>if the guardian stays silent, the match finalises after the extension.</li></ul> | Q2 |
| 4.7 | **Browser verification from chain:**<ul><li>seed from the `MatchStarted` event, `rulesHash` from the match, seats from `getSeats`;</li><li>replay the transcript fetched by `transcriptHash`;</li><li>check every signature;</li><li>check *own* moves against `localStorage`;</li><li>`forgetMatch` only after verification;</li><li>on mismatch, a one-click "Dispute" builds the evidence bundle and sends `dispute`.</li></ul> | C3 |
| 4.8 | **Golden transcripts:** frozen full-match transcripts replayed by `Match`, by `replay` and by a Solidity test. One cross-language EIP‑712 `MatchResult` digest vector. | M22, Tests |
| 4.9 | **Honest docs:**<ul><li>trust model: single operator + guardian, verifiable but not enforced;</li><li>`abortMatch` lets the operator refund any live match;</li><li>attestors are not yet independent.</li></ul> | H6, M25 |

---

## Phase 5: Sessions (C1, C2, M7)

**Done**, one commit per step, except that 5.2 and the contract half of 5.3 rewrote the
same delegate in one commit. Three more: the Slither baseline, the end-to-end check, and
these notes. Where it differs from the table:
- 5.1: Phase 4 had landed the grant (see 4.1). Left was `ALLOWED_ORIGINS`: production
  now refuses to start without it, and `ALLOWED_ORIGINS=*` accepts any origin on purpose
  (the load-test profile uses that). **The Privy check is not done**: it needs a Privy
  app on Base Sepolia. `npm run check:one-click` runs the same checklist (an
  authorization for our delegate, a relayed `join`, the caps, a revoked session, plus
  ERC-1271 refusing the session key) on a Prague anvil, with a viem local account in
  place of the embedded wallet, which is what Privy's wallet becomes through
  `toAccount`. `Wallet.fromAccount` is where it would plug in. Privy is not in the
  client and not configured for any chain.
- 5.2: as the table. No ERC-7739.
- 5.3: the scope is fixed in code, not granted. The delegate takes the escrow as an
  immutable and allows `join(matchId)` and `withdrawFor(account)` on it, with exactly one
  word of arguments; the `(target, selector)` allowlist is gone. That moved the storage
  to a new ERC-7201 namespace (`lms.session.v2`), the EIP-712 domain to version 2, and
  the frozen digest vector. Caps are per call and in total, set at grant; the client
  asks for 0.05 and 0.25 ETH. A session lasts at most seven days, and the client grants
  the session key the login grant already names, until that grant expires.
  `executeWithSession` is no longer payable, so the stake always comes from the account.
  `SessionRelay` pays from its own `SESSION_RELAYER_PK` and allows
  `RELAY_QUOTA_PER_DAY` calls (default 20) per wallet per UTC day, joins and
  withdrawals together. It also refuses an account delegated to any other code, which
  would otherwise run on its gas, and names the revert when it refuses. The minimum on
  `withdrawFor` is the escrow's own, from 2.11. A refused relay falls back to the
  wallet. The relayer is a plain viem client with viem's nonce manager until 7.3's
  `TxSender`.
- 5.4: no P-256. The secp256k1 key is sealed in IndexedDB under an AES-GCM key
  generated non-extractable; a key Phase 4 left in localStorage is deleted, not
  migrated. The CSP is a `<meta>` built from the build's environment, so the host has
  to send `frame-ancestors` itself. `connect-src` admits `data:` and `blob:`, which
  Pixi fetches, and Pixi's `unsafe-eval` shim keeps `'unsafe-eval'` out. A test keeps
  `innerHTML` out of the client. Checked in a browser on a dev-mode build: a practice
  match, signed moves, and a reload that logs in from the sealed key, with no
  violation.
- 5.5: the README's Wallets section; the Privy row says it waits on the check. No
  ERC-4337.

| Step | Work | Findings |
|---|---|---|
| 5.1 | **Login:**<ul><li>an EIP-712 `SessionGrant{wallet, sessionKey, domain, uri, chainId, issuedAt, expiresAt, nonce}`, shaped like SIWE so wallets bind it to the origin;</li><li>the server checks it with ecrecover, or ERC‑1271 *from the root wallet* for contract wallets;</li><li>the server then accepts nonces signed by the session key;</li><li>`ALLOWED_ORIGINS` must be set in production.</li></ul>**Privy check on Base Sepolia** (problem 6):<ul><li>Privy signs a 7702 authorisation for `SessionKeyDelegate`;</li><li>the relayer submits `join`;</li><li>the caps are enforced;</li><li>a revoked session fails.</li></ul>Privy is configured for Base, Arbitrum, Optimism and Ethereum. | C1, C2, M7 |
| 5.2 | **`SessionKeyDelegate.isValidSignature`** accepts only root-key signatures. The session-key branch is deleted. ERC‑7739 nested typed data is a stretch goal. | C1 |
| 5.3 | **`executeWithSession`, the real feature:**<ul><li>`join` and `withdrawFor` on the escrow only;</li><li>a per-call value cap, a total spend cap, argument checks (escrow address, selector, `player == account`), expiry and nonce;</li><li>a relayer submits and pays gas, with a per-wallet daily quota (problem 5).</li></ul>Sign the authorisation with `toAccount`-style local accounts (burner or embedded). | C2, Q20 |
| 5.4 | **Key storage and CSP:**<ul><li>a strict Content-Security-Policy;</li><li>no `innerHTML` with dynamic data;</li><li>the session key in IndexedDB as a non-extractable WebCrypto key where possible (stretch goal: P‑256 via RIP‑7212). Otherwise a short-lived secp256k1 key with a capped spend, as limited by step 5.3.</li></ul> | C1, M19 |
| 5.5 | **README wallet matrix:**<ul><li>burner and Privy wallets get one-click play on Base (Privy only if the step 5.1 check passes);</li><li>injected wallets and Coinbase Smart Wallet use the normal flow;</li><li>joins from spokes are normal transactions for every wallet.</li></ul>Stretch goal: ERC‑4337 `validateUserOp`. | C2 |

---

## Phase 6: Cross-chain over a value bridge (H4, N2, N6)

**Done**, one commit per step, plus one for the TypeScript side and the local stack, and
one for these docs. Where it differs from the table:
- 6.1: the interfaces are vendored from `across-protocol/contracts` v5.0.27, not added as a
  dependency; the addresses are in `contracts/config/across.json`, which both deploy
  scripts read and copy into the registry. Confirmed from the pinned source: a contract
  recipient gets WETH (an EOA or a 7702-delegated account gets ETH), then the handler; a
  handler revert reverts the fill, which waits for its deadline and refunds the depositor
  on the origin chain in WETH. Fees read from the API: about 0.24% on a 0.001 ETH join,
  testnet and mainnet alike. **The live testnet deposit is not done**: it needs a funded
  key. `docs/ACROSS.md` has the findings and the steps.
- 6.2: the escrow keeps its never-revert cross-chain entry as `bridgeJoin`, callable only by
  `ProtocolConfig.bridgeReceiver`, which replaces the per-chain messenger and peer
  registry. More than the stake seats the player and credits the rest; less is credited
  as `StakeTooLow` (was `WrongStake`). The origin chain is what the message claims, shown
  and not trusted. `DeploySpoke` keeps the spoke's avatar collection.
- 6.3: the router has no owner and immutable wiring. The message is
  `(matchId, player, origin chain)`; the queue ticket joins it with 7.9. The deposit's
  output is exactly the stake: Across V3 delivers the output a deposit names or nothing,
  so the "buffer" is on the fee side, a tenth of the quoted fee for the relayer, added by
  the client. The caller is the depositor, so an unfilled deposit is refunded to them on
  the spoke.
- 6.4: failed and extra joins are credited in the escrow, not the receiver, so a player has
  one balance; `withdrawToChainFor` takes all of it through a new
  `GameEscrow.withdrawToBridge`, callable only by the receiver. The withdrawal's EIP-712
  domain has no chain id, so a wallet on a spoke can sign it; `hubChainId` is a field.
  ERC-1271 for contract wallets. What the receiver cannot route stays there, for the
  timelock to `recover`. The receiver checks "amount ≥ stake" through the escrow. The
  server relay and the screen for withdrawing to a spoke come with 8.5; the typed data is
  in `@lms/protocol`, pinned by a digest vector shared with Solidity. GameEscrow: 24,400
  bytes, 176 under the limit.
- 6.5: the fork tests also cover Ethereum, and land a real `fillRelay` into the receiver on
  Base. They pass on public RPCs. The escrow invariant's cross-chain joins are now fills
  through the receiver, with a new invariant that the receiver holds only what it could
  not route.
- The client prices a join through `VITE_ACROSS_API`, which the CSP admits; unset, the
  quote has no fee, for the local stack. The governance template "Add a spoke chain" is
  now "Change the bridge receiver": a new spoke needs no proposal. `dev:fork` puts a mock
  pool on each chain and plays the relayer, and now reads addresses from the deployment
  registry: since Phase 3's second compiler profile the broadcast log leaves most contract
  names blank, which had broken it. A join from the local spoke was checked in the
  browser: filled, seated with its origin, and reported.

| Step | Work | Findings |
|---|---|---|
| 6.1 | **Across setup (short spike):**<ul><li>copy the full SpokePool addresses (testnet and mainnet) into the deployment registry from the Across docs or the `across-protocol/contracts` repo;</li><li>pin the Across contracts dependency;</li><li>make one small testnet deposit with a message, to confirm whether a contract recipient gets WETH or native ETH (I believe WETH, which the receiver would unwrap), and to measure fill time and fees through the `testnet.across.to/api` quote;</li><li>write down what happens to a fill whose handler reverts.</li></ul> | H4 |
| 6.2 | **Delete:**<ul><li>`SpokeEscrow`;</li><li>`LayerZeroMessenger`, `MockMessenger` and `IMessenger`;</li><li>`receiveMessage` and the messenger-based `withdrawToChain`.</li></ul>No custom OApp remains, so N2 goes away. If a message-only OApp is ever added back, it must call `endpoint.setDelegate(timelock)`. | H4, N2, L2, TODO §3.4 |
| 6.3 | **`SpokeRouter`** (no custody):<ul><li>quotes the fee (from the Across API, passed in by the client) and calls the Across SpokePool deposit with `stake + buffer`, an expiry and a message with `{matchId or queue ticket, hubRecipient}`;</li><li>`hubRecipient` is required when the caller has code, unless that code is a 7702 delegation designator (`0xef0100…`), because those are EOAs with the same address on every chain.</li></ul> | N6 |
| 6.4 | **`BridgeJoinReceiver`** on the hub, implementing `handleV3AcrossMessage`:<ul><li>accepts calls only from the Base SpokePool, and trusts the token and amount it passes;</li><li>unwraps WETH if needed;</li><li>never reverts, and decodes inside try;</li><li>checks the amount it received ≥ stake;</li><li>tries to join, and credits any extra or a failed join to the recipient's pull balance on the hub;</li><li>`withdrawToChainFor(player, sig)`: an EIP-712 signed withdrawal that a relayer submits, with the bridge fee taken from the balance. Players with no Base gas can still get winnings and refunds back to their spoke.</li></ul> | H4 |
| 6.5 | **Tests:** fork tests against the mainnet Across SpokePools (Base, Arbitrum, Optimism), a `MockAcrossSpokePool` for local and testnet runs, plus unit tests for every failure branch (amount too small, lobby full, deadline passed, bad payload). | Tests |

---

## Phase 7: Server

| Step | Work | Findings |
|---|---|---|
| 7.1 | **Crash safety:**<ul><li>`finalise` is awaited inside a try/catch with a retry queue;</li><li>a process-level `unhandledRejection` handler logs instead of crashing;</li><li>`createArchive` never falls back silently (memory only with an explicit `ARCHIVE=memory`).</li></ul> | N3, H12 |
| 7.2 | **Archive:** lower-case matchIds on save and load. Use a migration tool such as node-pg-migrate, one pool, and a repository layer. | N9, M10 |
| 7.3 | **One `TxSender` per key:**<ul><li>viem `nonceManager`;</li><li>an in-flight set keyed by (action, matchId);</li><li>wait for receipts;</li><li>replace a stuck transaction with a higher fee.</li></ul> | H11 |
| 7.4 | **Separate keys:** attestor, keeper/`TxSender`, session relayer and matchmaker ticket signer. Signing goes through a `Signer` interface, ready for KMS. The attestor signer runs as a separate small process that replays the transcript before it signs. The analyst moves to its own worker. | M1, M23 |
| 7.5 | **Keeper:**<ul><li>cancels expired Open lobbies with too few players, and Pending lobbies past the VRF timeout;</li><li>prunes `tracked`;</li><li>the client gets a cancel button.</li></ul> | H8 |
| 7.6 | **Restart handling:** take a snapshot of matches that are Live at startup and abandon only those. Do nothing until the first poll succeeds. | H9 |
| 7.7 | **Logs:**<ul><li>the ranking comes from the archive;</li><li>if a log fallback is needed, it starts at the deploy block from the registry;</li><li>one chunked `getLogs` helper shared with `proposals.ts`;</li><li>multicall for match reads;</li><li>a confirmations depth for reorgs;</li><li>lobbies under other rules are hidden.</li></ul> | H10, M8 |
| 7.8 | **Practice matches** never touch the relayer or the attestor key. | H13 |
| 7.9 | **Matchmaking:**<ul><li>a queue per (stake, seats) tier;</li><li>the server assigns lobbies and signs a `JoinTicket{matchId, player, expiry}` that the escrow checks for public lobbies;</li><li>private lobbies (`isPrivate`) keep join-by-id and earn no play-mining.</li></ul>The README notes that players who queue together can still collude. | H7, C4 |
| 7.10 | **Match start:**<ul><li>a ready phase: round 1 starts when every seat is connected or after N seconds;</li><li>push a "match live" event to seated players;</li><li>`watch` retries until the room exists.</li></ul> | M4 |
| 7.11 | **Resumable rooms:** persist each round's commit/reveal log, so a restart resumes at the last resolved round instead of refunding. | M2 |
| 7.12 | **Wire:** send deltas instead of the whole `publicState()`, and `msRemaining` instead of an absolute deadline. | M5, M6 |
| 7.13 | **Proxy IP:** a `TRUSTED_PROXY_HOPS` setting picks the right-most untrusted `X-Forwarded-For` entry. XFF is ignored by default. | N8 |
| 7.14 | **Rooms:** index rooms by matchId and socket. `watch` detaches from the previous room. | L1 |
| 7.15 | **One instance (Q24):** documented as a limit. Rate limits and rooms stay local. | M3 |

---

## Phase 8: Client

| Step | Work | Findings |
|---|---|---|
| 8.1 | **Chain guard:**<ul><li>the wallet client gets the hub chain;</li><li>`writeContract` no longer passes `chain: null`;</li><li>before `join` or `createMatch`, switch the chain or refuse.</li></ul> | N1, M19 |
| 8.2 | **Small reactive store** (Preact Signals or a typed store with subscriptions). Rendering never sends anything: reveal sends move into actions. | M18 |
| 8.3 | **Code-split** the arena, governance, staking and zap screens. Stop re-exporting `sim` and bots from `@lms/engine` into the browser. | M20 |
| 8.4 | **Arena:** remove seats, call `destroy()` and free textures between matches. | L3 |
| 8.5 | **UI for the new features:**<ul><li>verification result and Dispute button;</li><li>vesting view;</li><li>discount toggle;</li><li>matchmaking queue;</li><li>bridge join and withdraw-to-chain.</li></ul> | C3, C4, H4, H7 |

---

## Phase 9: Packages and docs

| Step | Work | Findings |
|---|---|---|
| 9.1 | **Split `@lms/protocol`:**<ul><li>`@lms/consensus`: hashing, rules, EIP‑712, frozen vectors;</li><li>`@lms/contracts`: generated ABIs and the registry;</li><li>`@lms/api`: wire types and DTOs.</li></ul>UI analytics move to the client. | M21 |
| 9.2 | **Analyst:** a single structured-output call in its own worker. | M23 |
| 9.3 | **Docs pass:**<ul><li>remove history-narrating comments;</li><li>fix the stale counts and the `relayer.ts` reference;</li><li>cut `FEATURES.md` down;</li><li>add short ADRs for each decision above.</li></ul> | M25 |
| 9.4 | **README:**<ul><li>threat model;</li><li>trust model;</li><li>roles table: Safe, guardian, treasury, timelock, `MultisigPhase` end date, VRF subscription owner, and who holds each key;</li><li>wallet matrix;</li><li>wash-trading economics;</li><li>"testnet only; mainnet needs independent signers and a licence".</li></ul> | H1, H6, C4, Q8 |

---

## Phase 10: Test bar before calling it done

- Branch coverage ≥ 90% on every contract that moves value. Today it's 44% on config, 43% on LayerZero (now deleted), 33% on VRF and 61% on RewardsDistributor.
- Escrow invariant handler:
  - several concurrent matches;
  - bounded preconditions, so lock, veto, withdraw and withdrawFor revert well under 20% of the time (today it's about 80%);
  - a seeded campaign.
- New invariants: dispute and pause expiry (a pause never outlives `pausedUntil` without governance), fee discount (escrowed LMS = Σ pending discounts), vesting, `StakedLms`.
- Fork tests: VRF v2.5 on Base Sepolia, the chosen bridge, the sequencer feed.
- Golden transcripts and an EIP‑712 vector in both languages.
- A Slither baseline in CI with zero new findings.

---

## Order and dependencies

```
Phase 1 ─┬─> Phase 2 ─┬─> Phase 3 (governance/token)
         │            ├─> Phase 4 (verifiability) ──> needs 5.1 for session-signed moves
         │            └─> Phase 6 (Across, after the 6.1 setup)
         └─> Phase 7 (server bugs N3, N8, H8–H13 can start right after Phase 1)
Phase 5.1 (login grant) early: Phase 4 depends on it
Phase 8 alongside the phase each UI change belongs to; 8.1 (N1) right away
Phase 9 and 10 last, but tests land with every step
```

**Quick wins** (small and independent, can start as soon as Phase 1 is in): N1, N3, N4, N5, N8, N9, H8, H9, H11, H13, 2.7.

---

## Coverage: every finding mapped to a step

| Finding | Step(s) | Finding | Step(s) |
|---|---|---|---|
| C1 | 5.1, 5.2, 5.4 | M5 / M6 | 7.12 |
| C2 | 5.1, 5.3, 5.5 | M7 | 5.1 |
| C3 | 4.1–4.7, 4.9 | M8 | 7.7 |
| C4 | 3.5, 3.6, 7.9, 9.4 | M9 | 1.7 |
| N1 | 8.1 | M10 | 7.2 |
| N2 | 6.2 | M11 | 2.11, 5.3 |
| N3 | 7.1 | M12 | 2.10 |
| N4 | 2.6 | M13 | 3.4 |
| N5 | 2.5 | M14 | 1.6 |
| N6 | 6.3 | M15 | 1.5 |
| N7 | 3.1 | M16 | 2.9 |
| N8 | 7.13 | M17 | 1.10 |
| N9 | 7.2 | M18 | 8.2 |
| H1 | 2.8, 3.1–3.3, 9.4 | M19 | 5.4, 8.1 |
| H2 | 2.4 | M20 | 8.3 |
| H3 | 2.1, 2.2 | M21 | 9.1 |
| H4 | 6.1–6.5 | M22 | 4.8 (kept, pinned) |
| H5 | 2.3 | M23 | 7.4, 9.2 |
| H6 | 2.10, 4.9 | M24 | 1.3, 1.4, 1.7, 2.8 |
| H7 | 7.9, 3.6 | M25 | 4.9, 9.3 |
| H8 | 7.5 | M26 | 1.8 |
| H9 | 7.6 | M27 | 1.1, 1.2, 1.3, 1.10 |
| H10 | 7.7 | L1 | 7.14 |
| H11 | 7.3 | L2 | 2.4, 2.7, 2.12, 6.2 |
| H12 | 4.5, 7.1 | L3 | 8.4 |
| H13 | 7.8 | L4 | 1.4, 1.9 |
| M1 | 7.4 | Test gaps | 3.8, 4.8, 6.5, Phase 10 |
| M2 / M3 | 7.11 / 7.15 | Predictable practice bots | documented in 9.4, no change |
| M4 | 7.10 | | |
