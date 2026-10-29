# Last Man Standing — game design and architecture

A cross-chain multiplayer arena. The match itself runs off-chain on an authoritative
server so rounds resolve in milliseconds; the money — stakes, prize pool, payouts —
never leaves the chain. The two halves are joined by a hash chain and a signed
attestation, so the server can be fast without being trusted.

---

## Part 1 — How the game works

### The shape of a match

Between 4 and 8 wallets take a seat in a lobby (the engine and the seat encoding
support up to 256; the default rule set caps a lobby at 8). Everyone stakes the same
amount. Play proceeds in rounds until one player is left standing.

Each round every living player secretly picks one of three actions:

| Action | Effect |
| --- | --- |
| **Strike** `#n` | Hits seat `#n` for 25 HP. A hit that lands heals the striker half of it (12 HP) |
| **Guard** | Blocks one strike aimed at you and reflects 34 HP onto that striker; any others connect. Never two rounds running |
| **Charge** | Loads your next Strike with +34 (59 in all). While charging you take 25% more from strikes. Never two rounds running, never while loaded |

A player who fails to submit anything in time — or reveals a Guard or Charge its
cooldown rules out — is recorded as `None`: every strike on them lands. Not playing
earns nothing.

### Resolving a round

1. **Strikes resolve simultaneously** against the state at the *start* of the round.
   A player who dies this round still lands the strike they declared — there is no
   initiative order and no advantage to acting "first", because nobody acts first.
2. **Guard beats one Strike.** A guard blocks one of the strikers that came at it —
   picked by the round's entropy, not by seat — and that striker deals nothing and
   takes the full 34 back. The rest connect, so focus fire is the answer to a guard.
3. **Strike beats Charge.** A charging player deals nothing this round and takes
   25% more from every strike that reaches it.
4. **Charge beats Guard.** The guard spent its turn; the charger loaded a hit worth
   more than two ordinary ones, and everyone can see it is loaded.
5. **Healing** from landed strikes is added before anything else is settled, and
   can never lift a player above their starting HP. It is what makes fighting pay:
   without it, damage dealt to one rival helps every other rival just as much.
6. **The stall penalty** is applied last, to everyone, and only to a table that has
   stopped fighting: once 2 rounds in a row pass without a single hit (a Guard's
   reflection counts), everyone takes 8, then 16, 24 … until somebody lands one.
   It replaces the old storm, which did most of the damage in every match and made
   the final round a coin flip between whoever was left.
7. **Elimination** takes everyone at or below 0 HP, ordered worst-first by HP and then
   by the round's tiebreak draw — never by seat index, which is join order. If a
   round would wipe the entire lobby, the player with the least overkill survives on
   1 HP, so a match always produces exactly one winner.

The cooldowns are the backbone. They stop a player from guarding forever, and since
they are public they turn reads into certainties: a seat that guarded last round
cannot guard now. Charging cannot stack either, so a loaded seat has to swing before
it can load again.

Every roll in a round — each Guard's pick of which striker to block, each tiebreak —
comes from `roundSeed(matchSeed, round, salts)`, where `salts` are the salts every
player revealed that round. Nobody can compute a roll until every reveal is in, and
the salts are published with the round so anyone can re-derive it.

The numbers are not hand-picked. They came out of a search over action sets and
rule values, then a validation pass (an exact game-theory solve of the 1v1 duel,
a gauntlet of rule-based strategies, an exploiter search, per-lobby-size and
per-seat checks). `npm run sim` re-checks the result on the real engine: every
mindless strategy (always Strike, always Guard when it can, always Charge when it
can) must win less than its share and lose money under the payout schedule.

**Changing the rules** is a consensus change on both sides. `hashRules` and
`HashLib.Rules` must match field for field (the parity tests pin one vector on each
side), `contracts/config/rules.json` feeds the deploy script, and a deployment that is
already live needs governance to call `ProtocolConfig.setRulesHash` with the new digest.
Every match records the hash it was created under; the server refuses to lock or play a
match whose hash is not the rule set it runs, so lobbies created before the switch are
refunded rather than re-ruled. Archived matches from older rules can no longer be
replayed by this engine.

Final ranking is survivors by remaining HP, then everyone else in reverse elimination
order — surviving longer always outranks falling earlier. Survivors level on HP,
which only happens when the round cap ends a match, are split by the last round's
tiebreak draw.

### Information is the real game

Choices are hidden while they are being made and fully public afterwards. After every
round the history feed shows exactly what happened:

```
#7  → struck #13
#13 → struck #7
#4  → guarded
#9  → charged
#13 → eliminated
```

