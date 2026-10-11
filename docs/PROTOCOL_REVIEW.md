# Last Man Standing — protocol review

Every feature implemented across the rules, protocol, engine, server, client and
contracts, with a verdict on each. Read from the source tree, not from the design
docs.

| Inventoried | Keep | Fix | Cut | Defer |
| --- | --- | --- | --- | --- |
| 64 | 44 | 14 | 4 | 2 |

---

## Critical finding

**Every dice roll in a match is public before the first move.**

`drawBps(seed, round, nonce)` is keyed on the match seed, the round number and
the attacker's seat. All three are public: the escrow emits the seed in
`MatchStarted` and `getMatch` returns it. Any player can therefore compute,
before committing, whether their attack will land against a hider this round —
and whether hiding will save them from a given opponent.

Hide's 60% evade is not a probability to anyone who reads the contract; it is a
lookup table. That collapses the Attack–Defend–Hide cycle the rules are built
on, and it splits the playerbase into those who read the code and those who
don't. Fix: idea 01 below.

---

## What is actually broken

### The opening is solved

Storm damage is zero for the first two rounds and Defend blocks every attacker
while riposting 20. Attacking early is strictly negative expected value, so the
rational opening is mutual Defend. In the one smoke-test match played end to
end, a pure turtle — zero attacks, five defends — won.

---

## What to cut

Not because these are badly written — they are not — but because each one
carries ongoing cost that its current value does not repay.

### The spectator markets — done

`MatchMarket` was 195 lines of value-handling contract with two live exploits
(late betting on a decided match, seated players backing an opponent and
throwing), a per-book claim bug, and permanent dust accrual, serving an audience
that does not exist for a four-to-eight player testnet game. It has been
removed; revisit only once there are spectators to sell to.

### `withdrawToChain`

A second irreversible transport path, with the same lost-in-transit failure mode
as the join path, to save a player one manual bridge after they have already
been paid on the hub. The convenience is not worth another way to lose funds.

### The timeout evade bonus

`timeoutEvadeBps: 3000` pays a 30% dodge for not playing. It exists to make
`Action.None` resolvable, but a forfeit resolves just as cleanly at zero — and
removing it deletes a branch from the kernel that a future fraud proof must
port to Solidity.

### Redis, from the stated stack

Listed in the brief, referenced nowhere in the code. Either adopt it for
presence and round persistence, or stop claiming it.

---

## Ideas worth building

Ordered by what changes the game most.

### 01. Derive each round's entropy from the revealed salts

**Impact:** critical · **Effort:** small — one hash change, mirrored in HashLib
and the frozen vectors

`roundSeed = keccak(matchSeed, round, sorted revealed salts)`. No player can
precompute a roll, because it depends on everybody's secrets. A player who
withholds a reveal to re-roll the round forfeits their own move and takes full
storm, which prices the grind honestly.

### 02. Let Defend block one attacker, not all of them

**Impact:** high · **Effort:** small — a few lines in `resolveRound`, plus
rebalancing

Turtling currently scales with how many people attack you, which is backwards.
If Defend parries the lowest-seat attacker and the rest connect, focus fire
beats a turtle, coalitions become the counterplay, and the read panel gains a
reason to exist.

### 03. ~~Close the on-chain markets when the lobby locks~~

Superseded: the on-chain markets were removed outright.

### 04. Make the history root enforceable with a fraud proof

**Impact:** critical · **Effort:** large — the single biggest piece of remaining
protocol work

Attestors publish the move log and salts; a challenge entry point re-derives
one disputed round on-chain and slashes a quorum whose root does not match.
`resolveRound` is already pure integer arithmetic, so it ports to Solidity —
that is the payoff for the discipline already in the engine.

### 05. Bond the attestors

**Impact:** critical · **Effort:** medium

A quorum can currently redirect a prize pool at zero cost. Require a stake in
`ProtocolConfig`, slashable by a successful challenge. This is what turns
"quorum-trusted" into "quorum-bonded" and it is a prerequisite for the fraud
proof to matter.

### 06. Ship an in-browser verifier

**Impact:** high · **Effort:** small — the engine work is done

`replayMatch` already recomputes a whole match from the seed and move log, and
nothing calls it. Run it in the client after settlement and show a "verified
against chain" badge with the recomputed root. It turns the strongest
architectural property into something a player can see.

### 07. Persist the read book across matches

**Impact:** high · **Effort:** medium — archive schema plus a client panel

Tendencies are thrown away when the room dies. Key them by wallet in the
archive and a regular opponent arrives with a dossier. This is genuinely novel
for a web3 game: a portable reputation of play style, grounded in matches that
settled on-chain.

