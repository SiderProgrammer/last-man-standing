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
roll also mixes in the round's full set of commitments: `roundSeed(seed, round,
commitmentSetHash(commitments by seat))`. Each commitment hides a fresh salt, so nobody
can know the rolls before every commitment is in, and from then on nothing at the reveal
can move them: a withheld or dropped reveal costs that seat its move, never re-rolls the
round. The set stays hidden until the commit window closes, or the last to commit could
grind a salt against the others'. Anyone holding the seed and the published commitments
can replay every roll in the match.

---

## Part 2 — Architecture

### Layers

```
packages/protocol   shared types, rules, hashing, EIP-712, wire format   (no I/O)
packages/engine     pure resolution kernel + match state machine + replay
packages/server     WebSocket gateway, rooms, chain bridge, attestor, archive
packages/client     PixiJS arena, wallet session, history and reads panels
contracts/          escrow, config, libraries, adapters
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
| `chain/session.ts` | The `SessionKeyDelegate` ABI, `sessionCallDigest` pinned to Solidity, and the session scope check |
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
- **`bots/strategy.ts`** (`@lms/engine/bots`) holds the bots: a seeded keccak PRNG,
  `always`, `randomStrategy`, `readerStrategy`, and the house bot `smartStrategy` with its
  three difficulties. All of them pick only moves their cooldowns allow;
  `sim/simulate.ts` (`@lms/engine/sim`) names them for `npm run sim` and the analyst's
  reference matches. Neither is in the main entry, which the browser bundles.

### `packages/server` — authoritative, but not trusted

| File | Responsibility |
| --- | --- |
| `main.ts` | Composition root: reads the config, wires every component, listens |
| `index.ts` | The package's public exports. Importing it boots nothing |
| `config.ts` | Environment configuration |
| **`match/`** | **One live match** |
| `match/room.ts` | Phases, the round clock and the ready phase before round 1, client fan-out (the whole state on attach, deltas after), held moves (a move a player hands over with its commit, checked against the commitment *and* the rules there and then, which the server reveals for them if they drop), each round's signatures and receive times, the journal entries a restart replays, and the transcript it hands the lobby at the end |
| `match/journal.ts` | `RoomJournal`: a staked room's commits, reveals and clock moves, in order, in memory or Postgres |
| **`bots/`** | **The house players** |
| `bots/bots.ts` | `BotDriver`: plays the house seats, with seed-derived salts |
| **`lobby/`** | **Which matches exist, and what happens when one ends** |
| `lobby/lobby.ts` | Room registry, indexed by match, by watching client and by seated wallet; creates practice lobbies, adopts on-chain matches, resumes them from their journal after a restart, holds a watch for a lobby still to open; finalises results through a retry queue; ticks every room's clock, isolating a room that throws so it cannot stall the others or take the process down |
| `lobby/matchmaker.ts` | `Matchmaker`: a queue per tier, and a matchmade lobby opened with its roster once a tier has a table |
| `lobby/store.ts` | Match archive, transcripts included: in memory, or the Postgres repository when `DATABASE_URL` is set |
| `lobby/styles.ts` | Play styles by wallet, in memory or the Postgres repository |
| `lobby/transcripts.ts` | `GET /transcripts/<hash>`: a staked match's transcript, by the hash the escrow stored |
| **`db/`** | **Postgres** |
| `db/database.ts` | The one pool, transactions, the migration runner, and the lock that keeps a second server off the database |
| `db/migrations.ts` | The schema, as an append-only list of migrations |
| `db/storage.ts` | Every repository over one database, or all in memory |
| **`attestor/`** | **The attestor's own process** |
| `attestor/service.ts` | Replays a transcript, checks it against the escrow, and only then signs its result; signs aborts and receipts |
| `attestor/process.ts` | The child process that holds the attestor key and nothing else |
| `attestor/remote.ts` | The server's side: forks the child, forwards calls, restarts it if it dies |
| **`gateway/`** | **The socket boundary** |
| `gateway/gateway.ts` | Session registry, login under a session grant, move-signature checks, commit receipts, message dispatch |
| `gateway/frames.ts` | Frame decoding and the error frame that goes back when it fails |
| **`chain/`** | **Everything that talks to a chain** |
| `chain/bridge.ts` | `ChainBridge`: discovers lobbies, serves the directory, locks ready lobbies, opens a room once a match is seeded — only if the match's on-chain `rulesHash` is the rule set this server plays; otherwise it never locks the lobby, and calls off and refunds a live one rather than playing it under other rules |
| `chain/escrowReader.ts` | The hub as an interface, plus the viem implementation of it, reading every tracked match in one Multicall3 batch |
| `chain/attestor.ts` | The relayer: the attestor's signature, sent by the keeper; packs signatures |
| `chain/txSender.ts` | `TxSender`, one per key: ordered nonces, one transaction in flight per action, receipts, and replacement of a stuck one |
| `chain/signer.ts` | `Signer`, the interface every key signs through, where a KMS would plug in |
| `chain/logs.ts` | The one chunked `getLogs` scan, and the confirmation depth every scan stops at |
| `chain/sessionRelay.ts` | Submits and pays for joins and withdrawals a player's session key signed, under a daily quota |
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

