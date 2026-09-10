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
packages/server     WebSocket gateway, rooms, chain watcher, attestor, archive
packages/client     PixiJS front end                                     (not built yet)
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
| `hash.ts` | `commitMove`, `hashRound`, `historySeed`, `chainHistory`, `drawBps`, `deriveMatchId`, `hashRules` |
| `eip712.ts` | `MatchResult` typed-data schema and domain |
| `wire.ts` | `ClientMessage` / `ServerMessage` union, login prefix |
| `betting.ts` | `settleEliminationBook` — parimutuel payout for the round book |

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
| `chain.ts` | Watches `MatchStarted`, reads the seat list, opens the matching room |
| `attestor.ts` | Signs the EIP-712 result, packs signatures, submits `settle` |
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

### `contracts/` — where the value lives

| Contract | Role |
| --- | --- |
| `ProtocolConfig` | Every governable parameter: fees, seat ranges, stake bounds, windows, payout schedule, rules hash, oracle, attestor set and threshold, per-chain messengers and peers. Owned by a `TimelockController`. |
| `GameEscrow` | The hub. Takes stakes, locks the lobby, requests the seed, accepts a quorum-signed result, credits payouts. |
| `SpokeEscrow` | Spoke-chain gate: forwards a stake plus a join message to the hub, receives bridged payouts. |
| `MatchMarket` | Parimutuel Winner / Top 3 books settled from the escrow's attested ranking. |
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

### Testing

- **TypeScript (vitest, 8 files / 67 tests):** engine unit tests, property tests over
  random strategies (termination, unique ranking, HP bounds, determinism, replay
  equivalence, tamper detection), protocol parity vectors, betting math, room lifecycle,
  gateway auth, attestation.
- **Solidity (Foundry):** unit tests per contract and library, differential fuzzing of
  the Yul hashers and the signature recovery loop, and a stateful invariant campaign
  driving `GameEscrow` through random call sequences while asserting solvency. A deeper
  campaign is available with `FOUNDRY_PROFILE=deep`.

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
| `DATABASE_URL` | — | Postgres archive; falls back to in-memory |

### Commands

```bash
npm run build          # tsc project references
npm run typecheck
npm test               # vitest
npm run sol:build      # forge build
npm run sol:test       # forge test
npm run sol:fuzz       # fuzz suites only
npm run sol:invariant  # invariant suites only
```
