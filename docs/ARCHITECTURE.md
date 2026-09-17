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
| **Attack** `#n` | Tries to take 34 HP off seat `#n` |
| **Defend** | Blocks incoming attacks and reflects 20 HP onto each attacker |
| **Hide** | Evades an attack 60% of the time, and takes only half storm damage |

A player who fails to submit anything in time is recorded as `None`: they behave like
a much worse Hide (30% evade) and take full storm damage.

### Resolving a round

1. **Attacks resolve simultaneously** against the state at the *start* of the round.
   A player who dies this round still lands the attack they declared — there is no
   initiative order and no advantage to acting "first", because nobody acts first.
2. **Defend beats Attack.** The attack deals nothing and the attacker takes 20 HP of
   riposte. Attacking into a read is a losing trade.
3. **Attack beats Hide, slowly.** A hider evades on a 60% roll, but chip damage adds
   up and hiding never makes progress of its own.
4. **Hide beats Defend.** Both are passive, but the storm hits a turtle twice as hard.
5. **The storm** is applied last, to everyone: `(round - 2) * 6` HP from round 3
   onward, halved for hiders. The storm is the clock. Without it, everyone defending
   forever would be a stable equilibrium and no one would ever be eliminated.
6. **Elimination** takes everyone at or below 0 HP, ordered worst-first by HP and then
   by seat index. If a round would wipe the entire lobby, the player with the least
   overkill survives on 1 HP, so a match always produces exactly one winner.

Final ranking is survivors by remaining HP, then everyone else in reverse elimination
order — surviving longer always outranks falling earlier.

### Information is the real game

Choices are hidden while they are being made and fully public afterwards. After every
round the history feed shows exactly what happened:

```
#7  → attacked #13
#13 → attacked #7
#4  → defended
#9  → hid
#13 → eliminated
```

After five rounds you are no longer playing the dice, you are playing the table.
*"#7 always attacks the leader"* is actionable: bait the attack with a Defend and take
20 HP off them for free. The server's bots (`readerStrategy`) play the same way — they
punish repeat attackers and pile onto the seat everyone else is hunting.

Hidden information is enforced cryptographically, not by trusting the operator. During
the commit window a player publishes only

```
keccak256(abi.encode(matchId, round, seat, action, target, salt))
```

The server physically cannot read a move until the reveal window opens. Because the
match id, round number and seat are inside the hash, a commitment cannot be replayed in
a later round or claimed by another seat, and the target is forced to zero for
non-attack actions so the hash does not leak whether you intended to attack.

Every evasion roll comes from `keccak256(seed, round, attackerSeat) % 10000`, where the
seed is delivered by a randomness oracle *after* the lobby locks. Neither the server nor
a player can pick moves against known rolls, and anyone holding the seed can replay
every roll in the match.

### Betting

Two independent markets, because they need different data:

- **Round eliminations (off-chain chips).** Before each commit window closes you back a
  seat to be eliminated this round. Chips are escrowed on the spot, the book is
  parimutuel: tickets on eliminated seats split the whole round pot; if nobody hit,
  everyone is refunded. This lives off-chain because it needs per-round history the
  escrow never sees.
- **Winner / Top 3 (on-chain, `MatchMarket`).** Real stakes on the finishing order,
  settled against the ranking the escrow has already attested. If the match is
  cancelled, or nobody backed a winning outcome, the book aborts and every stake is
  refundable.

---

## Part 2 — Architecture

### Layers

```
packages/protocol   shared types, rules, hashing, EIP-712, wire format   (no I/O)
packages/engine     pure resolution kernel + match state machine + replay
packages/server     WebSocket gateway, rooms, chain bridge, attestor, archive
packages/client     PixiJS arena, wallet session, history and reads panels
contracts/          escrow, config, markets, Yul libraries, adapters
```

The dependency direction is strictly one-way: `contracts` and `protocol` know nothing
about the server; the engine knows nothing about the network; the server knows nothing
about rendering. Everything that decides who gets paid lives in `protocol` + `engine` +
`contracts`, all of which are deterministic and independently testable.

### `packages/protocol` — the shared contract

