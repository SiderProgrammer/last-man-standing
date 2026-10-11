# Last Man Standing

A cross-chain multiplayer arena. Four to eight players enter a lobby by staking
on-chain, then play a hidden-information elimination game off-chain in real
time. The result is signed by an attestor quorum and settled back on the hub
chain, which pays out the escrowed stakes.

Each round every surviving player secretly picks one of three actions:

| Action | Effect |
| --- | --- |
| ⚔️ Attack | Damage a chosen seat, unless they parry or evade |
| 🛡️ Defend | Block incoming attacks and riposte the attacker |
| 🏃 Hide | Likely to dodge attacks, but exposed to the closing storm |

Choices are committed as hashes and opened together, so nobody can react to
anybody else. After the reveal the entire round is published, which is the point
of the game: within a few rounds the history tells you who always swings, who
turtles, and who keeps coming after you. The client derives those tells from the
same public history everyone else can see.

For the full design — trust model, hashing rules, Yul optimisations, cross-chain
flow — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). For a feature-by-feature
reference covering what each mechanism does and why it is there — cross-chain,
governance, the randomness oracle, EIP-7702 session keys, the Yul libraries —
see [docs/FEATURES.md](docs/FEATURES.md). Whether each of those features earns
its place is argued in [docs/PROTOCOL_REVIEW.md](docs/PROTOCOL_REVIEW.md), and
work still outstanding is tracked in [docs/TODO.md](docs/TODO.md).

## Layout

```
packages/protocol   types, hashing, EIP-712 schema, wire format, escrow/avatar/session ABIs
packages/engine     deterministic match state machine and bot strategies
packages/server     WebSocket gateway, authoritative rooms, attestor, chain bridge
packages/client     PixiJS arena, wallet login, history and reads panels
contracts/          Foundry project: escrow, oracles, messengers, avatars, 7702 delegate
```

Dependencies only ever point left: the engine may use the protocol, the server
may use both, and the client may use the protocol. Nothing depends on the
server, which is what makes a match replayable by a third party.

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
cross-chain joins, withdrawals — see
[docs/SIMULATE.md](docs/SIMULATE.md), which drives the same fork with `cast`.

`FORK_RPC_URL` swaps the public RPC for your own — worth doing for long
sessions, since a pruned node eventually stops serving the fork block's state.

### With a chain

Deploy the contracts, point the server at them, and staked lobbies appear in the
client:

```bash
forge script script/Deploy.s.sol --root contracts --rpc-url $RPC_URL --broadcast
```

Then set `RPC_URL`, `ESCROW_ADDRESS` and `ATTESTOR_PK` in `.env` and restart the
server. It will watch the escrow, lock lobbies once they fill, open a room when
the randomness oracle seeds the match, and relay the signed result when the
match ends.

## Tests

```bash
npm test              # TypeScript: protocol, engine, server
npm run typecheck     # whole monorepo, strict — including every test file
npm run sol:test      # Foundry: unit, fuzz, invariant
npm run sol:snapshot  # gas snapshot
```

The TypeScript and Solidity hashing implementations are pinned against each
other by frozen vectors in `packages/protocol/test/parity.test.ts` and
`contracts/test/unit/HashLib.t.sol`. If a commit hash ever diverges between the
two, players could not open commitments on-chain, so those tests are the ones to
watch.