After five rounds you are no longer playing the dice, you are playing the table.
*"#7 always strikes the leader"* is actionable: Guard when it comes for you and it
eats 34. *"#9 is charged"* is a certainty, not a guess — it is on every seat, and
the 59 it is carrying will land on somebody next time it swings. The server's bots
(`smartStrategy`) play the same way — they read each opponent's revealed moves and
cooldowns, sample plausible rounds, and play the move that comes out best.
Practice lets the player pick easy, normal or hard.

### Known risk: collusion

Two seats that never strike each other and share their moves out of band have an edge
no rule can see. In the validation runs, two colluding hard bots in a lobby of hard
bots won 1.74× as often as two honest ones and made +0.46 stake per seat. Under the
old storm rules the same pair got only 1.09× — not because those rules resisted
collusion, but because the storm decided matches and play barely did. Any rule set
where choices matter makes a non-aggression pact worth money.

Commit-reveal does not help here: colluders simply tell each other what they will do.
The mitigations are around the game rather than in it:

- **Matchmaking instead of joinable lobbies.** Today a lobby is joined by id, so two
  wallets controlled by one person can sit at the same table on purpose. Random
  assignment into lobbies makes that much harder.
- **Detection from the public history.** Every move is published, so a pair that
  never strikes each other across many matches is visible after the fact. The
  analyst and the play-style records are the natural place to flag it.
- **The payout schedule.** How much a pact earns depends on how the pot is split.

None of these exist yet.

Hidden information is enforced cryptographically, not by trusting the operator. During
the commit window a player publishes only

```
keccak256(abi.encode(matchId, round, seat, action, target, salt))
```

The server physically cannot read a move until the reveal window opens. Because the
match id, round number and seat are inside the hash, a commitment cannot be replayed in
a later round or claimed by another seat, and the target is forced to zero for every
action but Strike so the hash does not leak whether you intended to strike.

The match seed is delivered by a randomness oracle *after* the lobby locks, and every
roll also mixes in the round's revealed salts. Neither the server nor a player can pick
moves against known rolls, and anyone holding the seed and the published salts can
replay every roll in the match.

---

## Part 2 — Architecture

### Layers

```
packages/protocol   shared types, rules, hashing, EIP-712, wire format   (no I/O)
packages/engine     pure resolution kernel + match state machine + replay
packages/server     WebSocket gateway, rooms, chain bridge, attestor, archive
packages/client     PixiJS arena, wallet session, history and reads panels
contracts/          escrow, config, Yul libraries, adapters
```

The dependency direction is strictly one-way: `contracts` and `protocol` know nothing
about the server; the engine knows nothing about the network; the server knows nothing
about rendering. Everything that decides who gets paid lives in `protocol` + `engine` +
`contracts`, all of which are deterministic and independently testable.

### `packages/protocol` — the shared contract

| File | Responsibility |
| --- | --- |
| `index.ts` | The package's exports, grouped by the folders below |
| `wire.ts` | `ClientMessage` / `ServerMessage` union, `LobbyInfo`, login prefix |
| **`game/`** | **The rules everybody agrees on** |
| `game/types.ts` | `Action`, `Seat`, `PlayerState`, `RoundRecord`, `MatchPhase`, `MatchResult`, `PublicMatchState` |
| `game/rules.ts` | `Rules`, `DEFAULT_RULES`, `assertValidRules`, the cooldowns (`isLegalAction`), strike, charge and stall arithmetic |
| `game/hash.ts` | `commitMove`, `hashRound`, `historySeed`, `chainHistory`, `drawBps`, `deriveMatchId`, `hashRules` |
| **`chain/`** | **Everything tied to a chain or a contract** |
| `chain/chains.ts` | Chain table, badge colours, and the endpoint-id → chain-id normalisation |
| `chain/eip712.ts` | `MatchResult` typed-data schema and domain |
| `chain/escrow.ts` | The `GameEscrow` ABI and status enum, shared by the server and the client |
| `chain/avatars.ts` | The `PlayerAvatars` ABI and the `AvatarEntry` a seat is drawn with |
| `chain/session.ts` | The `SessionKeyDelegate` ABI and `sessionCallDigest`, pinned to Solidity |
| **`util/`** | **Small shared helpers** |
| `util/address.ts` | `addressKey`, `sameAddress`, `ZERO_ADDRESS` — one place that decides address casing |
| `util/errors.ts` | `errorMessage` / `errorFirstLine`, so `catch (unknown)` reads the same everywhere |

Everything in `game/hash.ts` is built with `abi.encode` so Solidity can recompute it
byte-for-byte. `contracts/src/libraries/HashLib.sol` is the mirror, and both sides pin
the same frozen vectors (`packages/protocol/test/parity.test.ts` and
`contracts/test/unit/HashLib.t.sol`), so an encoding change fails exactly one suite
instead of drifting silently.

### `packages/engine` — deterministic game logic