Login is a session grant plus a signed nonce. The wallet signs one EIP-712
`SessionGrant{wallet, sessionKey, domain, uri, chainId, issuedAt, expiresAt, nonce}`,
shaped like a SIWE message so a wallet binds it to the page asking; the browser keeps
the grant and its key for a day. On every connect the server issues a random nonce and
the *key* signs `Last Man Standing login\nnonce:<nonce>`. The server checks the grant
(its chain, its expiry, at most a week, its origin against `ALLOWED_ORIGINS`, and the
wallet's signature, through ERC-1271 for a contract wallet) and that the key signed the
nonce. From then on every commit and reveal must be signed by that key as EIP-712
`Commit` / `Reveal` typed data naming the match, round and seat, and each accepted commit
is answered with a signed `CommitReceipt`. The wallet *is* the identity, and it is the
same address that staked on-chain. A login with a plain wallet signature and no grant
still works, for watching; it cannot play.

`ChainBridge` converges on the chain's view through a single polling loop rather than a
web of event subscriptions: it discovers lobbies from `MatchCreated`, re-reads each
tracked match's state, and acts on what it finds. That means a missed block, a restart,
or a flaky RPC costs a few seconds rather than a desynchronised server. A room is only
ever opened for a match that is already `Live`, which is the first moment the randomness
oracle has answered for a locked seat list — so the server cannot start play before the
seed exists, and cannot choose moves against a roll it already knows. Locking a full or
expired lobby is permissionless; the keeper key is a convenience, and if it is offline
any player can lock the lobby themselves.

**Restarts.** A staked room journals everything that moves it on — every commit and
reveal with its signatures, and every move its clock makes — and a commit's receipt is
not sent until its entry is written. The bridge does nothing until one poll has read
every tracked match, and the matches live at that point are the ones the previous
process was playing. Each is replayed from its journal into a fresh room: the same
round, the same commitments and so the same rolls, with a new ready phase for its players
to reconnect in and the window it was in given back in full. A restart cannot re-roll a
round. Only a match with no journal (an in-memory server) or one that does not replay is
abandoned: the attestor signs `MatchAbort` and the keeper calls `GameEscrow.abortMatch`,
refunding every seat at once, or the permissionless `cancelMatch` does at the settlement
deadline. Practice rooms are simply gone.

**One instance.** Rooms, the matchmaking queue and every rate limit live in the
process, and each key's transactions go out of one `TxSender` in nonce order. A second
instance would split the rooms and the queue, double the limits and race for nonces, so
the server runs as one: with Postgres it takes an advisory lock on the database at
start, and a second server is refused.

### `packages/client` — the player's view

| File | Responsibility |
| --- | --- |
| `main.ts` | Entry point, three lines: calls `start()` |
| `app.ts` | `start()`, and the switch that routes each server message to the screen that owns it |
| `context.ts` | `AppState` in the store, plus the shared `dom` and `net`, assigned once at boot |
| `store.ts` | The typed store: `set` a patch, `subscribe` a renderer to the keys it draws |
| `motion.ts` | GSAP, with its plugins registered and lag smoothing off. Import `gsap` from here |
| **`assets/`** | **Everything loaded at boot** |
| `assets/manifest.ts` | The Pixi asset manifest: the replay's effect textures |
| `assets/loader.ts` | Loads the manifest once, skipping any file that fails rather than failing the lot. A chunk of its own, with Pixi |
| **`screens/`** | **What the player sees, and the controls on it** |
| `screens/loading.ts` | The boot screen: a progress bar while assets load |
| `screens/lobby.ts` | Practice, the staked-lobby directory, create and join, from the hub or a spoke |
| `screens/queue.ts` | The matchmaking queue: pick a tier, wait, leave |
| `screens/discount.ts` | *On demand.* Paying part of a seat's fee in LMS: quote, permit, join |
| `screens/zap.ts` | *On demand.* Paying a stake in a token through `ZapJoin` |
| `screens/staking.ts` | *On demand* (`stakingPanel.ts`). Stake, unstake, claim, vesting and release, delegation |
| `screens/governance.ts` | *On demand* (`governanceNav.ts`). Proposals, votes, the proposal form |
| `screens/result.ts` | The result: ranking, the browser's and the chain's verification, Dispute |
| `screens/match.ts` | Commit/reveal handshake, panels, replay hold, history feed, timer; mounts and disposes the arena |
| **`wallet/`** | **The player's account** |
| `wallet/flows.ts` | Connect, login with the session grant, avatar and hub-chain panels |
| `wallet/chains.ts` | The viem chain every write names, and `WrongChainError` |
| `wallet/payouts.ts` | Collecting winnings: on the hub, or to the spoke the wallet is on (`collectHome.ts`, on demand) |
| `wallet/staking.ts`, `governance.ts`, `zap.ts`, `discount.ts` | *On demand.* Each screen's contract calls and ABIs, out of the main bundle |
| `wallet/wallet.ts` | Injected EIP-1193 session, the chain guard, login signature, escrow / avatar / session calls |
| `wallet/grant.ts` | The browser's session key and the wallet's grant to it: sign logins, moves and relayed calls |
| `wallet/oneClick.ts` | One-click play: turn the on-chain session on and off, relay joins and collects |
| `io/keystore.ts` | Secrets sealed in IndexedDB under a non-extractable WebCrypto key |
| `csp.ts` | The Content-Security-Policy the production build ships with |
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
| `arena/textures.ts` | Seat faces leased by URL, unloaded once no seat wears them |
| **`ui/`** | **The DOM around the canvas** |
| `ui/dom.ts` | `queryDom(document)` — the element registry, as a factory |
| `ui/views.ts` | *Pure.* Target options, chain chips, reads table, hub label, avatar, queue, discount and collect-home panels |
| `ui/format.ts` | *Pure.* `short`, `describeDraft`, `formatCountdown` |
| `ui/chrome.ts` | `toast` and `showMatchScreen`, the helpers more than one screen uses |
| **`io/`** | **Browser I/O** |
| `io/net.ts` | Typed socket with backoff reconnect, re-auth, and an outbox |
| `io/storage.ts` | `localStorage` that cannot throw, shared by `game/salts.ts` and `wallet/session.ts` |

The folders split along two lines. By feature: each screen owns its controls, and
`app.ts` does nothing but route server messages to them. By purity: anything that
decides *what* to show — the *Pure* rows above — is tested in node, while anything that
writes to the document lives in `screens/` or `wallet/flows.ts`.

The screens share one page, one socket and one set of elements, so their state is one
typed store in `context.ts` (`store.ts`), not threaded through every call. Actions —
server messages, clicks, timers — change it with `store.set`, and they alone send
anything. Each panel subscribes its renderer to the keys it draws, and a renderer only
draws: the reveal, for one, is sent by the actions that can make it due (a new snapshot,
the end of a replay hold), with `phasePlan`'s `shouldReveal` deciding. `dom` and `net`
are ES-module live bindings assigned once in `start()`.

The main bundle holds the lobby, the match screen and what verifying a match needs. The
arena and Pixi, the asset loader, the staking panel, the governance screen, token
payment, the fee discount and collecting to a spoke load on demand, each with its own
contracts' ABIs (`chain/abis/` is one module per contract for that reason). The browser
imports `@lms/engine`, which is the kernel, matches, replay and audit; bots and the
balance simulator are `@lms/engine/bots` and `@lms/engine/sim`, for the server and the
scripts.

Every write names its chain. Before one, the wallet is put on that chain — the hub for
everything but a join from a spoke or a mint — by asking an injected wallet to switch
(adding the chain if it has never seen it), and a wallet that cannot switch, like the dev
burner, is refused with the two chains named. viem then refuses to sign if the wallet was
switched away in between, and the panels follow the wallet's `chainChanged`.

The arena lives for one match. Changing match or going back to the lobby destroys it: the
canvas and its WebGL context, its tweens, seats and effects, and the faces its seats
wore, which `arena/textures.ts` unloads from Pixi's cache once no seat holds them.

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
| `ProtocolConfig` | Every governable parameter: fees, seat ranges, stake bounds, windows, payout schedule, rules hash, oracle, attestor set and threshold, the bridge receiver, emergency guardian. Owned by a `TimelockController` whose proposer is a Safe. |
| `GameEscrow` | The hub. Takes stakes, locks the lobby, requests the seed, accepts a quorum-signed result, credits payouts. |
| `SpokeRouter` | Spoke chain: deposits a stake into Across with a join message for the hub. Ownerless; holds nothing. |
| `BridgeJoinReceiver` | Hub: takes Across fills and seats the player through `GameEscrow.bridgeJoin`, or credits them; bridges a balance home on a signed `withdrawToChainFor`. Owned by the timelock. |
| `ZapJoin` | Periphery: joins a lobby paying in any ERC-20, swapped to exactly the stake through Uniswap v4, then seated via `GameEscrow.joinFor`. Ownerless; holds nothing between transactions. |
| `PlayerAvatars` | Cosmetic ERC-721 avatars. Deployed independently per chain, never bridged. |
| `SessionKeyDelegate` | EIP-7702 delegate: a session key may `join` and `withdrawFor` on the escrow, under caps; ERC-1271 for the root key only. |
| `ChainlinkVrfAdapter` | Presents a VRF v2.5 subscription as `IRandomnessOracle`. |

**Match lifecycle on-chain**

```
createMatch(stake, maxSeats)      terms snapshotted from ProtocolConfig
  ↓  join() / bridgeJoin()        local stake, or a stake bridged from a spoke
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
- *The ranking must be exactly the seat set.* `settle` rejects an omitted, repeated or
  foreign address, so a compromised quorum cannot redirect the pool.
- *Quorum without duplicates.* `SignatureLib.recoverAscending` requires strictly
  ascending signer addresses — one rule that rejects duplicates, canonicalises the set,
  and costs one comparison per signature. Recovery is OpenZeppelin's `ECDSA`, which
  rejects a malleable `s`. Attestors must therefore be EOAs.
- *Terms are snapshotted.* A governance change cannot alter the deal a player already
  staked into.
- *Pausing cannot trap funds.* `cancelMatch` and `withdraw` are deliberately not gated,
  and cancellation is permissionless once the relevant deadline passes.
- *A guardian pause expires.* The guardian can `pause()` without the timelock, but only
  for 7 days, and not again until 7 days after a pause ends. Only governance can
  `extendPause(until)`, through the timelock. Either can `unpause()`.
- *A veto can only refund.* `veto` voids a proposed result and credits every seat its
  stake back; it cannot redirect a payout. It is not paused, so it is always available
  inside the window.
- *A bridged join cannot be forged, only paid for.* `bridgeJoin` takes only the
  config's receiver, and the receiver only the hub's Across SpokePool, which pays the
  value before it calls. The message is not trusted: anyone may deposit with any
  message, which only ever buys someone a seat with real ETH, like `joinFor`.

**No hand-written assembly.** Settlement hashing, signature recovery and the seat-set
check are plain Solidity over OpenZeppelin's `EIP712` and `ECDSA`. The Yul versions
saved about 1k gas on a four-seat settlement (0.1%), which did not pay for the review
burden.

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
Logins and moves do not need the delegation for that: the session grant above makes
every reconnect prompt-free for every kind of wallet. The delegation is for one-click
joins and withdrawals, relayed and paid for by the server, and only for wallets that can
sign an authorization for our delegate: the dev burner and embedded wallets. Injected
wallets and Coinbase Smart Wallet keep the normal flow. See the wallet matrix in the README.

**Why 7702 rather than a smart account.** In this protocol the address *is* the identity:
`GameEscrow` keys seats, rankings and payouts by the address that staked. Migrating players
onto freshly deployed 4337 accounts would change every one of those addresses. An EIP-7702
authorization keeps the exact same address and merely gives it code.

**The one-time cost.** The player signs an authorization pointing their EOA at
`SessionKeyDelegate` and, in the same transaction, calls `grantSession` on *themselves* —
a call that only resolves because the authorization in that same transaction put the code
there. The key it grants is the browser's session key, the one the grant above names, and
the on-chain session ends when that grant does.

**Scope is fixed in code, not granted.** A key that can be pointed at anything is the
account key with extra steps, so the delegate is deployed with the escrow as an immutable
and allows exactly two calls on it: `join(matchId)` and `withdrawFor(account)` naming the
account itself. `withdrawFor` pays only the account, so a leaked key can stake the
player's ETH into lobbies but never send it anywhere. On top of that, set at grant: a cap
per call (0.05 ETH from the client), a cap in total (0.25 ETH), and an expiry, at most
seven days out. `executeWithSession` is not payable: the stake always comes from the
account, never from whoever submits.

**Logins are not the delegate's business.** `isValidSignature` answers for the account's
own key only. A session key that spoke for the account through ERC-1271 would be accepted
by anything that checks it — a permit, an order, a login — with no cap at all. The server
checks the off-chain session grant instead, and uses ERC-1271 only for contract wallets.

**The relayer guards its own gas, not the player.** `executeWithSession` is permissionless
to submit, and `SessionRelay` submits what players' keys signed from a key of its own
(`SESSION_RELAYER_PK`), never the attestor's. It cannot alter a call (the signature covers
target, value, calldata and nonce), replay one (the delegate keeps a nonce per account), or
exceed the player's scope (the delegate checks it). What it checks is whether to spend gas:
the call is one the delegate would accept, the account is delegated to *our* delegate
(the call runs as the account's code, which could be anything), it simulates cleanly, and
the wallet has relayed fewer than `RELAY_QUOTA_PER_DAY` calls today. A refusal names the
revert (`ValueCapExceeded`, `SessionExpired`, the escrow's own error), and the client falls
back to a wallet transaction.

`sessionCallDigest` in `protocol` mirrors the delegate's EIP-712 hashing and is pinned to
it by frozen vectors on both sides, exactly as the commit hashes are. A drift there would
not corrupt a match, but every relayed call would silently stop recovering the session key.
`npm run check:one-click` runs the whole path on a Prague anvil with the real deploy.

**The key in the browser.** It is secp256k1, which WebCrypto cannot hold, so it is kept in
IndexedDB sealed with an AES-GCM key generated non-extractable: a dump of the site's storage
holds only ciphertext. Script in the page could still use it, which is why the production
build ships a Content-Security-Policy that allows no script but the bundle's own and names
every origin the page may reach, and why no markup is ever built from data.

### Trust model

**Verifiable, not enforced.** One operator runs the server and, today, holds the only
attestor key; a separate guardian key can veto. Nothing on-chain checks a move. What the
protocol does instead is make every claim the operator makes checkable by anyone, and give
a seated player a way to object in time.

- **Moves are signed.** Each player's wallet grants a browser-held key, and that key signs
  every commit and reveal for a named match, round and seat. The server can drop a move;
  it cannot invent or alter one without a key it does not have.
- **Commits are receipted.** The server signs a `CommitReceipt` for every commit it takes
  (with the attestor key, so the escrow's attestor set vouches for it). The commitment set
  is published when the window closes, and the round's rolls are drawn from it, so a
  dropped reveal cannot re-roll the round.
- **The transcript is archived first.** At the end of a match the server stores the full
  transcript — setup, every round record, every signature, every grant — and only then
  settles. `settle` carries the transcript's hash; it is part of the EIP-712 `MatchResult`
  the attestors sign, and the escrow stores and emits it. A transcript that cannot be
  archived is never settled: the match is aborted and refunded.
- **The browser checks it against the chain.** Once the result is proposed, every
  player's browser reads the escrow (seed, rules digest, seats, root, ranking hash,
  transcript hash), fetches the transcript by its hash (`GET /transcripts/<hash>`), and
  runs `auditTranscript`: the hash matches, the replay reaches the stored root and ranking,
  every reveal opens its commitment, every move is signed by a key its seat's wallet
  granted, and the player's own moves and receipts are all accounted for.
- **A player can dispute.** If the audit fails, `dispute(matchId, evidenceHash)` — any
  seated player, once each, inside the challenge window — pushes the payout back by
  `DISPUTE_EXTENSION` (48 h). The evidence bundle (the problems, the player's sealed moves,
  salts and receipts) goes to the guardian, who replays the transcript and calls `veto`
  (every stake refunded) or `dismissDispute` (the deadline goes back to where it was).
  Neither `dispute`, `veto`, `dismissDispute` nor `finalize` is ever paused.

What stays trusted:

- **The guardian decides disputes, and liveness rests on it doing so.** A guardian that
  neither vetoes nor dismisses lets the result finalise when the extension runs out. A
  compromised guardian can void honest results, but every player keeps their stake; it can
  never redirect one.
- **`abortMatch` lets the operator refund any live match.** It needs only the attestor
  quorum, which is the operator today. It can send every stake back early; it cannot take
  one.
- **The attestors are not yet independent.** The quorum is one key, so the signed result
  says what the server says. The transcript is what makes that checkable, and the escrow
  enforces the quorum either way, so independent attestors are a deployment change.
- **Censorship is only partly provable.** A receipted commit missing from the transcript,
  or a sent reveal counted as missing, is evidence. A commit the server refuses before
  receipting it is not.
- **Held moves are visible to the server.** With "reveal for me if I disconnect", the
  server learns the move at commit time: the one case where it knows a move before the
  reveal.

This is a deliberate trust level for a testnet and a low-stake early mainnet. An on-chain
fraud proof — a Solidity port of the kernel that replays a challenged match and slashes
bonded attestors — was built and removed: it doubled every rule change while the rules
are still moving. It is in git history (`fadf583`) for when the rules are frozen.

### Cross-chain model

Hub-and-spoke over a value bridge, [Across](https://across.to). The hub (Base) holds all
escrowed value and all match state; spokes (Arbitrum, Optimism, Ethereum) hold nothing.
A player on a spoke calls `SpokeRouter.join` with a fee quote from the Across API. The
router deposits the stake plus the fee into Across's SpokePool there, naming the hub's
`BridgeJoinReceiver` as recipient and `(matchId, player, origin chain)` as the message.
A relayer fills it on the hub: the SpokePool pays the receiver exactly the stake (in
WETH, since the receiver is a contract) and calls its handler, which unwraps it and
calls `GameEscrow.bridgeJoin`. If the seat can no longer be taken — the lobby filled or
locked in flight, too little arrived, the escrow is paused — the escrow credits it all
to the player there instead of reverting.

**Never revert a fill.** A handler revert reverts the fill, and an unfilled deposit waits
until its deadline before Across refunds it on the spoke (on testnet, possibly never). So
once the caller is the SpokePool, the receiver never reverts: value it cannot route
(another token, an unreadable message, an escrow that refuses) stays in the receiver,
with an `Unroutable` event, for the timelock to `recover`. A fill through the router
always routes.

**Getting money home.** Winnings and refunds are credited on the hub. A player with gas
there withdraws as usual. One without signs an EIP-712 `Withdrawal` (destination chain,
recipient, the most Across may take), and anyone, typically the server, submits it to
`withdrawToChainFor`, which moves the whole balance into an Across deposit to that chain.
The typed data has no chain id in its domain, so a wallet on a spoke can sign it.

**No registration.** The router is ownerless and the receiver takes a fill from any
chain Across serves, so a new spoke is a deploy and a line in the server's `SPOKES`, not
a governance proposal. The origin chain in a seat is what the message claims, shown and
never trusted. `GameEscrow.seatOrigin` holds it, or zero for a stake placed on the hub,
which `originChainId` maps to the hub. Origins are read from `PlayerJoined`, which already
carries them, and cached per seat; the escrow is only read for a seat that joined before
the backfill window. What was checked about Across, and what was not, is in
[ACROSS.md](ACROSS.md).

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
| `ATTESTOR_PK` | — | Attestor key, held by its own process; signs results, aborts and receipts, sends nothing |
| `KEEPER_PK` | — | Sends lock, settle, abort, finalise, cancel and harvest. Without it, nothing reaches the chain |
| `MATCHMAKER_PK` | — | Opens matchmade lobbies; without it there is no queue |
| `MATCHMAKING_TIERS` | 0.001 ETH × 4 and × 8, 0.01 ETH × 4 | The queues, as JSON |
| `MATCHMAKING_FILL_AFTER_MS` | `30000` | A short table opens once its first player has waited this long |
| `READY_MS` | `30000` | How long a staked room waits for every player before round 1's clock starts |
| `CONFIRMATIONS` | `3` | Blocks behind the head every log scan stops at |
| `TRUSTED_PROXY_HOPS` | `0` | Proxies of your own in front of the server; `X-Forwarded-For` is ignored at 0 |
| `DATABASE_URL` | — | Postgres (e.g. Neon) for the archive, analysis cache, play styles and room journals. Unreachable stops the server; blank or `ARCHIVE=memory` keeps everything in memory |
| `SESSION_DELEGATE` | registry | `SessionKeyDelegate` for one-click play. Offered only with `RPC_URL`, an escrow and `SESSION_RELAYER_PK` |
| `SESSION_RELAYER_PK` | — | Pays relayed gas. Its own key, holding only gas money |
| `RELAY_QUOTA_PER_DAY` | 20 | Relayed calls per wallet per UTC day |
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
