# Last Man Standing

A cross-chain multiplayer arena. Four to eight players enter a lobby by staking
on-chain, then play a hidden-information elimination game off-chain in real
time. A quorum of attestors signs the result, the hub-chain escrow holds it open
to a veto for a challenge window, and then pays out the escrowed stakes.

Each round every surviving player secretly picks one of three actions:

| Action | Effect |
| --- | --- |
| ⚔️ Attack | Damage a chosen seat, unless they parry or evade |
| 🛡️ Defend | Parry one attacker and riposte them; any others still connect |
| 🏃 Hide | Sometimes dodge attacks, and take less of the closing storm |

Choices are committed as hashes and opened together, so nobody can react to
anybody else. After the reveal the entire round is published, which is the point
of the game: within a few rounds the history tells you who always swings, who
turtles, and who keeps coming after you. The client derives those tells from the
same public history everyone else can see.

## How a staked match runs

```
join        players stake on the hub, or on a spoke chain that bridges the stake over
lockMatch   the seat list is final; randomness is requested (permissionless)
seeded      the oracle delivers the seed; the server opens the room
play        commit → reveal → resolve, round by round, off-chain
settle      a quorum of attestor signatures proposes the ranking and history root
finalize    once the challenge window closes unvetoed, payouts are credited
withdraw    winners pull their balance
```

The signed result commits to every round, so anyone holding the published
history can replay the match with the same pure engine the server runs. Every
player's browser does that when the match ends. Detection is off-chain; the
remedy is on-chain: during the challenge window the guardian Safe may `veto` a
result the replay does not support, refunding every stake. A match that blows
its deadline, or is lost to a server restart, is cancelled and refunded rather
than resumed. There is no on-chain fraud proof or attestor slashing — that is a
deliberate trust level while the rules are still moving.

Around that core:

- **Cross-chain** — hub-and-spoke. All value and match state live on the hub;
  `SpokeEscrow` on other chains only forwards stakes through a
  transport-agnostic messenger (LayerZero adapter).
- **Pay in any token** — `ZapJoin` swaps an ERC-20 for exactly the stake in ETH
  through Uniswap v4.
- **Governance** — every parameter lives in `ProtocolConfig`, owned by a
  timelock that `LmsGovernor` proposes to. Votes come from staked LMS (sLMS),
  which also earns the stakers' share of protocol fees in ETH via `FeeRouter`.
  The Safe keeps a veto and can pause, but never unpause or trap funds.
- **Session keys** — players delegate their EOA to `SessionKeyDelegate` under
  EIP-7702 so reconnecting does not prompt the wallet; the server checks the
  session login with ERC-1271.
- **Avatars** — a cosmetic ERC-721 collection, deployed per chain.
- **Match analyst** — after a match, Gemini writes a post-match analysis that
  streams into the sidebar, with key moments checked against the published
  rounds and clickable to replay. Commentary only: it reads the archive after
  the result is signed and can never touch a match. See
  [Match analyst](#match-analyst) below.

For the full design — game rules, trust model, hashing, Yul optimisations,
cross-chain flow — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). For a
feature-by-feature reference of what each mechanism does and why it is there,
see [docs/FEATURES.md](docs/FEATURES.md). Outstanding work is tracked in
[docs/TODO.md](docs/TODO.md).

## Layout

```
packages/protocol   types, rules, hashing, EIP-712 schema, wire format, contract ABIs
packages/engine     deterministic resolution kernel, match state machine, replay, bots, balance sim
packages/server     WebSocket gateway, authoritative rooms, attestor, chain bridge, fee keeper
packages/client     PixiJS arena, wallet login, history and reads, staking and governance screens
packages/harness    headless bot clients for load and chaos testing
contracts/          Foundry: escrow, spoke, config, governance, oracles, messengers, zap, avatars, 7702 delegate
scripts/            mainnet-fork dev environment, balance sim, load generator
```

Dependencies only ever point one way: the engine uses the protocol; the server
and the client use both (the client replays every finished match with the
engine); the harness uses only the protocol. Nothing depends on the server,
which is what makes a match replayable by a third party.

## Running it locally

```bash
npm install
cp .env.example .env
```

Practice mode needs no chain at all. In two terminals:

```bash
npm run dev --workspace @lms/server     # ws://localhost:8787
npm run dev --workspace @lms/client     # http://localhost:5173
```

Open the client, connect a wallet, and start a practice match against house
bots. Without a wallet extension, set `VITE_DEV_KEY` to any test private key and
the client signs the login nonce with an in-page burner instead.

### On a mainnet fork, in one command