- **`kernel/resolve.ts`** is the kernel: `resolveRound(rules, seed, round, states, moves)` is
  pure and total. It does not read the clock, does not use floating point, and does not
  depend on the order moves arrive in. This is what makes a match replayable.
- **`match/match.ts`** is the per-match state machine: commit → reveal → resolve, phase
  guards, commitment verification, ranking, and the public snapshot that is safe to
  broadcast (it carries seat numbers and HP, never a pending action).
- **`match/replay.ts`** is the audit path: `replayMatch(setup, moveLog)` recomputes the whole
  match from the seed and published moves, and `verifyResult` checks a claimed result
  against it. It shares nothing with `Match` except the pure kernel. The initial state,
  the per-round fold and the ranking rule are therefore written out twice **on purpose**:
  sharing them would make `verifyResult` a tautology, because a wrong ranking rule would
  produce a wrong result and a wrong replay that agree perfectly. A differential test in
  `properties.test.ts` replays 45 matches across three bot strategies to hold the two
  derivations to the same answer.
- **`bots/strategy.ts`** holds the bots: a seeded keccak PRNG, `always`, `randomStrategy`,
  `readerStrategy`, and the house bot `smartStrategy` with its three difficulties. All
  of them pick only moves their cooldowns allow; `sim/simulate.ts` names them for
  `npm run sim` and the analyst's reference matches.

### `packages/server` — authoritative, but not trusted

| File | Responsibility |
| --- | --- |
| `main.ts` | Composition root: reads the config, wires every component, listens |
| `index.ts` | The package's public exports. Importing it boots nothing |
| `config.ts` | Environment configuration |
| **`match/`** | **One live match** |
| `match/room.ts` | Phases, the round clock, client fan-out, held moves (a move a player hands over with its commit, checked against the commitment *and* the rules there and then, which the server reveals for them if they drop) |
| **`bots/`** | **The house players** |
| `bots/bots.ts` | `BotDriver`: plays the house seats, with seed-derived salts |
| **`lobby/`** | **Which matches exist, and what happens when one ends** |
| `lobby/lobby.ts` | Room registry; creates practice lobbies, adopts on-chain matches, finalises results; ticks every room's clock, isolating a room that throws so it cannot stall the others or take the process down |
| `lobby/store.ts` | Match archive: in-memory by default, Postgres when `DATABASE_URL` is set |
| **`gateway/`** | **The socket boundary** |
| `gateway/gateway.ts` | Session registry, wallet login, message dispatch |
| `gateway/frames.ts` | Frame decoding and the error frame that goes back when it fails |
| **`chain/`** | **Everything that talks to a chain** |
| `chain/bridge.ts` | `ChainBridge`: discovers lobbies, serves the directory, locks ready lobbies, opens a room once a match is seeded — only if the match's on-chain `rulesHash` is the rule set this server plays; otherwise it never locks the lobby, and calls off and refunds a live one rather than playing it under other rules |
| `chain/escrowReader.ts` | The hub as an interface, plus the viem implementation of it |
| `chain/attestor.ts` | Signs the EIP-712 result, packs signatures, submits `settle` |
| `chain/relayer.ts` | Submits and pays for calls a player's session key authorised |
| `chain/avatars.ts` | `AvatarRegistry`: reads each seat's NFT on its own chain and resolves the image |
| `chain/viem.ts` | Client construction for a chain known only by id and RPC URL |

Three deliberate design choices make this testable:

- **The room owns the clock but never reads it.** `tick(now)` is driven from outside —
  a 250 ms interval in production, a loop in tests — so a whole match can be played
  deterministically without timers.
- **Clients are opaque sinks.** `Room` talks to a `Client` interface with a single
  `send`, so the state machine has no idea WebSockets exist.
- **Importing the package boots nothing.** `index.ts` is exports only and `main.ts` is
  the composition root, so every test imports `@lms/server` without opening a port.
- **The chain is an interface.** `ChainBridge` takes an `EscrowReader` rather than
  building viem clients itself, so the poll loop — cursor arithmetic, lock conditions,
  adopt-once — is exercised against a fake instead of an RPC. `ChainBridge.start` still
  takes a URL and builds the real one, so nothing at the composition root changed.

Login is a signed nonce: the server issues a random nonce on connect, the wallet signs
`Last Man Standing login\nnonce:<nonce>`, and the server recovers the address. The
wallet *is* the identity, and it is the same address that staked on-chain.

`ChainBridge` converges on the chain's view through a single polling loop rather than a
web of event subscriptions: it discovers lobbies from `MatchCreated`, re-reads each
tracked match's state, and acts on what it finds. That means a missed block, a restart,
or a flaky RPC costs a few seconds rather than a desynchronised server. A room is only
ever opened for a match that is already `Live`, which is the first moment the randomness
oracle has answered for a locked seat list — so the server cannot start play before the
seed exists, and cannot choose moves against a roll it already knows. Locking a full or
expired lobby is permissionless; the keeper key is a convenience, and if it is offline
any player can lock the lobby themselves.