### 08. ~~Give the chip book a season ladder, or delete it~~

Done: the chip book was deleted — payout maths, wire messages, room ledger and
UI panel.

### 09. Let the server hold the sealed move for disconnected players

**Impact:** medium · **Effort:** small

The server already sees every reveal as it arrives, so it is trusted not to
leak within the window. Accepting the sealed move alongside the commitment and
opening it at the deadline therefore costs no security, and a player whose
socket drops still acts.

### 10. Reach 10–50 players with brackets, not bigger tables

**Impact:** medium · **Effort:** medium — a bracket contract or an off-chain
scheduler

The brief asks for 10–50; the rules cap a lobby at 8 and the storm is tuned for
it. A 50-seat circle is unreadable and one attack each is noise. Run tables of
eight and advance winners — same engine, no rebalance, and the format gets a
finale.

---

## Full feature inventory

Verdicts: **Keep** earns its place · **Fix** broken or unsafe · **Cut** remove ·
**Defer** postpone

### Game rules

`packages/protocol/src/game/rules.ts`

| Feature | Verdict | Assessment |
| --- | --- | --- |
| Three simultaneous actions: Attack / Defend / Hide | Keep | The whole game. Cheap to reason about, hard to solve. |
| Attack deals 34, three hits kill from 100 HP | Keep | Short matches, real threat from a two-player coalition. |
| Defend fully blocks and ripostes for 20 | Fix | Blocks every attacker at once, so turtling scales with how many people attack you. |
| Hide evades 60% of attacks, takes half storm | Fix | The evade roll is publicly precomputable, so the 60% is not a probability to anyone who reads the seed. |
| Storm escalates 6 HP per round after 2 grace rounds | Fix | Zero storm for two rounds makes mutual Defend a free, dominant opening. |
| Timeout is a distinct action with a 30% evade | Cut | Pays a mechanical bonus for not playing. A no-show should simply forfeit the round. |
| Guaranteed single winner (last survivor rescued at 1 HP) | Keep | Settlement needs a total order; a wipe would strand the pool. |
| Deterministic elimination tie-break (HP, then seat) | Keep | Required for replay to reproduce the same ranking. |
| Eleven governable rule parameters | Defer | Large tuning surface, all hand-picked, none validated by simulation. |

### Protocol and hashing

`packages/protocol/src`

| Feature | Verdict | Assessment |
| --- | --- | --- |
| Commit–reveal bound to (matchId, round, seat) | Keep | A commitment cannot be replayed into another round or claimed by another seat. |
| Target zeroed for non-attack actions in the commit hash | Keep | Otherwise the preimage count would leak whether a player intended to attack. |
| `drawBps(seed, round, nonce)` pseudo-randomness | Fix | Depends only on public inputs, so every roll in the match is known before the first commit. |
| Round hash chained into a history root, seeded with rulesHash | Keep | A result can only be verified against the rule set it was played under. |
| `abi.encode` everywhere, mirrored by HashLib.sol | Keep | Frozen vectors pin both sides, so an encoding drift fails a test instead of bricking reveals. |
| EIP-712 MatchResult schema | Keep | Signers see a structured result, not an opaque digest. |
| Typed wire protocol shared by server and browser | Keep | One definition, compiler-enforced on both ends. |
| Off-chain elimination book (parimutuel chips) | Cut (done) | Chips were minted per room and evaporated at the final round, so winning them meant nothing. Removed. |
| Shared GameEscrow ABI | Keep | Server and client cannot drift from the deployed interface. |

### Engine

`packages/engine/src`

| Feature | Verdict | Assessment |
| --- | --- | --- |
| Pure, total, integer-only round resolution | Keep | The single most valuable property in the codebase — it is what makes a fraud proof possible. |
| Match state machine with phase guards | Keep | Rejects out-of-phase input instead of trusting the caller. |
| Public snapshot that never carries a pending action | Keep | The broadcast cannot leak a hidden move even by accident. |
| Replay and verify from seed plus move log | Keep | Currently unused by anything. Should be the product's trust story. |
| Seeded bot strategies (random, reader) | Keep | Makes practice mode viable without matchmaking. |

### Server

`packages/server/src`

