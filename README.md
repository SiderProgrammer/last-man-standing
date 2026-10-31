# Last Man Standing

A cross-chain multiplayer arena. Four to eight players enter a lobby by staking
on-chain, then play a hidden-information elimination game off-chain in real
time. A quorum of attestors signs the result, the hub-chain escrow holds it open
to a veto for a challenge window, and then pays out the escrowed stakes.

Each round every surviving player secretly picks one of three actions:

| Action | Effect |
| --- | --- |
| ⚔️ Strike | Hit a chosen seat; a hit that lands heals you part of it |
| 🛡️ Guard | Block one striker and reflect a full hit back; any others still connect. Not two rounds running |
| ⚡ Charge | Load a much bigger next Strike, taking more damage while you do. Not two rounds running |

Strike beats Charge, Guard beats Strike, Charge beats Guard. There is no storm: a
table that stops fighting takes a growing stall penalty instead.

Choices are committed as hashes and opened together, so nobody can react to
anybody else. After the reveal the entire round is published, which is the point
of the game: within a few rounds the history tells you who always swings, who
guards whenever it can, who is charged, and who keeps coming after you. The client derives those tells from the
same public history everyone else can see.

## How a staked match runs

```
join        players stake on the hub, or on a spoke chain that bridges the stake over
lockMatch   the seat list is final; randomness is requested (permissionless)
seeded      the oracle delivers the seed; the server opens the room
play        signed commit → signed reveal → resolve, round by round, off-chain
archive     the server stores the full transcript, and only then settles
settle      a quorum of attestor signatures proposes the ranking, history root and transcript hash
dispute     any seated player may object during the challenge window (+48 h)
finalize    once the window closes unvetoed, payouts are credited
withdraw    winners pull their balance
```

## Trust model

**Verifiable, not enforced.** One operator runs the server and, today, holds
the attestor key; a separate guardian can veto. The chain does not check a
single move. What it does is make the operator's every claim checkable:

- Your wallet grants your browser a key once; that key signs every commit and
  reveal. The server can drop a move, but not make one up or change one.
- The server signs a receipt for every commit it takes. The round's rolls come
  from the seed and the full set of commitments, so they are fixed before
  anyone reveals, and dropping a reveal cannot re-roll them.
- Before it settles, the server archives the transcript: every round, every
  signature, every grant. `settle` carries its hash, the attestors sign it, and
  the escrow stores it. A transcript that cannot be archived is never settled;
  the match is aborted and refunded instead.
- When the result is proposed, your browser reads the escrow, fetches the
  transcript by that hash, checks every signature and your own moves and
  receipts, and replays it to the stored root. If it does not hold up, one
  click disputes it: the payout waits 48 hours, and the evidence is saved for
  the guardian.

What you still trust, stated plainly:

- **The guardian decides disputes.** It can veto (refund everyone) or dismiss.
  A guardian that does neither lets the result pay out when the 48 hours end:
  that is the liveness assumption. A compromised guardian can void honest
  results, but never redirect a stake.
- **The operator can refund any live match.** `abortMatch` needs only the
  attestor quorum, which is the operator. It cannot take a stake, only send
  every stake back.
- **The attestors are not yet independent.** A quorum is one key today, so its
  signature says what the operator says. The transcript is what makes that
  checkable.
- **The server can censor.** It can refuse a commit before receipting it, or
  drop a reveal. A receipted commit that goes missing, or a sent reveal counted
  as missing, is provable; a commit refused outright is not.
- **Held moves are not secret.** "Reveal for me if I disconnect" hands the
  server your move at commit time, the one case where it knows a move before
  the reveal.

There is no on-chain fraud proof or attestor slashing; that is a deliberate
trust level while the rules are still moving. A match that blows its deadline,
or is lost to a server restart, is cancelled and refunded rather than resumed.

Around that core:

- **Cross-chain** — hub-and-spoke over Across. All value and match state live on
  the hub; `SpokeRouter` on other chains bridges a stake to the hub's
  `BridgeJoinReceiver`, which seats the player or credits them. A player with no gas
  on the hub can have their balance bridged home by signing for it.
- **Pay in any token** — `ZapJoin` swaps an ERC-20 for exactly the stake in ETH
  through Uniswap v4.