**Restarts.** A room lives only in memory, so a restart loses every match in progress.
Those matches are not resumed or replayed from round one — players have seen rounds and
know moves that a fresh room would deal again. Instead, on its first poll the bridge
treats every match that is already `Live` as abandoned: it has the attestor quorum sign
`MatchAbort` and call `GameEscrow.abortMatch`, which refunds every seat at once, and it
tells a player who reconnects that the match was cancelled. If no attestor key is
configured, the match is refunded through the permissionless `cancelMatch` once its
settlement deadline passes. Practice rooms are simply gone.

### `packages/client` — the player's view

| File | Responsibility |
| --- | --- |
| `main.ts` | Entry point, three lines: calls `start()` |
| `app.ts` | `start()`, and the switch that routes each server message to the screen that owns it |
| `context.ts` | `AppState`, plus the shared `dom` and `net`, assigned once at boot |
| `motion.ts` | GSAP, with its plugins registered and lag smoothing off. Import `gsap` from here |
| **`assets/`** | **Everything loaded at boot** |
| `assets/manifest.ts` | The Pixi asset manifest: the replay's effect textures |
| `assets/loader.ts` | Loads the manifest once, skipping any file that fails rather than failing the lot |
| **`screens/`** | **What the player sees, and the controls on it** |
| `screens/loading.ts` | The boot screen: a progress bar while assets load |
| `screens/lobby.ts` | Practice, the staked-lobby directory, create and join |
| `screens/match.ts` | Commit/reveal handshake, panels, replay hold, history feed, timer |
| **`wallet/`** | **The player's account** |
| `wallet/flows.ts` | Connect, login, session keys, relayed calls, avatar and hub-chain panels |
| `wallet/wallet.ts` | Injected EIP-1193 session, login signature, escrow / avatar / session calls |
| `wallet/session.ts` | The browser's session key: load, grant, sign logins and relayed calls |
| **`game/`** | **Match logic that runs in the browser** |
| `game/phase.ts` | *Pure.* `phasePlan` — what the controls should be, and whether a reveal is due |
| `game/reads.ts` | *Pure.* Derives per-opponent tendencies and tells from the public history |
| `game/salts.ts` | Persists the sealed move so a refresh cannot cost the player the round |
| **`arena/`** | **The Pixi canvas** |
| `arena/arena.ts` | Pixi scene: seats on a circle with address sigils or avatars, HP arcs with a lagging damage ghost, chain badges, the arena wall that closes in as the table stalls, a ⚡ on every charged seat, your aim, a round HUD |
| `arena/choreography.ts` | *Pure.* Turns a `RoundRecord` into a schedule of timed beats |
| `arena/replay.ts` | Builds the round's GSAP timeline: HP drains and heals, shatters, the stall flare |
| `arena/effects.ts` | Adds the visual effects to that timeline: projectiles, shields, particles, shake, winner |
| `arena/theme.ts` | The arena's palette and text styles, including the replay's effect tints |
| `arena/layout.ts` | *Pure.* Seat-ring and arena-wall geometry |
| **`ui/`** | **The DOM around the canvas** |
| `ui/dom.ts` | `queryDom(document)` — the element registry, as a factory |
| `ui/views.ts` | *Pure.* Target options, chain chips, reads table, hub label, avatar panel |
| `ui/format.ts` | *Pure.* `short`, `describeDraft`, `formatCountdown` |
| `ui/chrome.ts` | `toast` and `showMatchScreen`, the helpers more than one screen uses |
| **`io/`** | **Browser I/O** |
| `io/net.ts` | Typed socket with backoff reconnect, re-auth, and an outbox |
| `io/storage.ts` | `localStorage` that cannot throw, shared by `game/salts.ts` and `wallet/session.ts` |

The folders split along two lines. By feature: each screen owns its controls, and
`app.ts` does nothing but route server messages to them. By purity: anything that
decides *what* to show — the *Pure* rows above — is tested in node, while anything that
writes to the document lives in `screens/` or `wallet/flows.ts`. `phasePlan` returns a
`shouldReveal` flag rather than sending the reveal itself, so the decision is testable
while the send stays exactly where it was in the sequence.

The screens share one page, one socket and one set of elements, so that state lives in
`context.ts` as module singletons rather than being threaded through every call. `dom`
and `net` are ES-module live bindings assigned once in `start()`; `context.ts` imports
only types, which keeps the runtime graph acyclic.

Three things are worth calling out:

- **The arena renders only published state.** During the commit phase a seat shows *that*
  it has committed, never what it committed to, so the view cannot leak a hidden move.
- **The reveal is automatic.** The player already chose during the commit window; making
  them click a second time would only manufacture no-shows.
