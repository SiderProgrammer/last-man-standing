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

Alongside the match runs a play-money book on *who falls this round*, and an
on-chain parimutuel market on the final Winner and Top 3.

For the full design — trust model, hashing rules, Yul optimisations, cross-chain
flow — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Work still outstanding
is tracked in [docs/TODO.md](docs/TODO.md).

## Layout

```
packages/protocol   types, hashing, EIP-712 schema, wire format, escrow/avatar/session ABIs
packages/engine     deterministic match state machine and bot strategies
packages/server     WebSocket gateway, authoritative rooms, attestor, chain bridge
packages/client     PixiJS arena, wallet login, history and reads panels
contracts/          Foundry project: escrow, markets, oracles, messengers, avatars, 7702 delegate
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
npm run typecheck     # whole monorepo, strict
npm run sol:test      # Foundry: unit, fuzz, invariant
npm run sol:snapshot  # gas snapshot
```

The TypeScript and Solidity hashing implementations are pinned against each
other by frozen vectors in `packages/protocol/test/parity.test.ts` and
`contracts/test/unit/HashLib.t.sol`. If a commit hash ever diverges between the
two, players could not open commitments on-chain, so those tests are the ones to
watch.