- **Governance** — every parameter lives in `ProtocolConfig`, owned by a
  timelock that `LmsGovernor` proposes to. Votes come from staked LMS (sLMS),
  which also earns the stakers' share of protocol fees in ETH via `FeeRouter`.
  Until a date fixed in `MultisigPhase`, a Safe can also propose and veto;
  a separate guardian key can pause for up to a week, but never trap funds.
  See [Roles](#roles).
- **Play-mining** — half the LMS supply goes to players over four years, each
  week shared out by the fees they paid, entirely on-chain through
  `RewardsDistributor`. Each week's reward vests over six months in
  `RewardVesting` and votes only once released and staked. Two caps: 10,000
  LMS per ETH of fees (the real bound on farming) and a per-wallet cap per
  week (which stops one wallet taking a quiet week, not sybils).
- **LMS fee discount** — a seat may pay up to half its fee in LMS at a
  governance-set rate (`joinWithLms`). The LMS is held with the stake, burned
  when the match settles and refunded if it does not.
- **Session grants** — a player's wallet signs one EIP-712 `SessionGrant`
  (SIWE-shaped: origin, chain, expiry) naming a key the browser keeps for a
  day. The key signs the login nonce and every commit and reveal, so
  reconnects need no prompt and every move is provably the player's. The
  grant alone cannot stake or spend. Contract wallets' grants are checked with
  ERC-1271. The key is kept in IndexedDB, sealed under a non-extractable
  WebCrypto key, and the page ships a strict Content-Security-Policy.
- **One-click play** — a burner or embedded wallet delegates to
  `SessionKeyDelegate` (EIP-7702) once and grants its session key a capped
  session: `join` and `withdrawFor` on the escrow only, 0.05 ETH a join and
  0.25 ETH in all. Joins and collecting winnings then need no prompt, and the
  server pays the gas, up to a daily quota per wallet. See [Wallets](#wallets).
- **Avatars** — a cosmetic ERC-721 collection, deployed per chain and owned by
  its timelock. Minting is free and limited to one per wallet, which stops one
  wallet taking the supply but not someone with many wallets.
- **Match analyst** — after a match, Gemini writes a post-match analysis for
  the sidebar, with key moments checked against the published
  rounds and clickable to replay. Commentary only: it reads the archive after
  the result is signed and can never touch a match. See
  [Match analyst](#match-analyst) below.

For the full design — game rules, trust model, hashing,
cross-chain flow — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). For a
feature-by-feature reference of what each mechanism does and why it is there,
see [docs/FEATURES.md](docs/FEATURES.md). Outstanding work is tracked in
[docs/TODO.md](docs/TODO.md).

## Wallets

Every wallet logs in the same way: it signs one session grant, and the browser's
session key signs logins and moves from then on. What differs is whether joins
and collecting winnings can be one click.

| Wallet | Logins and moves | Joins on Base | Collecting winnings | Joins from a spoke |
| --- | --- | --- | --- | --- |
| Burner (`VITE_DEV_KEY`, dev builds only) | Session key, no prompt | One click, relayed | One click, relayed | Its own transaction on the spoke |
| Privy embedded wallet | Session key, no prompt | One click, relayed, once the Privy check passes (see below) | One click, relayed, likewise | Its own transaction on the spoke |
| Injected (MetaMask, Rabby) | Session key, no prompt | Its own transaction | Its own transaction | Its own transaction on the spoke |
| Coinbase Smart Wallet | Session key; the grant is checked through ERC-1271 | Its own transaction | Its own transaction | Its own transaction on the spoke |

One-click play needs a wallet that can sign an EIP-7702 authorization for *our*
delegate. An injected wallet will not be asked for one, and a smart wallet
already has code of its own. Privy is not wired into the client yet: the plan
is to adopt it only if its embedded wallet signs that authorization on Base
Sepolia, and fall back to Turnkey, or to the normal flow, if it does not
(FIX_PLAN 5.1). The contracts are the same either way. `npm run
check:one-click` runs the whole one-click path on a local Prague anvil, with a
plain local account standing in for the embedded wallet.

The server relays only when `SESSION_RELAYER_PK` is set, and refuses a relayed
call that is outside the session's scope, comes from an account delegated
anywhere else, would revert, or is over the wallet's `RELAY_QUOTA_PER_DAY`. The
client then falls back to the wallet's own transaction.

ERC-4337 (`validateUserOp`), so that smart wallets get one-click play too, is a
stretch goal and not built.

## Roles

Every key and contract with authority, and where it ends. Safe, guardian and
treasury are three separate addresses; `Deploy.s.sol` refuses to finish if any
two coincide.

| Role | Held by | Can | Cannot |
| --- | --- | --- | --- |
| Timelock | `TimelockController`, 3-day delay | Owns `ProtocolConfig`, `StakedLms`, `FeeRouter`, `RewardsDistributor`, `PlayerAvatars` and the VRF adapter. Every change waits out the delay, which is longer than a whole match. | Act without a queued proposal. |
| Treasury | The timelock | Receives the non-staker share of fees through `FeeRouter`. | Spend without a proposal. |
| Governor | `LmsGovernor`, voted by staked LMS | Proposes to the timelock. | Vote with unstaked or still-vesting LMS. |
| Safe | A 2-of-3 multisig. On testnet all three keys are the owner's, on separate devices; **mainnet needs independent signers.** | Through `MultisigPhase`, until its fixed `phaseEnd`: proposes to the timelock and cancels anything queued (the veto). Owns the VRF subscription. | Hold a timelock role itself; schedule a call on the timelock, or a `transferOwnership`/`renounceOwnership` anywhere; do any of it after `phaseEnd`, when anyone can `retire()` the phase. |
| Liquidity reserve | `LiquidityReserve`, holding the 5% liquidity share | The Safe or the timelock sends LMS to a recipient the timelock has approved (the pool). | Stake, delegate or vote; pay the vault, the Safe or itself, even by a proposal. |
| Guardian | A hardware-wallet EOA | Pauses the escrow at once, for 7 days at most, then waits 7 days before it can pause again; vetoes a proposed result, which refunds every stake; dismisses a dispute it finds unfounded. | Redirect a stake, or keep a pause going: only governance extends one. |
| Operator | Runs the game server; holds the attestor key and the receipt key | Plays each match; signs its result and proposes it with the transcript hash; aborts a live match it cannot finish, refunding every seat; refuses or drops moves. | Make up or alter a move (each is signed by its player's granted key); re-roll a round by dropping a reveal; get a result paid whose transcript it withholds, once a player disputes it and the guardian acts. |
| Seated player | Their own wallet | Disputes a proposed result once, during the challenge window, holding the payout back 48 h for the guardian. | Hold a result back longer than one extension, or at all once the window has closed. |
| Session key | The player's browser, sealed in IndexedDB | Signs logins and moves until its grant expires, a day after it was signed. With one-click play on: joins lobbies and collects winnings for the player, at most 0.05 ETH a join and 0.25 ETH in all. | Call anything but `join` and `withdrawFor` on the escrow; withdraw to anyone but the player; outlive its grant or seven days; speak for the wallet through ERC-1271. |
| Session relayer | The server's `SESSION_RELAYER_PK`, holding only gas money | Submits the joins and withdrawals players' session keys signed, paying the gas, up to `RELAY_QUOTA_PER_DAY` calls per wallet per day. | Change a call, send one the key did not sign, replay one, or exceed a session's caps. |

This is a testnet project. Real-money play would also need a gambling licence,
which is out of scope.

## Layout

```
packages/protocol   types, rules, hashing, EIP-712 schema, wire format, contract ABIs
packages/engine     deterministic resolution kernel, match state machine, replay, bots, balance sim
packages/server     WebSocket gateway, authoritative rooms, attestor, chain bridge, fee keeper
packages/client     PixiJS arena, wallet login, history and reads, staking and governance screens
packages/harness    headless bot clients for load and chaos testing
contracts/          Foundry: escrow, config, governance, oracles, bridge router and receiver, zap, avatars, 7702 delegate
scripts/            mainnet-fork dev environment, balance sim, load generator
```

Dependencies only ever point one way: the engine uses the protocol; the server
and the client use both (the client replays every finished match with the
engine); the harness uses only the protocol. Nothing depends on the server,
which is what makes a match replayable by a third party.

## Running it locally

```bash
git clone --recurse-submodules https://github.com/SiderProgrammer/gambling-project
npm install
cp .env.example .env
```

The Solidity dependencies (`forge-std`, OpenZeppelin) are git submodules under
`contracts/lib/`. In a clone made without `--recurse-submodules`, run
`git submodule update --init` before `forge build`.

The server's `dev` and `start` scripts read this root `.env`; variables already set
in the shell win. Practice mode needs no chain at all. In two terminals:

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

The hub runs on Base (Base Sepolia for testnet). Set `DEPLOYER_PK` in `.env`.
On anything but a local node the script also requires `SAFE` (the governance
multisig) and `VRF_SUBSCRIPTION_ID`, a Chainlink VRF v2.5 subscription the Safe
owns and funds with ETH. The script deploys the VRF adapter, makes the escrow
its consumer and hands it to the timelock; the Safe then adds the adapter to
the subscription. The mocks it falls back to are for chain 31337 only. It also
deploys the `BridgeJoinReceiver` that takes cross-chain joins, on the Across
SpokePool `contracts/config/across.json` lists for the chain. Then:

```bash
forge script script/Deploy.s.sol --root contracts --rpc-url $RPC_URL --broadcast
```

On Base mainnet the config also reads Chainlink's sequencer uptime feed, so a
result cannot be finalised during an outage or within an hour after it.

Point the server at the deployment with `RPC_URL`, `ESCROW_ADDRESS` and
`ATTESTOR_PK`, and restart it. It watches the escrow, locks lobbies once they
fill, opens a room when the randomness oracle seeds the match, submits the
signed result, finalises it once the challenge window closes, and cancels a
match that can no longer finish. The optional features — one-click play, token
payment, avatars, the fee keeper, staking and governance screens, a Postgres
archive — each switch on with their own variables; `.env.example` documents
every one.

The server signs and relays with its single `ATTESTOR_PK`; it does not yet
gather signatures from other attestors. The escrow enforces whatever quorum is
configured, so leave `ATTESTORS` at its default (the deployer alone, 1 of 1)
until that collection exists.

The VRF adapter has a fork test against the Base Sepolia coordinator
(`BASE_SEPOLIA_RPC_URL=… forge test --match-path test/fork/*`), and the Across
router and receiver against the real SpokePools on Base, Arbitrum, Optimism and
Ethereum (`BASE_RPC_URL`, `ARBITRUM_RPC_URL`, `OPTIMISM_RPC_URL`, `MAINNET_RPC_URL`).
No real Across testnet deposit has been made yet; [docs/ACROSS.md](docs/ACROSS.md)
says how. `npm run dev:fork` runs a hub and a spoke together, with mock Across pools
and a local relayer between them; open the client with `?chain=spoke` to stake from
the spoke.
[docs/TESTNET.md](docs/TESTNET.md) walks through the same thing on two public
testnets, and [docs/TODO.md](docs/TODO.md) lists what is still open.

## Tests

```bash
npm test                    # TypeScript: protocol, engine, server, client — includes chaos seeds
npm run typecheck           # whole monorepo, strict — including every test file
npm run sol:test            # Foundry: unit, fuzz, invariant
npm run sol:snapshot:check  # fail on gas drift against contracts/.gas-snapshot
npm run abis                # regenerate packages/protocol/src/chain/abis.ts after a contract change
npm run sim                 # bot matches under the current rules; fails if balance targets slip
npm run check:one-click     # one-click play end to end on a local Prague anvil (needs foundry)
```

CI (`.github/workflows/ci.yml`) runs all of the above, plus
`forge fmt --check`, a coverage report and Slither. Slither fails only on findings
missing from `contracts/slither-baseline.json`, where every accepted finding has a
triage note. To add one, run Slither with `--json contracts/slither.json`, then
`node scripts/slither-baseline.mjs contracts/slither.json contracts/slither-baseline.json --update`,
and write the note.

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
(`get_match`, `get_round`, `get_reads`, `get_player_history`), and every key
moment's round, seat, kind and target is checked against the round records
before anyone sees it — moments the history does not support are dropped and
counted. Clicking a moment rewinds the arena and plays that round again.
Design, trust boundaries and limits: [docs/ANALYST.md](docs/ANALYST.md).

```bash
GEMINI_API_KEY=… npm run dev --workspace @lms/server
```

Without a key the server runs as before and the panel says analysis is not
available. The analyst keeps to the Gemini free tier by default — 5 requests a
minute and 20 a day, enforced on the server. It sends the whole match in one
call, so that is about twenty analyses a day; set `ANALYST_RPM` and
`ANALYST_RPD` to your project's limits once billing is on. `.env.example` lists the other knobs: model, effort, per-wallet quota,
concurrency, daily budget and deadline.