- **The reads panel is bookkeeping, not privileged data.** It is computed from the same
  history every spectator receives — it just does the counting the player would otherwise
  do on paper.

### The round replay

A resolved round is played back rather than snapped into place: strikers lunge,
projectiles travel (gold when a Charge is behind them), guards flash and bounce a
reflection back, landed hits draw a heal off the striker, charging seats crackle, the
stall penalty bites from the arena wall, and eliminated seats shatter with a short screen shake. The
winner is crowned after the final round.

- **Choreography is pure; GSAP does the motion.** `choreograph(record, before)` turns
  a `RoundRecord` into a schedule of timed beats. `buildReplay` turns that schedule into
  one GSAP timeline that tweens a plain `SeatDisplay` per seat — HP, liveness, the
  shatter's swell and fade — and `Effects.decorate` adds the visuals to the same
  timeline, so a projectile lands on exactly the frame its target's HP starts to drain.
  The arena computes no interpolation of its own; it only draws the tweened values.
  The schedule uses nothing but the published record, so the replay can never show
  anything the history feed does not. HP moves between two waypoints and the client holds no rule constants
  beyond the HP cap: `before − damage − reflected + heal` is exact from the record, and the end is always the
  published `hpAfter`. That keeps it honest when the engine does something the client
  cannot reconstruct, such as reviving the least-overkilled seat on 1 HP.
- **The arena shows less than it knows while replaying.** The server sends `round`
  and then, synchronously, the post-round snapshot. Painting that snapshot would refill
  or empty every arc before the replay could show how. So while a replay runs, HP and
  liveness come from the replay's tweened `SeatDisplay`; afterwards the snapshot takes
  over. After the *final*
  round no snapshot ever follows, so the replay's last frame stays pinned instead of
  reverting to the state the round began with.
- **The server holds the clock, not the client.** After a round resolves the room waits
  `REPLAY_MS` before the next commit window starts, and `round` carries that as a
  relative `replayMs` so no clock needs reconciling. Commits made during the hold are
  kept, but the reveal cannot open early. Without that gate, a practice table would skip
  the pause entirely, because bots commit the instant a round resolves. Settlement is
  never delayed for a cosmetic: `finished` goes out immediately, and only the client
  defers *showing* it until the replay has played.
- **The replay runs on the wall clock.** GSAP's lag smoothing is switched off in
  `motion.ts`: by default it holds its clock back across a long frame gap, which would
  let the replay fall behind the server's hold and spill into the commit window.
  Moments the timeline only reaches by jumping far past them — a backgrounded tab — are
  skipped rather than fired in a pile.
- **Textures load at boot, and are optional.** The effects use fourteen CC0 textures
  from Kenney's Particle Pack in `packages/client/public/fx/` (about 98 KB, provenance in
  its `LICENSE.txt`), white with the shape in alpha so they tint to the theme exactly.
  They are declared in a Pixi asset manifest and loaded behind a loading screen when the
  page opens, so the arena finds them cached. The loader uses Pixi's `skip` strategy: a
  texture that fails is dropped, not the whole bundle, and the effects draw a generated
  glow in its place — just as a seat without an avatar keeps its plain circle.
- **Hit-stop borrows only spare hold.** The first kill of a round freezes the replay
  for a beat, but `round` carries `replayMs`, and the freeze is sized to what the
  choreography leaves of it (at most 0.1 s, always 0.15 s short of the hold), so the
  replay still ends before the next commit window opens. A server with no hold gets
  no hit-stop.
- **Your draft is drawn, nobody else's.** During the commit phase the arena shows the
  move *you* have picked — an aim line and reticle, a guard, a veil — and seats can be
  clicked to target them. It is local state only; other seats still show nothing but
  whether they have locked in.
- **Reduced motion is respected.** Under `prefers-reduced-motion`, travel, particles,
  lunges and shake are skipped; the HP drain and the floating numbers remain, because
  they carry information rather than decoration.

### `contracts/` — where the value lives

| Contract | Role |
| --- | --- |
| `PullPayable` | Base for both escrows: credited balances, `totalOwed`, pull-based `withdraw` |
| `Errors` | The errors several contracts raise identically, hoisted to file level |
| `ProtocolConfig` | Every governable parameter: fees, seat ranges, stake bounds, windows, payout schedule, rules hash, oracle, attestor set and threshold, per-chain messengers and peers, emergency guardian. Owned by a `TimelockController` whose proposer is a Safe. |
| `GameEscrow` | The hub. Takes stakes, locks the lobby, requests the seed, accepts a quorum-signed result, credits payouts. |
| `SpokeEscrow` | Spoke-chain gate: forwards a stake plus a join message to the hub, receives bridged payouts. |
| `ZapJoin` | Periphery: joins a lobby paying in any ERC-20, swapped to exactly the stake through Uniswap v4, then seated via `GameEscrow.joinFor`. Ownerless; holds nothing between transactions. |
| `PlayerAvatars` | Cosmetic ERC-721 avatars. Deployed independently per chain, never bridged. |
| `SessionKeyDelegate` | EIP-7702 delegate: scoped, expiring session keys plus ERC-1271. |
| `LayerZeroMessenger` | Adapts LayerZero v2 to the transport-agnostic `ICrossChainMessenger`. |
| `ChainlinkVrfAdapter` | Presents a VRF v2.5 subscription as `IRandomnessOracle`. |