| Feature | Verdict | Assessment |
| --- | --- | --- |
| Wallet login over a signed nonce | Keep | The staking address is the identity; no passwords, no session store. |
| Rooms driven by an injected clock | Keep | A whole match runs deterministically in a test loop. |
| Transport-agnostic client sink | Keep | The state machine has no idea WebSockets exist. |
| Practice lobbies against house bots | Keep | The only zero-friction way into the game. |
| Unlimited practice rooms per wallet | Fix | No cap, no rate limit — a trivial memory-exhaustion vector. |
| Free 1000-chip stack for spectators | Cut (done) | Went with the chip book. Spectating itself stays. |
| Attestor signing and settlement relay | Keep | Works, but one key is the quorum today. |
| Match archive (memory / Postgres) | Keep | Interface is right; the Postgres path has never been executed. |
| ChainBridge: discovery, directory, keeper lock, adoption | Keep | One convergent poll loop instead of a web of subscriptions. Never run against a real RPC. |
| Round state held only in memory | Fix | A restart mid-match loses the round; the match can then only end by cancellation. |

### Client

`packages/client/src`

| Feature | Verdict | Assessment |
| --- | --- | --- |
| PixiJS arena with HP arcs, attack bolts, storm ring | Keep | Renders only published state, so it cannot leak a hidden move. |
| History feed | Keep | The raw material the game is built on. |
| Reads panel: per-opponent tendencies and tells | Keep | The most product-differentiating thing here, and currently the least developed. |
| Automatic reveal when the window opens | Keep | A second click would only manufacture no-shows. |
| Sealed move persisted to localStorage | Keep | A refresh between phases no longer costs the round. |
| Reconnect with re-auth and re-attach | Keep | A dropped socket does not drop the seat. |
| Dev burner wallet behind `VITE_DEV_KEY` | Keep | Dev-build only. Makes the loop testable without an extension. |
| No withdrawal UI | Fix | `Wallet.withdraw` exists and nothing calls it — a player cannot collect a payout. |

### Contracts — escrow

`contracts/src/GameEscrow.sol`

| Feature | Verdict | Assessment |
| --- | --- | --- |
| Lobby lifecycle: create, join, lock, settle, cancel | Keep | Status machine is tight and every transition is tested. |
| Terms snapshotted at lobby creation | Keep | A governance change cannot alter the deal a player already staked into. |
| Permissionless lock and permissionless cancel | Keep | Players are never dependent on the operator to recover a stake. |
| Seed requested only after the seat list is final | Keep | Nobody can decide whether to join based on the seed. |
| Attestor quorum with ascending-signer recovery | Fix | An allowlist with no bond: a colluding quorum can redirect the pool at zero cost. |
| Ranking must be an exact permutation of the seat set | Keep | Caps the quorum's power at reordering, so it cannot pay a stranger. |
| Pull payments with a solvency invariant | Keep | `balance == totalOwed + totalEscrowed`, asserted by the invariant campaign. |
| Payout schedule validated exact and never longer than minSeats | Keep | Closes the index-past-the-ranking hole that would otherwise brick settlement. |
| Fee capped at 10%, remainder swept to treasury | Keep | Nothing can be stranded by integer division. |
| Pause that leaves cancel and withdraw open | Keep | Pausing can never trap player funds. |
| Full finishing order written to storage on settle | Fix | One SSTORE per seat, and nothing on-chain reads it now that the markets are gone. |

### Contracts — cross-chain

`contracts/src/SpokeEscrow.sol`

| Feature | Verdict | Assessment |
| --- | --- | --- |
| Winner / Top3 parimutuel spectator markets | Cut (done) | Two exploitable holes and no audience. Removed. |
| Cross-chain join via authenticated messenger and peer | Keep | Both the transport and the originating contract are checked — a trusted relay still carries untrusted senders. |
| Stake value carried with the join message | Fix | A stake that leaves the spoke but fails to seat on the hub is unrecoverable. |
| `withdrawToChain` — bridging a payout back out | Cut | Adds a second irreversible transport path to save a player one manual bridge. |

### Contracts — governance and Yul

`contracts/src/ProtocolConfig.sol`, `libraries/`

| Feature | Verdict | Assessment |
| --- | --- | --- |
| Single governable parameter surface behind a timelock | Keep | Ownable2Step, every setter validated, changes queued in public. |
| Threshold re-validated on every attestor change | Keep | The set can never be shrunk below its own quorum. |
| Config deploys with a zero rulesHash and zero oracle | Fix | A valid-looking config can be deployed in an unusable state; only the script prevents it. |
| Yul settlement, signature and seat-set libraries | Keep | 451 gas cheaper per settle at eight seats, differentially fuzzed against a plain reference. |
| Mock oracle and messenger for tests | Keep | Lets the full lifecycle run in Foundry without a live endpoint. |

---

*Source: working tree review, 17 Sep 2026 · 71 TypeScript tests and 61 Foundry
tests passing at the time of writing · verdicts are the reviewer's judgement,
not consensus.*