| File | Responsibility |
| --- | --- |
| `types.ts` | `Action`, `Seat`, `PlayerState`, `RoundRecord`, `MatchPhase`, `MatchResult`, `PublicMatchState` |
| `rules.ts` | `Rules`, `DEFAULT_RULES`, `assertValidRules`, storm curve |
| `chains.ts` | Chain table, badge colours, and the endpoint-id → chain-id normalisation |
| `hash.ts` | `commitMove`, `hashRound`, `historySeed`, `chainHistory`, `drawBps`, `deriveMatchId`, `hashRules` |
| `eip712.ts` | `MatchResult` typed-data schema and domain |
| `wire.ts` | `ClientMessage` / `ServerMessage` union, `LobbyInfo`, login prefix |
| `betting.ts` | `settleEliminationBook` — parimutuel payout for the round book |
| `escrow.ts` | The `GameEscrow` ABI and status enum, shared by the server and the client |
| `avatars.ts` | The `PlayerAvatars` ABI and the `AvatarEntry` a seat is drawn with |
| `session.ts` | The `SessionKeyDelegate` ABI and `sessionCallDigest`, pinned to Solidity |

Everything in `hash.ts` is built with `abi.encode` so Solidity can recompute it
byte-for-byte. `contracts/src/libraries/HashLib.sol` is the mirror, and both sides pin
the same frozen vectors (`packages/protocol/test/parity.test.ts` and
`contracts/test/unit/HashLib.t.sol`), so an encoding change fails exactly one suite
instead of drifting silently.

### `packages/engine` — deterministic game logic

- **`resolve.ts`** is the kernel: `resolveRound(rules, seed, round, states, moves)` is
  pure and total. It does not read the clock, does not use floating point, and does not
  depend on the order moves arrive in. This is what makes a match replayable.
- **`match.ts`** is the per-match state machine: commit → reveal → resolve, phase
  guards, commitment verification, ranking, and the public snapshot that is safe to
  broadcast (it carries seat numbers and HP, never a pending action).
- **`replay.ts`** is the audit path: `replayMatch(setup, moveLog)` recomputes the whole
  match from the seed and published moves, and `verifyResult` checks a claimed result
  against it. It shares nothing with `Match` except the pure kernel.
- **`strategy.ts`** holds the bots: a seeded keccak PRNG plus `randomStrategy` and
  `readerStrategy`.

### `packages/server` — authoritative, but not trusted

| File | Responsibility |
| --- | --- |
| `room.ts` | One live match: phases, the round clock, the chip book, client fan-out |
| `lobby.ts` | Room registry; creates practice lobbies, adopts on-chain matches, finalises results |
| `gateway.ts` | Socket framing, wallet login, message dispatch |
| `chain.ts` | `ChainBridge`: discovers lobbies, serves the directory, locks ready lobbies, opens a room once a match is seeded |
| `attestor.ts` | Signs the EIP-712 result, packs signatures, submits `settle` |
| `avatars.ts` | `AvatarRegistry`: reads each seat's NFT on its own chain and resolves the image |
| `relayer.ts` | Submits and pays for calls a player's session key authorised |
| `store.ts` | Match archive: in-memory by default, Postgres when `DATABASE_URL` is set |
| `config.ts` | Environment configuration |

Two deliberate design choices make this testable:

- **The room owns the clock but never reads it.** `tick(now)` is driven from outside —
  a 250 ms interval in production, a loop in tests — so a whole match can be played
  deterministically without timers.
- **Clients are opaque sinks.** `Room` talks to a `Client` interface with a single
  `send`, so the state machine has no idea WebSockets exist.

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

### `packages/client` — the player's view

| File | Responsibility |
| --- | --- |
| `main.ts` | Wire dispatch, the commit/reveal handshake, DOM panels, lobby and match screens |
| `arena.ts` | Pixi scene: seats on a circle, HP arcs, attack bolts on reveal, storm ring |
| `reads.ts` | Derives per-opponent tendencies and tells from the public history |
| `net.ts` | Typed socket with backoff reconnect, re-auth, and an outbox |
| `wallet.ts` | Injected EIP-1193 session, login signature, `createMatch` / `join` / `withdraw` |
| `salts.ts` | Persists the sealed move so a refresh cannot cost the player the round |
| `session.ts` | The browser's session key: load, grant, sign logins and relayed calls |

Three things are worth calling out:

- **The arena renders only published state.** During the commit phase a seat shows *that*
  it has committed, never what it committed to, so the view cannot leak a hidden move.
- **The reveal is automatic.** The player already chose during the commit window; making
  them click a second time would only manufacture no-shows.
- **The reads panel is bookkeeping, not privileged data.** It is computed from the same
  history every spectator receives — it just does the counting the player would otherwise
  do on paper.

### `contracts/` — where the value lives

| Contract | Role |
| --- | --- |
| `ProtocolConfig` | Every governable parameter: fees, seat ranges, stake bounds, windows, payout schedule, rules hash, oracle, attestor set and threshold, per-chain messengers and peers. Owned by a `TimelockController`. |
| `GameEscrow` | The hub. Takes stakes, locks the lobby, requests the seed, accepts a quorum-signed result, credits payouts. |
| `SpokeEscrow` | Spoke-chain gate: forwards a stake plus a join message to the hub, receives bridged payouts. |
| `MatchMarket` | Parimutuel Winner / Top 3 books settled from the escrow's attested ranking. |
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
settle(rounds, historyRoot, ranking, signatures)
  ↓                               quorum verified, ranking must be the seat set