**Match lifecycle on-chain**

```
createMatch(stake, maxSeats)      terms snapshotted from ProtocolConfig
  ↓  join() / receiveMessage()    local stake, or a stake bridged from a spoke
lockMatch()                       permissionless once full, or quorate and expired
  ↓  requestRandomness()
fulfillRandomness()               seed = keccak(randomness, matchId) → status Live
  ↓  MatchStarted event           the server adopts the match and plays it
settle(rounds, root, ranking, sigs)  attestor quorum, ranking = seat set
  ↓                               → Proposed: nothing paid yet
veto()                            guardian or governance, before challengeDeadline:
  ↓                               → Cancelled, every stake refunded
finalize(ranking)                 after challengeDeadline, permissionless → Settled, payouts credited
withdraw(to) / withdrawFor(acct)  pull-based, always; withdrawFor pays the account itself
```

**Security properties the contracts enforce**

- *Solvency.* `address(this).balance == totalOwed + totalEscrowed` — asserted as a
  Foundry invariant across random call sequences.
- *The ranking must be exactly the seat set.* `SeatSetLib.assertPermutation` rejects an
  omitted, repeated or foreign address, so a compromised quorum cannot redirect the pool.
- *Quorum without duplicates.* `SignatureLib.recoverAscending` requires strictly
  ascending signer addresses — one rule that rejects duplicates, canonicalises the set,
  and costs one comparison per signature. `s` is bounded to the lower half-order and `v`
  to {27, 28}, so a signature cannot be replayed in malleable form.
- *Terms are snapshotted.* A governance change cannot alter the deal a player already
  staked into.
- *Pausing cannot trap funds.* `cancelMatch` and `withdraw` are deliberately not gated,
  and cancellation is permissionless once the relevant deadline passes.
- *Pausing is fast, resuming is slow.* The guardian Safe can `pause()` without the
  timelock; only governance can `unpause()`, so lifting a pause waits out the delay.
- *A veto can only refund.* `veto` voids a proposed result and credits every seat its
  stake back; it cannot redirect a payout. It is not paused, so it is always available
  inside the window.
- *Both ends of a bridge are authenticated.* A trusted transport still relays messages
  from untrusted senders, so the messenger **and** the origin peer are checked.

**Where Yul is used, and why**

| Library | Technique | Reason |
| --- | --- | --- |
| `SettlementLib` | Hashes the ranking straight out of calldata into scratch memory | Settlement is the only path that moves value and hashes a variable-length array on every call; the ABI-encoder version copies the ranking twice |
| `SignatureLib` | One reusable `ecrecover` frame for the whole batch | Runs `threshold` times per settlement |
| `SeatSetLib` | EIP-1153 transient storage as a scratch set | Turns the permutation check from quadratic to linear, which matters at the 256-seat ceiling |
| `HashLib` | Hand-rolled `chainHistory` / `drawBps` | Two-word and three-word hashes with no ABI encoder overhead |

Every Yul routine has a Solidity reference implementation next to it and a differential
fuzz test proving they agree, including with dirty high bits in calldata addresses.

### Avatars

Players wear cosmetic NFT avatars in the arena. Three decisions shape the design:

- **Per chain, not bridged.** `PlayerAvatars` is deployed independently on the hub and
  on every spoke, so a player mints on the chain they already play from. The collection
  that applies to a seat is the one on the chain that seat staked from — the same origin
  the chain badge shows. That costs the server an RPC per chain (`AVATAR_COLLECTIONS`
  carries an address *and* a URL per entry) and buys a player never having to bridge to
  look like themselves.
- **Outside consensus, deliberately.** Nothing about an avatar reaches the commit hash,
  the round hashes, the history root or the rules hash. The engine cannot see one, and a
  replay is byte-identical with or without. So avatars travel in their own `avatars` wire
  message rather than inside `PublicMatchState`, which is produced by the engine and must
  stay ignorant of cosmetics. A cosmetic that changed a result would be pay-to-win; one
  that entered the hash chain would break replay for anyone without the metadata.