Everything staked — lobbies, settlement, paying in USDC, USDT or DAI through
Uniswap v4 — against real contracts and real liquidity, with no testnet funds
and no `.env`. Needs [Foundry](https://getfoundry.sh) on `PATH`.

```bash
npm run dev:fork
```

It forks mainnet into anvil (chain 31337), deploys the protocol including
`ZapJoin`, funds a test wallet with 1000 of each token, opens two lobbies, and
starts the server and client wired to it. Open http://localhost:5174. Without a
wallet extension the page signs with that funded test wallet on its own; with
one, add the network (`http://127.0.0.1:8545`, chain id 31337) and rerun with
`FORK_PLAYER=<your address>` to fund your own account. Ctrl+C stops everything.

It runs beside a normal `npm run dev` (ports 8788 and 5174, not 8787 and 5173).
To exercise everything that has no UI yet — cancellation, governance,
cross-chain joins, withdrawals — see [docs/SIMULATE.md](docs/SIMULATE.md), which drives the
same fork with `cast`.

`FORK_RPC_URL` swaps the public RPC for your own — worth doing for long
sessions, since a pruned node eventually stops serving the fork block's state.

### With a chain

Set `DEPLOYER_PK` in `.env`. On anything but a local node the script also
requires `SAFE` (the governance multisig) and `ORACLE` (a `ChainlinkVrfAdapter`,
whose owner must then register the escrow with `setConsumer`); the mocks it
falls back to are for chain 31337 only. `MESSENGER` is optional — unset means a
hub with no spokes yet. Then:

```bash
forge script script/Deploy.s.sol --root contracts --rpc-url $RPC_URL --broadcast
```

Point the server at the deployment with `RPC_URL`, `ESCROW_ADDRESS` and
`ATTESTOR_PK`, and restart it. It watches the escrow, locks lobbies once they
fill, opens a room when the randomness oracle seeds the match, submits the
signed result, finalises it once the challenge window closes, and cancels a
match that can no longer finish. The optional features — session keys, token
payment, avatars, the fee keeper, staking and governance screens, a Postgres
archive — each switch on with their own variables; `.env.example` documents
every one.

The server signs and relays with its single `ATTESTOR_PK`; it does not yet
gather signatures from other attestors. The escrow enforces whatever quorum is
configured, so leave `ATTESTORS` at its default (the deployer alone, 1 of 1)
until that collection exists.

The LayerZero and Chainlink VRF adapters have so far only run against local
mocks; see [docs/TODO.md](docs/TODO.md) for what a live two-chain run still
needs.

## Tests

```bash
npm test                    # TypeScript: protocol, engine, server, client — includes chaos seeds
npm run typecheck           # whole monorepo, strict — including every test file
npm run sol:test            # Foundry: unit, fuzz, invariant
npm run sol:snapshot:check  # fail on gas drift against contracts/.gas-snapshot
npm run sim                 # bot matches under the current rules; fails if balance targets slip
```

The TypeScript and Solidity hashing implementations are pinned against each
other by frozen vectors in `packages/protocol/test/parity.test.ts` and
`contracts/test/unit/HashLib.t.sol`, so commitments, the rules hash and the
history root mean the same thing in both languages. Any on-chain verifier
depends on that, so those tests are the ones to watch.

The server is also tested under adversity: a seeded chaos suite plays real bot
clients over a simulated network that drops, stalls and resets connections
([docs/CHAOS_TESTING.md](docs/CHAOS_TESTING.md)), and a load generator opens
a thousand or more real WebSocket players against a running server
([docs/LOAD_TESTING.md](docs/LOAD_TESTING.md)).

## Match analyst

After a match ends, **Analyse match** asks the server for a written analysis:
a short narrative, three to six key moments, and advice for the player's seat.
Gemini reads the match through tools bound to that one archived match
(`get_match`, `get_round`, `get_reads`, `get_player_history`), the narrative
streams over the existing WebSocket, and every key moment's round, seat, kind
and target is checked against the round records before anyone sees it —
moments the history does not support are dropped and counted. Clicking a moment
rewinds the arena and plays that round again, and the player can ask follow-up
questions underneath — treated as untrusted input, with the conversation held
by the server. Design, trust boundaries and
operations: [docs/ANALYST.md](docs/ANALYST.md).

```bash
GEMINI_API_KEY=… npm run dev --workspace @lms/server     # real analyses
ANALYST_DEMO=true npm run dev --workspace @lms/server    # offline demo model: no key, no cost
```

Without either the server runs as before and the panel says analysis is not
available. `.env.example` lists the knobs: model, effort, per-wallet quota,
concurrency, daily budget, deadline, and a token for `/metrics`.

### Evals

`npm run eval:analyst` scores the analyst on 24 reference matches — real games
played by the engine's seeded bots, identical on every run, with lobbies of 4
to 8 seats and half the cases asked by a spectator. Scoring is mechanical:

- **grounding** — verified key moments over all claimed, pooled across cases;
- **decisive round** — the named round is the final round or one that knocked
  out the most players;
- **names winner** — the narrative names the winning seat;
- plus prompt-cache hit rate, cost at list prices and latency.

```bash
npm run eval:analyst -- --demo         # free: checks the harness with the offline demo model
npm run eval:analyst -- --yes          # calls Gemini — spends money (roughly $0.50 for the full suite)
npm run eval:analyst -- --yes --cases=6 --effort=low
```

It is not part of `npm test`, and without `--yes` or `--demo` it only prints
what it would do. Results land in `eval-results/` (ignored by git); the last
line printed is a row for this table:

| run | cases | grounding | decisive round | names winner | prompt cache | cost | mean latency |
| --- | --- | --- | --- | --- | --- | --- | --- |
| _not run yet — `gemini-3.8-flash · medium`_ | | | | | | | |