withdraw() / withdrawToChain()    pull-based, always
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

The attestor quorum is trusted for the **ordering** of a result, not for its
**contents**. The signed digest commits to the history root, so anyone holding the
published seed and move log can replay the match locally and prove a signed result was
fabricated. The seed is drawn after the lobby closes, so neither the server nor a player
can choose moves against known rolls. What is *not* yet implemented is an on-chain
challenge that turns that proof into slashing — see `docs/TODO.md`.

### Cross-chain model

Hub-and-spoke. The hub chain holds all escrowed value and all match state; spokes hold
nothing but a forwarding gate. A player on a spoke calls `SpokeEscrow.join`, which sends
the stake and `(matchId, player)` through the messenger; the hub seats them and records
their origin chain. On the way out, `withdrawToChain` pushes the balance back through
the same transport. The `ICrossChainMessenger` interface is modelled on LayerZero v2's
shape but is transport-agnostic, so the adapter can be swapped without touching game
logic.

**Two id spaces.** `GameEscrow.seatOrigin` stores the `srcChainId` the messenger
delivered, which for LayerZero v2 is an *endpoint id* (`40161`), not an EVM chain id
(`11155111`). Everything the player sees is in chain ids, so `ChainBridge` runs every
origin through `normaliseOriginChainId` before it reaches a `Seat`: zero means the hub,
a known endpoint id maps to its chain, and anything else passes through unchanged — a
transport whose id space already is chain ids stays correct, and an unrecognised
endpoint degrades to a number rather than to the wrong chain. Origins are read from
`PlayerJoined`, which already carries them, and cached per seat; the escrow is only read
for a seat that joined before the backfill window.

**Showing it.** The origin rides through `Seat.chainId` into `PublicMatchState`, and the
arena draws it as a coloured pill above each seat — so a lobby that pulled stakes from
four chains looks like it. Lobby rows carry the same chips, aggregated per chain, and
the topbar warns when the connected wallet is on a different chain than the hub, because
otherwise every stake reverts with an error the wallet renders unreadably.

### Testing

- **TypeScript (vitest, 8 files / 71 tests):** engine unit tests, property tests over
  random strategies (termination, unique ranking, HP bounds, determinism, replay
  equivalence, tamper detection), protocol parity vectors, betting math, room lifecycle,
  gateway auth and lobby directory, attestation.
- **Solidity (Foundry, 13 suites / 61 tests):** unit tests per contract and library,
  differential fuzzing of the Yul hashers and the signature recovery loop, and a stateful
  invariant campaign driving `GameEscrow` through random call sequences while asserting
  solvency. A deeper campaign is available with `FOUNDRY_PROFILE=deep`.
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
| `STARTING_CHIPS` | `1000` | Off-chain betting stack |
| `RPC_URL` | — | Hub RPC; without it the server runs practice lobbies only |
| `ESCROW_ADDRESS` | zero | `GameEscrow` to watch and settle against |
| `ATTESTOR_PK` | — | Attestor key; without it results are archived but not submitted |
| `KEEPER_PK` | `ATTESTOR_PK` | Pays for the permissionless `lockMatch` call |
| `DATABASE_URL` | — | Postgres archive; falls back to in-memory |
| `SESSION_DELEGATE` | zero | `SessionKeyDelegate` for 7702 session keys. Needs `RPC_URL` to be verified |
| `AVATAR_COLLECTIONS` | — | `PlayerAvatars` deployments as JSON: `chainId`, `address`, `rpcUrl` per chain |
| `IPFS_GATEWAY` | `https://ipfs.io/ipfs/` | Prefix `ipfs://` is rewritten to when fetching metadata |
| `VITE_WS_URL` | current host `:8787` | Server the browser client connects to |
| `VITE_DEV_KEY` | — | Dev-only burner key so the practice loop needs no wallet extension |

See `.env.example` for the annotated template.

### Commands

```bash
npm run build          # tsc project references
npm run typecheck
npm test               # vitest
npm run sol:build      # forge build
npm run sol:test       # forge test
npm run sol:fuzz       # fuzz suites only
npm run sol:invariant  # invariant suites only
npm run sol:snapshot   # refresh contracts/.gas-snapshot

npm run dev --workspace @lms/server    # ws://localhost:8787
npm run dev --workspace @lms/client    # http://localhost:5173
```