- **Every failure is soft.** Resolving an avatar means a chain read *and* an IPFS fetch,
  either of which can be slow or simply not answer. `AvatarRegistry` resolves in the
  background after the room is already playable, caches per wallet — including the
  misses, which are the expensive ones — and degrades to "no avatar" on any error. The
  seat falls back to a plain circle and the match is unaffected. The metadata hop happens
  on the server rather than in each browser so there is one gateway policy, one cache and
  one timeout instead of every client fetching the same eight files.

### Account abstraction: EIP-7702, not ERC-4337

The goal is that playing does not mean approving a transaction every few minutes.
The dominant cost is not the stake — it is the login: the gateway authenticates with a
signed nonce and issues a fresh one per connection, so every reconnect (a dropped socket,
a refresh, a laptop waking mid-match) prompts the wallet while a commit clock is running.

**Why 7702 rather than a smart account.** In this protocol the address *is* the identity:
`GameEscrow` keys seats, rankings and payouts by the address that staked, and
`seatOrigin` records where it staked from. Migrating players onto freshly deployed 4337
accounts would change every one of those addresses and strand existing seats. An EIP-7702
authorization keeps the exact same address and merely gives it code.

**The one-time cost.** The player signs an authorization pointing their EOA at
`SessionKeyDelegate` and, in the same transaction, calls `grantSession` on *themselves* —
a call that only resolves because the authorization in that same transaction put the code
there. From then on the browser holds a key that signs logins locally.

**Scope, because a key that can do anything is the account key with extra steps.** Three
axes, all enforced on-chain: an expiry with no "never" option, a cumulative native-value
cap, and an explicit `(target, selector)` allowlist. The client grants `join`, `withdraw`,
`mint` and `equip` — so a leaked key cannot create lobbies or transfer the player's avatar
away, and cannot move more than the cap regardless.

**Two consequences elsewhere.** The gateway can no longer verify logins with `ecrecover`
alone: a session-key signature does not recover to the account, and only the account can
answer whether it is valid. So `SignatureVerifier` is injected — offline `ecrecover` in
practice-only mode, an RPC-backed ERC-1271 check when an RPC exists. And the server will
not advertise a delegate it cannot verify against, because a session login the gateway
would reject is worse than no offer at all.

**The relayer is untrusted.** `executeWithSession` is permissionless to submit, so the
server pays the gas for calls players' session keys signed. It cannot alter one (the
signature covers target, value, calldata and nonce), replay one (the delegate keeps a
nonce per account), or exceed the player's scope (the delegate checks it on-chain). The
worst it can do is refuse, and the client then falls back to a wallet transaction. It is
an interface with a null default, like the messenger and the oracle, so a 4337 bundler or
a dedicated relay service can replace it without the client noticing.

`sessionCallDigest` in `protocol` mirrors the delegate's EIP-712 hashing and is pinned to
it by frozen vectors on both sides, exactly as the commit hashes are. A drift there would
not corrupt a match, but every relayed call would silently stop recovering the session key.

### Trust model

A result is signed by a quorum of allowlisted attestors and is *proposed*, not paid. The
signed root commits to every round's actions, targets, salts, HP and eliminations, so
anyone holding the published rounds can replay the match with the same pure kernel the
server runs and see whether the result follows from them. Every player's browser does
exactly that at the end of a match (`client/src/game/verify.ts`) and compares its root
with the one the escrow stored.

Detection is off-chain; the remedy is on-chain. For `challengeWindow` after `settle`, the
guardian Safe (or governance) may `veto` the result, which refunds every stake. Once the
window closes unvetoed, anyone may `finalize` it. So a dispute is decided by the Safe,
backed by a replay anyone can run for free — not by the contract. A compromised guardian
can void honest results, but every player keeps their stake; it can never redirect one.

This is a deliberate trust level for a testnet and a low-stake early mainnet. An on-chain
fraud proof — a Solidity port of the kernel that replays a challenged match and slashes
bonded attestors — was built and removed: it doubled every rule change while the rules
are still moving. It is in git history (`fadf583`) for when the rules are frozen.

What stays trusted beyond that: the quorum could invent a player's *move*. The published salt must
open the player's commitment, but commitments are exchanged off-chain, so a forged move
replayed faithfully looks valid. Everything downstream of the moves is enforced. The
seed is drawn after the lobby closes, and each round's rolls also depend on every
player's revealed salt, so nobody can choose moves against known rolls.

### Cross-chain model

Hub-and-spoke. The hub chain holds all escrowed value and all match state; spokes hold
nothing but a forwarding gate. A player on a spoke calls `SpokeEscrow.join`, which sends
the stake and `(matchId, player)` through the messenger; the hub seats them and records
their origin chain. If the seat can no longer be taken when the message lands — the lobby
filled or locked in flight, the stake was wrong, the escrow is paused — the hub credits
the stake to the player there instead of reverting, because a revert would strand it with
the transport. Payouts stay on the hub; `withdrawFor` lets a keeper push one to a player
who holds no gas there. The `ICrossChainMessenger` interface is transport-agnostic, so
the adapter can be swapped without touching game logic.

**Authentication.** `LayerZeroMessenger` serves one local app. It only sends for that
app, puts the app's address in the envelope, checks the remote messenger against its
configured peer on receipt, and hands the escrow the *originating app* as `srcSender`. So
the escrow's peer check names the remote `SpokeEscrow`, not merely the messenger that
carried the message. Each message's executor options deliver exactly that lobby's stake.

**One id space.** The messenger translates LayerZero endpoint ids (`40161`) to EVM chain
ids (`11155111`) at its boundary, so `GameEscrow.seatOrigin` holds chain ids, or zero
for a stake placed on the hub, which `originChainId` maps to the hub. Origins are read from
`PlayerJoined`, which already carries them, and cached per seat; the escrow is only read
for a seat that joined before the backfill window.

**Showing it.** The origin rides through `Seat.chainId` into `PublicMatchState`, and the
arena draws it as a coloured pill above each seat — so a lobby that pulled stakes from
four chains looks like it. Lobby rows carry the same chips, aggregated per chain, and
the topbar warns when the connected wallet is on a different chain than the hub, because
otherwise every stake reverts with an error the wallet renders unreadably.

### Testing

- **TypeScript (vitest, 18 files / 190 tests):** engine unit tests, property tests over
  random strategies (termination, unique ranking, HP bounds, determinism, replay
  equivalence, tamper detection), protocol parity vectors, room lifecycle,
  gateway auth and lobby directory, attestation.
- **Solidity (Foundry, 15 suites / 95 tests):** unit tests per contract and library,
  differential fuzzing of the Yul hashers and the signature recovery loop, and a stateful
  invariant campaign driving `GameEscrow` through random call sequences while asserting
  solvency. A deeper campaign is available with `FOUNDRY_PROFILE=deep`.
- **Typecheck covers the tests too.** Each package has a `tsconfig.test.json` resolving
  `@lms/*` to source, exactly as `vitest.config.ts` does, so a cast that has rotted in a
  test fails `npm run typecheck` rather than sitting there unchecked.
- **Some tests pin behaviour that is wrong.** `config.test.ts` asserts that a
  non-numeric `COMMIT_MS` yields `NaN`. Such tests exist so that fixing the behaviour
  is a deliberate, visible change. Every one maps to a step in `docs/FIX_PLAN.md`.
- **Gas:** `contracts/.gas-snapshot` is committed and `npm run sol:snapshot:check` fails
  on drift. `SettlementLibGas.t.sol` additionally asserts the Yul hasher is never worse
  than the ABI-encoder reference, warming the harness first so the measurement is not
  dominated by cold-account access.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `WS_PORT` | `8787` | WebSocket / HTTP port |
| `CHAIN_ID` | `11155111` | Hub chain id |
| `COMMIT_MS` / `REVEAL_MS` | `20000` / `12000` | Round windows |
| `REPLAY_MS` | `2500` | Hold after each round for the client replay, before the next commit clock |
| `RPC_URL` | — | Hub RPC; without it the server runs practice lobbies only |
| `ESCROW_ADDRESS` | zero | `GameEscrow` to watch and settle against |
| `ATTESTOR_PK` | — | Attestor key; without it results are archived but not submitted |
| `KEEPER_PK` | `ATTESTOR_PK` | Pays for the permissionless `lockMatch` call |
| `DATABASE_URL` | — | Postgres (e.g. Neon) for the archive, analysis cache and play styles; falls back to in-memory |
| `SESSION_DELEGATE` | zero | `SessionKeyDelegate` for 7702 session keys. Needs `RPC_URL` to be verified |
| `AVATAR_COLLECTIONS` | — | `PlayerAvatars` deployments as JSON: `chainId`, `address`, `rpcUrl` per chain |
| `IPFS_GATEWAY` | `https://ipfs.io/ipfs/` | Prefix `ipfs://` is rewritten to when fetching metadata |
| `VITE_WS_URL` | current host `:8787` | Server the browser client connects to |
| `VITE_DEV_KEY` | — | Dev-only burner key so the practice loop needs no wallet extension |

See `.env.example` for the annotated template.

### Commands

```bash
npm run build          # tsc project references
npm run typecheck      # src, the client, and every test file
npm test               # vitest
npm run sol:build      # forge build
npm run sol:test       # forge test
npm run sol:fuzz       # fuzz suites only
npm run sol:invariant  # invariant suites only
npm run sol:snapshot   # refresh contracts/.gas-snapshot

npm run dev --workspace @lms/server    # ws://localhost:8787
npm run dev --workspace @lms/client    # http://localhost:5173
```
